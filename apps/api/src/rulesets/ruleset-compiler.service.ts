import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { brands, rules, rulesets } from '@brandlens/db';
import type { RuleDefinition } from '@brandlens/contracts';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../platform/outbox.service';
import {
  DEFAULT_SCORING,
  compileRows,
  resolveForContext,
  toRuleDefinitions,
  type CompilableRuleRow,
  type CompiledRule,
  type CompiledRuleset,
  type ScoringConfig,
} from './compile';
import type { ScopeContext } from './specificity';
import { loadInheritedRules, mergeRuleRows } from './inherited-rules';

export { DEFAULT_SCORING, compileRows } from './compile';
export type { CompiledRule, CompiledRuleset, ScoringConfig } from './compile';

@Injectable()
export class RulesetCompilerService {
  private readonly logger = new Logger(RulesetCompilerService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Compiles the brand's ACTIVE rules into a frozen snapshot.
   *
   * `proposed` rules are excluded by construction. A rule the customer has not
   * activated must never influence a verdict — that separation is what makes
   * the audit trail defensible when the rules were machine-extracted.
   */
  async compile(orgId: string, brandId: string, scoring?: Partial<ScoringConfig>): Promise<CompiledRuleset> {
    const { rows, inherited } = await this.repo.runAs(orgId, undefined, async (tx) => {
      const rows = await tx
        .select()
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.status, 'active')))
        .orderBy(rules.key, desc(rules.version));

      // Shipped packs come in beneath the brand's own rules, so a brand with
      // nothing authored yet still compiles to something worth checking
      // against. `origin` decides the winner where both carry an empty scope.
      const inherited = (await loadInheritedRules(tx, orgId, brandId)).filter((r) => r.status === 'active');
      return { rows, inherited };
    });

    const merged = mergeRuleRows(rows as unknown as CompilableRuleRow[], inherited);
    return compileRows(brandId, merged, scoring);
  }

  /**
   * Resolves the compiled set for one concrete context (market/channel/…).
   *
   * Compiling stores every active rule across the whole lattice; resolution
   * picks the winner per key for the coordinates of the asset in hand. Doing
   * it in this order means a ruleset is published once and reused for every
   * market, rather than publishing one snapshot per combination.
   */
  resolveForContext(compiled: CompiledRuleset, ctx: ScopeContext): CompiledRule[] {
    return resolveForContext(compiled, ctx);
  }

  /** Compile + resolve straight from the database, for the `effective` route. */
  async effective(
    orgId: string,
    brandId: string,
    ctx: ScopeContext,
  ): Promise<{ hash: string; context: ScopeContext; rules: CompiledRule[]; scoringConfig: ScoringConfig }> {
    const active = await this.activeRuleset(orgId, brandId);
    const compiled = active ?? (await this.compile(orgId, brandId));
    return {
      hash: compiled.hash,
      context: ctx,
      rules: this.resolveForContext(compiled, ctx),
      scoringConfig: compiled.scoringConfig,
    };
  }

  /** Reads the brand's published ruleset back into its compiled form. */
  async activeRuleset(orgId: string, brandId: string): Promise<CompiledRuleset | null> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ activeRulesetId: brands.activeRulesetId })
        .from(brands)
        .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId)))
        .limit(1),
    );
    const rulesetId = rows[0]?.activeRulesetId;
    if (!rulesetId) return null;
    return this.loadRuleset(orgId, rulesetId);
  }

  async loadRuleset(orgId: string, rulesetId: string): Promise<CompiledRuleset | null> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(rulesets).where(eq(rulesets.id, rulesetId)).limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    const compiled = row.compiled as unknown as { rules?: CompiledRule[]; scoringConfig?: ScoringConfig };
    return {
      brandId: row.brandId,
      rules: compiled.rules ?? [],
      scoringConfig: { ...DEFAULT_SCORING, ...(compiled.scoringConfig ?? {}) },
      ruleCount: row.ruleCount,
      hash: row.hash,
    };
  }

  async listRulesets(orgId: string, brandId: string) {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          id: rulesets.id,
          version: rulesets.version,
          hash: rulesets.hash,
          label: rulesets.label,
          ruleCount: rulesets.ruleCount,
          scoringConfig: rulesets.scoringConfig,
          publishedAt: rulesets.publishedAt,
          publishedByUserId: rulesets.publishedByUserId,
        })
        .from(rulesets)
        .where(eq(rulesets.brandId, brandId))
        .orderBy(desc(rulesets.version)),
    );
  }

  /**
   * Publishes a snapshot and points the brand at it.
   *
   * The row insert, the brand update and the `ruleset.published` outbox event
   * all happen in ONE transaction: the moment `brands.activeRulesetId` moves,
   * every new check run is priced against the new hash, and a webhook consumer
   * must not be told about a ruleset that a rollback removed.
   *
   * Republishing an identical snapshot is idempotent — same rules produce the
   * same hash, and the unique index on (brand, hash) makes that a no-op rather
   * than a duplicate version. That matters because "publish" is a button a
   * nervous brand manager clicks repeatedly.
   */
  async publish(
    orgId: string,
    brandId: string,
    userId: string | undefined,
    input: { label?: string; scoringConfig?: Partial<ScoringConfig> } = {},
  ): Promise<{ id: string; version: number; hash: string; ruleCount: number; reused: boolean }> {
    const compiled = await this.compile(orgId, brandId, input.scoringConfig);

    return this.repo.runAs(orgId, userId, async (tx) => {
      const existing = await tx
        .select({ id: rulesets.id, version: rulesets.version })
        .from(rulesets)
        .where(and(eq(rulesets.brandId, brandId), eq(rulesets.hash, compiled.hash)))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(brands)
          .set({ activeRulesetId: existing[0].id, updatedAt: new Date() })
          .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId)));
        return {
          id: existing[0].id,
          version: existing[0].version,
          hash: compiled.hash,
          ruleCount: compiled.ruleCount,
          reused: true,
        };
      }

      const [{ max }] = await tx
        .select({ max: sql<number>`coalesce(max(${rulesets.version}), 0)::int` })
        .from(rulesets)
        .where(eq(rulesets.brandId, brandId));

      const version = (max ?? 0) + 1;
      const [row] = await tx
        .insert(rulesets)
        .values({
          orgId,
          brandId,
          version,
          hash: compiled.hash,
          label: input.label ?? `v${version}`,
          compiled: { rules: compiled.rules, scoringConfig: compiled.scoringConfig } as Record<string, unknown>,
          ruleCount: compiled.ruleCount,
          scoringConfig: compiled.scoringConfig as unknown as Record<string, unknown>,
          publishedByUserId: userId ?? null,
        })
        .returning({ id: rulesets.id });

      await tx
        .update(brands)
        .set({ activeRulesetId: row.id, updatedAt: new Date() })
        .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId)));

      await this.audit.recordIn(tx, {
        action: 'ruleset.publish',
        entityType: 'ruleset',
        entityId: row.id,
        payload: { brandId, version, hash: compiled.hash, ruleCount: compiled.ruleCount },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'ruleset.published',
        aggregateType: 'ruleset',
        aggregateId: row.id,
        payload: { brandId, rulesetId: row.id, version, hash: compiled.hash, ruleCount: compiled.ruleCount },
        idempotencyKey: `ruleset.published:${row.id}`,
      });

      this.logger.log(`published ruleset v${version} (${compiled.ruleCount} rules) for brand ${brandId}`);
      return { id: row.id, version, hash: compiled.hash, ruleCount: compiled.ruleCount, reused: false };
    });
  }

  toRuleDefinitions(compiled: readonly CompiledRule[]): RuleDefinition[] {
    return toRuleDefinitions(compiled);
  }
}
