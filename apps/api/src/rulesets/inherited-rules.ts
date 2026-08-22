import { and, eq, isNull, or } from 'drizzle-orm';
import { type Database, brandRulePacks, rulePacks, ruleTemplates } from '@brandlens/db';
import type { CompilableRuleRow } from './compile';

/* ==========================================================================
 * Which shipped rules a brand inherits, and how they become compilable rows.
 *
 * A brand with zero rules of its own should still be checkable — legibility,
 * logo craft and channel conformance are true whoever the brand is. So every
 * brand inherits the baseline packs, and can opt into the regulated ones.
 * ========================================================================== */

export interface InheritedRule extends CompilableRuleRow {
  origin: 'inherited';
  packKey: string;
  /** The pack's version, for display: "Accessibility pack v3". */
  packVersion: number;
  templateId: string;
  /**
   * The TEMPLATE's version, which is what a fork records as lineage.
   *
   * Not the pack's: pack version bumps when anything in the pack changes, so
   * recording it would mark every fork in the pack as drifted the moment one
   * unrelated template moved. Per-template is the only version that answers
   * "has the standard I copied actually changed?"
   */
  templateVersion: number;
}

/**
 * Resolves the packs a brand is subject to.
 *
 * The rule is: a pack applies when the brand has an explicit `enabled = true`
 * row, OR the pack is on by default and the brand has no row disabling it.
 * Absence of a row deliberately means "take the default" rather than "off" —
 * that is what lets a brand created ten seconds ago inherit every baseline
 * pack without a single row being written for it.
 */
export async function loadInheritedRules(
  tx: Database,
  orgId: string,
  brandId: string,
): Promise<InheritedRule[]> {
  const packs = await tx
    .select({
      id: rulePacks.id,
      key: rulePacks.key,
      version: rulePacks.version,
      category: rulePacks.category,
      enabledByDefault: rulePacks.enabledByDefault,
    })
    .from(rulePacks)
    .where(
      and(
        eq(rulePacks.isActive, true),
        // Shipped packs plus this tenant's own. RLS would hide another
        // tenant's rows anyway; the predicate makes the intent explicit.
        or(isNull(rulePacks.orgId), eq(rulePacks.orgId, orgId)),
      ),
    );

  if (packs.length === 0) return [];

  const decisions = await tx
    .select({ packId: brandRulePacks.packId, enabled: brandRulePacks.enabled })
    .from(brandRulePacks)
    .where(and(eq(brandRulePacks.orgId, orgId), eq(brandRulePacks.brandId, brandId)));

  const decisionByPack = new Map(decisions.map((d) => [d.packId, d.enabled]));
  const applicable = packs.filter((p) => decisionByPack.get(p.id) ?? p.enabledByDefault);
  if (applicable.length === 0) return [];

  const packById = new Map(applicable.map((p) => [p.id, p]));
  const templates = await tx
    .select()
    .from(ruleTemplates)
    .where(eq(ruleTemplates.isActive, true));

  const out: InheritedRule[] = [];
  for (const template of templates) {
    const pack = packById.get(template.packId);
    if (!pack) continue;

    out.push({
      // The template's own id. A compiled rule must be traceable to the row
      // that produced it, and minting a synthetic id here would break the
      // link from a finding back to the standard that caused it.
      id: template.id,
      key: template.key,
      version: template.version,
      statement: template.statement,
      rationale: template.rationale,
      dimension: template.dimension,
      tier: template.tier,
      severity: template.severity,
      weight: template.weight,
      scope: template.scope ?? {},
      check: template.check,
      rubric: template.rubric ?? null,
      // Always `transfer`: an inherited rule is an external standard imported
      // into this brand, never something induced from the brand's own work.
      provenance: 'transfer',
      citation: template.citation ?? null,
      status: template.defaultStatus,
      optimizedPromptHash: null,
      // Calibration is per-tenant and accrues on the tenant's own rules. An
      // inherited rule has no tenant history yet, so it never auto-routes on
      // the strength of somebody else's reviewers.
      calibration: null,
      origin: 'inherited',
      packKey: pack.key,
      packVersion: pack.version,
      templateId: template.id,
      templateVersion: template.version,
      createdAt: template.createdAt,
    });
  }

  return out;
}

/**
 * Merges inherited rows beneath a brand's own.
 *
 * Both lists go into the compile together and `resolveByKey` picks the winner
 * per key, with `origin` breaking the tie that specificity cannot. Filtering
 * the loser out HERE instead would be wrong: the compiled snapshot is meant to
 * record everything that was considered, and a rule the brand overrode is
 * exactly the sort of thing an auditor asks to see.
 */
export function mergeRuleRows(
  brandRows: readonly CompilableRuleRow[],
  inherited: readonly InheritedRule[],
): CompilableRuleRow[] {
  return [...brandRows.map((r) => ({ ...r, origin: r.origin ?? ('brand' as const) })), ...inherited];
}

/** Keys a brand has overridden — used by the console to show what is shadowed. */
export function overriddenKeys(
  brandRows: readonly CompilableRuleRow[],
  inherited: readonly InheritedRule[],
): string[] {
  const inheritedKeys = new Set(inherited.map((r) => r.key));
  return [...new Set(brandRows.filter((r) => inheritedKeys.has(r.key)).map((r) => r.key))].sort();
}
