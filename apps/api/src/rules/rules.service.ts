import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BulkRuleDecisionInput, CreateRuleInput, UpdateRuleInput } from '@brandlens/contracts';
import { type Database, rules } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../brands/brands.service';
import { OutboxService } from '../platform/outbox.service';
import { computeSpecificity } from '../rulesets/specificity';

export type RuleRow = typeof rules.$inferSelect;

export interface ListRulesFilter {
  status?: string;
  dimension?: string;
  tier?: string;
  provenance?: string;
  search?: string;
}

@Injectable()
export class RulesService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(orgId: string, brandId: string, filter: ListRulesFilter = {}): Promise<RuleRow[]> {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) => {
      const conditions = [eq(rules.brandId, brandId)];
      if (filter.status) conditions.push(eq(rules.status, filter.status as RuleRow['status']));
      if (filter.dimension) conditions.push(eq(rules.dimension, filter.dimension as RuleRow['dimension']));
      if (filter.tier) conditions.push(eq(rules.tier, filter.tier as RuleRow['tier']));
      if (filter.provenance) conditions.push(eq(rules.provenance, filter.provenance as RuleRow['provenance']));
      if (filter.search) conditions.push(sql`${rules.statement} ILIKE ${'%' + filter.search + '%'}`);
      return tx
        .select()
        .from(rules)
        .where(and(...conditions))
        .orderBy(asc(rules.dimension), asc(rules.key), desc(rules.version))
        .limit(2000);
    });
  }

  async get(orgId: string, ruleId: string): Promise<RuleRow> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(rules).where(eq(rules.id, ruleId)).limit(1),
    );
    if (!rows[0]) throw new NotFoundException('Rule not found');
    return rows[0];
  }

  /** Every version ever recorded for a key — the "why did this change" view. */
  async history(orgId: string, brandId: string, key: string): Promise<RuleRow[]> {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx
        .select()
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.key, key)))
        .orderBy(desc(rules.version)),
    );
  }

  async create(
    orgId: string,
    brandId: string,
    userId: string | undefined,
    input: z.infer<typeof CreateRuleInput>,
  ): Promise<RuleRow> {
    await this.brands.requireBrand(orgId, brandId);

    return this.repo.run(async (tx) => {
      const [{ max }] = await tx
        .select({ max: sql<number>`coalesce(max(${rules.version}), 0)::int` })
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.key, input.key)));

      const version = (max ?? 0) + 1;
      const activating = input.status === 'active';

      const [row] = await tx
        .insert(rules)
        .values({
          orgId,
          brandId,
          key: input.key,
          version,
          statement: input.statement,
          rationale: input.rationale ?? null,
          dimension: input.dimension,
          tier: input.tier,
          severity: input.severity,
          weight: input.weight,
          scope: input.scope,
          specificity: computeSpecificity(input.scope),
          check: { fn: input.check.fn, params: input.check.params ?? {} },
          rubric: (input.rubric ?? null) as Record<string, unknown> | null,
          provenance: input.provenance,
          citation: input.citation ?? null,
          support: input.support ?? null,
          status: input.status,
          createdByUserId: userId ?? null,
          activatedByUserId: activating ? (userId ?? null) : null,
          activatedAt: activating ? new Date() : null,
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: activating ? 'rule.create_active' : 'rule.propose',
        entityType: 'rule',
        entityId: row.id,
        payload: { brandId, key: row.key, version, dimension: row.dimension, status: row.status },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: activating ? 'rule.activated' : 'rule.proposed',
        aggregateType: 'rule',
        aggregateId: row.id,
        payload: { brandId, ruleId: row.id, key: row.key, version, status: row.status },
        idempotencyKey: `rule.${row.status}:${row.id}`,
      });

      return row;
    });
  }

  /**
   * Editing an ACTIVE rule never mutates it in place.
   *
   * Decision traces reference (ruleKey, ruleVersion) and are immutable. If an
   * active rule could be edited under them, every historical verdict would
   * silently start citing rule text that did not exist when the verdict was
   * made — which destroys the audit trail. So an edit to an active rule creates
   * version+1 and deprecates the old row; the new version starts as `proposed`
   * unless the caller explicitly re-activates it.
   *
   * Editing a `proposed` or `rejected` rule mutates in place: nothing has been
   * decided against it, so there is nothing to preserve.
   */
  async update(
    orgId: string,
    brandId: string,
    ruleId: string,
    userId: string | undefined,
    input: z.infer<typeof UpdateRuleInput>,
  ): Promise<RuleRow> {
    await this.brands.requireBrand(orgId, brandId);
    const current = await this.get(orgId, ruleId);
    if (current.brandId !== brandId) throw new NotFoundException('Rule not found on this brand');

    if (current.status !== 'active') {
      return this.repo.run(async (tx) => {
        const [row] = await tx
          .update(rules)
          .set({ ...patchFrom(input, current), updatedAt: new Date() })
          .where(eq(rules.id, ruleId))
          .returning();
        await this.audit.recordIn(tx, {
          action: 'rule.update',
          entityType: 'rule',
          entityId: ruleId,
          payload: { brandId, key: row.key, version: row.version, fields: Object.keys(input) },
        });
        return row;
      });
    }

    return this.repo.run(async (tx) => {
      const patch = patchFrom(input, current);
      const nextStatus = input.status === 'active' ? 'active' : 'proposed';

      const [row] = await tx
        .insert(rules)
        .values({
          orgId,
          brandId,
          key: current.key,
          version: current.version + 1,
          statement: patch.statement ?? current.statement,
          rationale: patch.rationale ?? current.rationale,
          dimension: patch.dimension ?? current.dimension,
          tier: patch.tier ?? current.tier,
          severity: patch.severity ?? current.severity,
          weight: patch.weight ?? current.weight,
          scope: patch.scope ?? current.scope,
          specificity: patch.specificity ?? current.specificity,
          check: patch.check ?? current.check,
          rubric: patch.rubric ?? current.rubric,
          provenance: patch.provenance ?? current.provenance,
          citation: patch.citation ?? current.citation,
          support: patch.support ?? current.support,
          status: nextStatus,
          calibration: current.calibration,
          optimizedPrompt: current.optimizedPrompt,
          optimizedPromptHash: current.optimizedPromptHash,
          createdByUserId: userId ?? null,
          activatedByUserId: nextStatus === 'active' ? (userId ?? null) : null,
          activatedAt: nextStatus === 'active' ? new Date() : null,
        })
        .returning();

      await tx
        .update(rules)
        .set({ status: 'deprecated', effectiveTo: new Date(), updatedAt: new Date() })
        .where(eq(rules.id, ruleId));

      await this.audit.recordIn(tx, {
        action: 'rule.version',
        entityType: 'rule',
        entityId: row.id,
        payload: {
          brandId,
          key: current.key,
          fromVersion: current.version,
          toVersion: row.version,
          deprecatedRuleId: ruleId,
          newStatus: nextStatus,
        },
      });

      return row;
    });
  }

  /**
   * Bulk activate / reject / deprecate — the onboarding moment.
   *
   * Activation is an explicit HUMAN act and is always audited with the actor.
   * Machine-extracted rules arrive as `proposed` and stay there until someone
   * takes responsibility for them; that separation is what a regulator is
   * actually buying.
   */
  async bulkDecision(
    orgId: string,
    brandId: string,
    userId: string | undefined,
    input: z.infer<typeof BulkRuleDecisionInput>,
  ): Promise<{ action: string; updated: number; ruleIds: string[] }> {
    await this.brands.requireBrand(orgId, brandId);
    if (input.action === 'activate' && !userId) {
      throw new BadRequestException('Rule activation requires a human session; API keys cannot activate rules');
    }

    const status = input.action === 'activate' ? 'active' : input.action === 'reject' ? 'rejected' : 'deprecated';

    return this.repo.run(async (tx) => {
      const updated = await tx
        .update(rules)
        .set({
          status,
          activatedByUserId: status === 'active' ? (userId ?? null) : null,
          activatedAt: status === 'active' ? new Date() : null,
          effectiveFrom: status === 'active' ? new Date() : undefined,
          effectiveTo: status === 'deprecated' ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(rules.brandId, brandId), inArray(rules.id, input.ruleIds)))
        .returning({ id: rules.id, key: rules.key, version: rules.version });

      await this.audit.recordIn(tx, {
        action: `rule.bulk_${input.action}`,
        entityType: 'rule',
        entityId: null,
        payload: {
          brandId,
          action: input.action,
          note: input.note,
          count: updated.length,
          rules: updated.map((r) => `${r.key}@${r.version}`),
        },
      });

      if (status === 'active') {
        for (const r of updated) {
          await this.outbox.emitIn(tx, {
            orgId,
            type: 'rule.activated',
            aggregateType: 'rule',
            aggregateId: r.id,
            payload: { brandId, ruleId: r.id, key: r.key, version: r.version, activatedByUserId: userId ?? null },
            idempotencyKey: `rule.activated:${r.id}`,
          });
        }
      }

      return { action: input.action, updated: updated.length, ruleIds: updated.map((r) => r.id) };
    });
  }

  /**
   * Bulk insert of machine-proposed rules (document extraction, induction).
   * ALWAYS lands as `proposed`, regardless of what the caller asked for.
   */
  async createProposedBatch(
    tx: Database,
    orgId: string,
    brandId: string,
    proposals: Array<z.infer<typeof CreateRuleInput>>,
    provenance: 'deductive' | 'inductive' | 'transfer',
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const p of proposals) {
      const [{ max }] = await tx
        .select({ max: sql<number>`coalesce(max(${rules.version}), 0)::int` })
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.key, p.key)));

      const [row] = await tx
        .insert(rules)
        .values({
          orgId,
          brandId,
          key: p.key,
          version: (max ?? 0) + 1,
          statement: p.statement,
          rationale: p.rationale ?? null,
          dimension: p.dimension,
          tier: p.tier,
          severity: p.severity,
          weight: p.weight,
          scope: p.scope,
          specificity: computeSpecificity(p.scope),
          check: { fn: p.check.fn, params: p.check.params ?? {} },
          rubric: (p.rubric ?? null) as Record<string, unknown> | null,
          provenance,
          citation: p.citation ?? null,
          support: p.support ?? null,
          // Not negotiable. Machines propose; humans activate.
          status: 'proposed',
        })
        .returning({ id: rules.id });
      ids.push(row.id);
    }
    return ids;
  }
}

/** Builds a partial update from the DTO, recomputing derived columns. */
function patchFrom(input: z.infer<typeof UpdateRuleInput>, current: RuleRow): Partial<typeof rules.$inferInsert> {
  const patch: Partial<typeof rules.$inferInsert> = {};
  if (input.statement !== undefined) patch.statement = input.statement;
  if (input.rationale !== undefined) patch.rationale = input.rationale;
  if (input.dimension !== undefined) patch.dimension = input.dimension;
  if (input.tier !== undefined) patch.tier = input.tier;
  if (input.severity !== undefined) patch.severity = input.severity;
  if (input.weight !== undefined) patch.weight = input.weight;
  if (input.scope !== undefined) {
    patch.scope = input.scope;
    patch.specificity = computeSpecificity(input.scope);
  }
  if (input.check !== undefined) patch.check = { fn: input.check.fn, params: input.check.params ?? {} };
  if (input.rubric !== undefined) patch.rubric = input.rubric as Record<string, unknown>;
  if (input.provenance !== undefined) patch.provenance = input.provenance;
  if (input.citation !== undefined) patch.citation = input.citation;
  if (input.support !== undefined) patch.support = input.support;
  if (input.status !== undefined && current.status !== 'active') patch.status = input.status;
  return patch;
}
