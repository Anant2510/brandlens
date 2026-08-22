import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ForkRuleTemplateInput, SetRulePackEnabledInput, explainCheck } from '@brandlens/contracts';
import {
  type Database,
  brandRulePacks,
  claims,
  designTokens,
  disclaimers,
  forbiddenFonts,
  imageStyleProfiles,
  lexiconTerms,
  logoVariants,
  rulePacks,
  ruleTemplates,
  rules,
  typeStyles,
  voiceAttributes,
} from '@brandlens/db';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/** The shape every brand-scoped ontology table shares, for the count sweep. */
type PgTableWithBrand = PgTable & { brandId: PgColumn };
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../brands/brands.service';
import { OutboxService } from '../platform/outbox.service';
import { computeSpecificity } from '../rulesets/specificity';
import { loadInheritedRules } from '../rulesets/inherited-rules';

/* ==========================================================================
 * Rule packs, from a brand's point of view.
 *
 * A brand inherits the baseline packs without a row being written for it, so
 * most of this service answers questions about rows that do not exist: which
 * packs apply, which of their rules this brand has taken over, and which
 * standards have moved on since it did.
 *
 * The one destructive act here is disabling a baseline pack, and it is the
 * only one that demands a written reason.
 * ========================================================================== */

export interface RulePackSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string;
  version: number;
  authority: string | null;
  docsUrl: string | null;
  jurisdictions: string[];
  /** Whether the pack applies to this brand right now. */
  enabled: boolean;
  /** True when a brand row decided it; false when it is taking the default. */
  decided: boolean;
  enabledByDefault: boolean;
  reason: string | null;
  templateCount: number;
  /** Templates that would compile into the ruleset — the rest await a human. */
  activeTemplateCount: number;
  /** Templates this brand has forked and now owns. */
  forkedCount: number;
  /** Templates shadowed by a brand rule with the same key, forked or not. */
  overriddenCount: number;
}

export interface InheritedRuleSummary {
  templateId: string;
  templateVersion: number;
  packKey: string;
  packName: string;
  packVersion: number;
  key: string;
  statement: string;
  rationale: string | null;
  dimension: string;
  tier: string;
  severity: string;
  weight: number;
  check: { fn: string; params?: Record<string, unknown> };
  status: string;
  guidance: string | null;
  citation: Record<string, unknown> | null;
  /** Ontology this rule needs before it can produce a verdict. */
  needs: string[];
  /**
   * The subset of `needs` this brand has not populated.
   *
   * A rule waiting on missing ontology returns `not_applicable`, never `fail`
   * — so on screen it is indistinguishable from a rule that passed. This field
   * is what lets the console say "waiting on your logo files" instead, which
   * is the difference between an honest empty state and a green screen that
   * means nothing.
   */
  missingOntology: string[];
  /** The brand rule shadowing this one, if any. */
  overriddenBy: { ruleId: string; version: number; status: string; forked: boolean } | null;
  /**
   * Set when this brand forked the template and the template has since moved.
   * The whole reason lineage is recorded: a fork with no drift signal rots
   * quietly while the standard it copied gets corrected underneath it.
   */
  drift: { forkedFromVersion: number; currentVersion: number } | null;
}

@Injectable()
export class RulePacksService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /* ------------------------------------------------------------------ *
   * Listing
   * ------------------------------------------------------------------ */
  async list(orgId: string, brandId: string): Promise<RulePackSummary[]> {
    await this.brands.requireBrand(orgId, brandId);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const packs = await tx
        .select()
        .from(rulePacks)
        .where(and(eq(rulePacks.isActive, true), or(isNull(rulePacks.orgId), eq(rulePacks.orgId, orgId))))
        .orderBy(rulePacks.category, rulePacks.key);

      const templates = await tx.select().from(ruleTemplates).where(eq(ruleTemplates.isActive, true));
      const decisions = await tx
        .select()
        .from(brandRulePacks)
        .where(and(eq(brandRulePacks.orgId, orgId), eq(brandRulePacks.brandId, brandId)));

      const brandRules = await tx
        .select({
          key: rules.key,
          forkedFromTemplateId: rules.forkedFromTemplateId,
        })
        .from(rules)
        .where(eq(rules.brandId, brandId));

      const decisionByPack = new Map(decisions.map((d) => [d.packId, d]));
      const brandKeys = new Set(brandRules.map((r) => r.key));
      const forkedTemplates = new Set(
        brandRules.map((r) => r.forkedFromTemplateId).filter((id): id is string => Boolean(id)),
      );

      return packs.map((pack) => {
        const mine = templates.filter((t) => t.packId === pack.id);
        const decision = decisionByPack.get(pack.id);
        return {
          id: pack.id,
          key: pack.key,
          name: pack.name,
          description: pack.description,
          category: pack.category,
          version: pack.version,
          authority: pack.authority,
          docsUrl: pack.docsUrl,
          jurisdictions: pack.jurisdictions ?? [],
          ...packEnablement(decision ?? null, pack.enabledByDefault),
          enabledByDefault: pack.enabledByDefault,
          reason: decision?.reason ?? null,
          templateCount: mine.length,
          activeTemplateCount: mine.filter((t) => t.defaultStatus === 'active').length,
          forkedCount: mine.filter((t) => forkedTemplates.has(t.id)).length,
          // A brand rule can shadow a template by key without ever having been
          // forked from it — somebody may simply have written their own
          // `logo.clearspace`. Both count as overridden, because both mean the
          // baseline is not what gets enforced.
          overriddenCount: mine.filter((t) => brandKeys.has(t.key)).length,
        };
      });
    });
  }

  /** The rules this brand inherits, with what shadows them and what has moved. */
  async listInherited(orgId: string, brandId: string): Promise<InheritedRuleSummary[]> {
    await this.brands.requireBrand(orgId, brandId);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const inherited = await loadInheritedRules(tx, orgId, brandId);
      if (inherited.length === 0) return [];

      const packNames = new Map(
        (await tx.select({ key: rulePacks.key, name: rulePacks.name }).from(rulePacks)).map((p) => [p.key, p.name]),
      );
      const templateById = new Map(
        (
          await tx
            .select({ id: ruleTemplates.id, guidance: ruleTemplates.guidance, needs: ruleTemplates.needs })
            .from(ruleTemplates)
        ).map((t) => [t.id, t]),
      );
      const populated = await populatedOntology(tx, brandId);

      // Latest version per key: an override is the brand's CURRENT rule, and
      // an older version of it is not shadowing anything.
      const brandRows = await tx
        .select()
        .from(rules)
        .where(eq(rules.brandId, brandId))
        .orderBy(rules.key, desc(rules.version));

      const latestByKey = new Map<string, (typeof brandRows)[number]>();
      for (const row of brandRows) if (!latestByKey.has(row.key)) latestByKey.set(row.key, row);

      return inherited.map((rule) => {
        const shadow = latestByKey.get(rule.key);
        const template = templateById.get(rule.templateId);
        return {
          templateId: rule.templateId,
          templateVersion: rule.templateVersion,
          packKey: rule.packKey,
          packName: packNames.get(rule.packKey) ?? rule.packKey,
          packVersion: rule.packVersion,
          key: rule.key,
          statement: rule.statement,
          rationale: rule.rationale,
          dimension: rule.dimension,
          tier: rule.tier,
          severity: rule.severity,
          weight: rule.weight,
          check: rule.check ?? { fn: 'noop', params: {} },
          status: rule.status,
          guidance: template?.guidance ?? null,
          citation: rule.citation,
          needs: template?.needs ?? [],
          missingOntology: (template?.needs ?? []).filter((attr) => !populated.has(attr)),
          overriddenBy: overrideOf(shadow ?? null, rule.templateId),
          drift: driftOf(shadow ?? null, rule.templateId, rule.templateVersion),
        };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Enablement
   * ------------------------------------------------------------------ */
  async setEnabled(
    orgId: string,
    brandId: string,
    packKey: string,
    userId: string | undefined,
    input: z.infer<typeof SetRulePackEnabledInput>,
  ): Promise<RulePackSummary> {
    await this.brands.requireBrand(orgId, brandId);

    await this.repo.runAs(orgId, userId, async (tx) => {
      const [pack] = await tx
        .select()
        .from(rulePacks)
        .where(and(eq(rulePacks.key, packKey), or(isNull(rulePacks.orgId), eq(rulePacks.orgId, orgId))));
      if (!pack) throw new NotFoundException(`No rule pack '${packKey}'`);

      // Turning off accessibility or legal checks is a decision that should
      // survive the person who made it. Enabling needs no justification;
      // switching a shipped default OFF does.
      if (!input.enabled && pack.enabledByDefault && !input.reason?.trim()) {
        throw new BadRequestException(
          `Disabling '${pack.name}' needs a reason. It is on by default for every brand, and a pack switched ` +
            'off without an explanation is indistinguishable later from one nobody noticed.',
        );
      }

      await tx
        .insert(brandRulePacks)
        .values({
          orgId,
          brandId,
          packId: pack.id,
          enabled: input.enabled,
          reason: input.reason?.trim() || null,
          decidedByUserId: userId ?? null,
        })
        .onConflictDoUpdate({
          target: [brandRulePacks.brandId, brandRulePacks.packId],
          set: {
            enabled: input.enabled,
            reason: input.reason?.trim() || null,
            decidedByUserId: userId ?? null,
            updatedAt: new Date(),
          },
        });

      await this.audit.recordIn(tx, {
        action: input.enabled ? 'rule_pack.enabled' : 'rule_pack.disabled',
        entityType: 'rule_pack',
        entityId: pack.id,
        payload: { brandId, packKey, category: pack.category, reason: input.reason ?? null },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        // The compiled ruleset changes the moment a pack goes on or off, so
        // anything caching a ruleset hash needs to hear about it.
        type: input.enabled ? 'rule_pack.enabled' : 'rule_pack.disabled',
        aggregateType: 'rule_pack',
        aggregateId: pack.id,
        payload: { brandId, packKey, enabled: input.enabled },
      });
    });

    const summary = (await this.list(orgId, brandId)).find((p) => p.key === packKey);
    if (!summary) throw new NotFoundException(`No rule pack '${packKey}'`);
    return summary;
  }

  /* ------------------------------------------------------------------ *
   * Fork
   * ------------------------------------------------------------------ */
  /**
   * Copies one shipped template into the brand as a rule it owns.
   *
   * THE INVARIANT: forking never changes what is enforced.
   *
   * The fork lands at the template's own default status. Forking an active
   * standard produces an active, byte-identical brand rule — the same check
   * keeps running, the brand simply owns it now. Forking a proposed template
   * produces a proposed rule, because it was not enforcing and taking
   * ownership is not the same as agreeing to it.
   *
   * That matters more than it looks. A `proposed` fork is not compiled, so
   * the inherited template would go on applying underneath it: a fork that
   * landed proposed while its template was active would create a rule the
   * console shows as the brand's, while a different one does the work.
   */
  async fork(
    orgId: string,
    brandId: string,
    userId: string | undefined,
    input: z.infer<typeof ForkRuleTemplateInput>,
  ) {
    await this.brands.requireBrand(orgId, brandId);

    return this.repo.runAs(orgId, userId, async (tx) => {
      const [template] = await tx
        .select()
        .from(ruleTemplates)
        .where(and(eq(ruleTemplates.id, input.templateId), eq(ruleTemplates.isActive, true)));
      if (!template) throw new NotFoundException(`No rule template ${input.templateId}`);

      const [pack] = await tx.select().from(rulePacks).where(eq(rulePacks.id, template.packId));
      if (!pack) throw new NotFoundException('The template’s pack no longer exists');
      if (pack.orgId !== null && pack.orgId !== orgId) {
        throw new NotFoundException(`No rule template ${input.templateId}`);
      }

      const [existing] = await tx
        .select({ id: rules.id, version: rules.version })
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.key, template.key)))
        .orderBy(desc(rules.version))
        .limit(1);
      if (existing) {
        // Not an upsert: a second fork would silently discard whatever the
        // brand had already changed about its copy.
        throw new ConflictException(
          `This brand already has its own '${template.key}' (v${existing.version}). Edit that rule instead of ` +
            'forking the baseline again.',
        );
      }

      const merged = {
        statement: input.edits?.statement ?? template.statement,
        rationale: input.edits?.rationale ?? template.rationale,
        severity: input.edits?.severity ?? template.severity,
        weight: input.edits?.weight ?? template.weight,
        scope: (input.edits?.scope ?? template.scope ?? {}) as Record<string, unknown>,
        check: input.edits?.check ?? template.check,
        rubric: (input.edits?.rubric === undefined ? template.rubric : input.edits.rubric) as Record<
          string,
          unknown
        > | null,
      };

      // The edits arrive from a person, so a dead parameter is a mistake worth
      // correcting rather than silently stripping — `explainCheck` names the
      // key they probably meant. `sanitiseCheck` is the wrong tool here: its
      // message is written for machine-generated proposals and says the key
      // "has been dropped", which would not be true of a request we refuse.
      const problem = explainCheck(merged.check, template.key);
      if (problem) throw new BadRequestException(problem);

      const [row] = await tx
        .insert(rules)
        .values({
          orgId,
          brandId,
          key: template.key,
          version: 1,
          statement: merged.statement,
          rationale: merged.rationale,
          dimension: template.dimension,
          tier: template.tier,
          severity: merged.severity,
          weight: merged.weight,
          scope: merged.scope,
          specificity: computeSpecificity(merged.scope),
          check: merged.check,
          rubric: merged.rubric,
          // Still `transfer` at the moment of forking: its origin is an
          // external standard, whoever now owns the row.
          provenance: 'transfer',
          citation: forkCitation(template.citation, pack.key, pack.name, Boolean(input.edits)),
          support: null,
          // See the invariant above: the template's status, not `proposed`.
          status: forkStatus(template.defaultStatus),
          // The TEMPLATE's version, not the pack's — see InheritedRule.
          forkedFromTemplateId: template.id,
          forkedFromVersion: template.version,
          createdByUserId: userId ?? null,
          activatedByUserId: forkStatus(template.defaultStatus) === 'active' ? (userId ?? null) : null,
          activatedAt: forkStatus(template.defaultStatus) === 'active' ? new Date() : null,
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: 'rule.forked',
        entityType: 'rule',
        entityId: row.id,
        payload: {
          brandId,
          key: template.key,
          packKey: pack.key,
          templateId: template.id,
          templateVersion: template.version,
          edited: Boolean(input.edits),
          status: row.status,
        },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'rule.forked',
        aggregateType: 'rule',
        aggregateId: row.id,
        payload: { brandId, key: template.key, packKey: pack.key, status: row.status },
      });

      return row;
    });
  }

  /** How many brands in the org have taken over each shipped rule. */
  async forkStats(orgId: string): Promise<Array<{ templateId: string; forks: number }>> {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ templateId: rules.forkedFromTemplateId, forks: sql<number>`count(*)::int` })
        .from(rules)
        .where(and(eq(rules.orgId, orgId), sql`${rules.forkedFromTemplateId} is not null`))
        .groupBy(rules.forkedFromTemplateId),
    ) as Promise<Array<{ templateId: string; forks: number }>>;
  }
}

/**
 * Which ontology attributes this brand has actually populated.
 *
 * The names are the engine's — `ctx.brand.color_tokens`, `ctx.brand.lexicon` —
 * because that is what the analyzer manifest records and what a template's
 * `needs` is asserted against. Mapping them to tables here, in one place, is
 * what keeps the console's "waiting on…" honest: an attribute the engine reads
 * from design tokens is only satisfied by design tokens, not by having some
 * ontology.
 *
 * `channel_spec` is always satisfied — the registry is platform data every
 * tenant can read, so no brand is ever waiting on it.
 */
async function populatedOntology(tx: Database, brandId: string): Promise<Set<string>> {
  const [counts] = await tx
    .select({
      colorTokens: sql<number>`count(*) filter (where ${designTokens.type} = 'color' and ${designTokens.hex} is not null)::int`,
      forbiddenColors: sql<number>`count(*) filter (where ${designTokens.role} = 'forbidden' and ${designTokens.hex} is not null)::int`,
    })
    .from(designTokens)
    .where(eq(designTokens.brandId, brandId));

  const present = new Set<string>(['channel_spec']);
  if ((counts?.colorTokens ?? 0) > 0) present.add('color_tokens');
  if ((counts?.forbiddenColors ?? 0) > 0) present.add('forbidden_colors');

  const tables: Array<[string, PgTableWithBrand]> = [
    ['logo_variants', logoVariants],
    ['type_styles', typeStyles],
    ['forbidden_fonts', forbiddenFonts],
    ['voice_attributes', voiceAttributes],
    ['lexicon', lexiconTerms],
    ['claims', claims],
    ['disclaimers', disclaimers],
    ['image_style_profile', imageStyleProfiles],
  ];

  for (const [attribute, table] of tables) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.brandId, brandId));
    if ((row?.n ?? 0) > 0) present.add(attribute);
  }

  return present;
}

/* ==========================================================================
 * The decisions, extracted from the database work.
 *
 * Everything below is a pure function of values the service has already
 * fetched. That is deliberate: these four are where the product rules live —
 * what "enabled" means when no row exists, whether forking changes what is
 * enforced, when a fork counts as drifted — and a rule you can only exercise
 * by standing up Postgres is a rule that ends up untested.
 * ========================================================================== */

export interface PackDecisionRow {
  enabled: boolean;
}

/**
 * Absence of a row means "take the pack's default", not "off".
 *
 * This is what lets a brand created ten seconds ago inherit every baseline
 * pack with nothing written for it, while still letting a brand turn one off
 * explicitly — and `decided` is how the console tells those two apart, so it
 * can show "on (default)" differently from "on (you turned this on)".
 */
export function packEnablement(
  decision: PackDecisionRow | null,
  enabledByDefault: boolean,
): { enabled: boolean; decided: boolean } {
  return { enabled: decision?.enabled ?? enabledByDefault, decided: decision !== null };
}

/**
 * The status a fork lands at. THE INVARIANT: forking never changes what is
 * enforced.
 *
 * A `proposed` rule is not compiled, so if a fork of an ACTIVE template landed
 * proposed, the inherited template would keep applying underneath it — the
 * console would show the brand's rule while a different one did the work.
 * Conversely a fork of a proposed template must not land active: taking
 * ownership of a suggestion is not the same as agreeing to it.
 */
export function forkStatus(templateDefaultStatus: string): 'active' | 'proposed' {
  return templateDefaultStatus === 'active' ? 'active' : 'proposed';
}

export interface ShadowRow {
  id: string;
  version: number;
  status: string;
  forkedFromTemplateId: string | null;
  forkedFromVersion: number | null;
}

/**
 * The brand rule shadowing an inherited one, if any.
 *
 * A brand rule can shadow a template by key without ever having been forked
 * from it — somebody may simply have written their own `logo.clearspace`. Both
 * mean the baseline is not what gets enforced, so both are reported; `forked`
 * is what distinguishes a deliberate override from a collision.
 */
export function overrideOf(
  shadow: ShadowRow | null,
  templateId: string,
): { ruleId: string; version: number; status: string; forked: boolean } | null {
  if (!shadow) return null;
  return {
    ruleId: shadow.id,
    version: shadow.version,
    status: shadow.status,
    forked: shadow.forkedFromTemplateId === templateId,
  };
}

/**
 * Has the standard moved since this brand forked it?
 *
 * Only meaningful for a rule forked from THIS template: a brand rule that
 * merely collides on key was never a copy of anything and cannot have drifted
 * from it. Compared against the template's version rather than the pack's,
 * because a pack version bumps when any of its templates changes and would
 * mark every fork in the pack as stale the moment one unrelated rule moved.
 */
export function driftOf(
  shadow: ShadowRow | null,
  templateId: string,
  templateVersion: number,
): { forkedFromVersion: number; currentVersion: number } | null {
  if (!shadow || shadow.forkedFromTemplateId !== templateId) return null;
  if (shadow.forkedFromVersion === null || shadow.forkedFromVersion === templateVersion) return null;
  return { forkedFromVersion: shadow.forkedFromVersion, currentVersion: templateVersion };
}

/**
 * The citation a forked rule carries.
 *
 * The template's citation names a standard — "WCAG 2.2 SC 1.4.3". Copying it
 * onto a rule whose threshold the brand may then change would make the rule
 * claim the standard says something it does not. So the citation is kept, and
 * annotated with the fact that it is a copy: a reviewer reading it later sees
 * both where it came from and that its numbers are now the brand's.
 */
export function forkCitation(
  citation: Record<string, unknown> | null,
  packKey: string,
  packName: string,
  edited: boolean,
): Record<string, unknown> {
  return {
    ...(citation ?? {}),
    forkedFrom: { packKey, packName },
    note: edited
      ? `Forked from the ${packName} pack and edited by this brand. The thresholds below are the brand’s, ` +
        'not the standard’s.'
      : `Forked from the ${packName} pack. Identical to the shipped standard until this brand changes it.`,
  };
}
