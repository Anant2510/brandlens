import { rulePacks, ruleTemplates } from '../../schema/index.js';
import type { Database } from '../../client.js';
import { seedId } from '../lib/ids.js';
import { upsertRows } from '../lib/upsert.js';
import { SEED_RULE_PACKS } from '../data/rule-packs.js';
import { assertRulePacksExecutable } from '../data/validate.js';

/* ==========================================================================
 * The shipped rule packs — platform data, not tenant data.
 *
 * `org_id IS NULL` following the `channel_specs` convention already in this
 * schema: every tenant can read these rows, no tenant can write them. Which
 * means this step needs an RLS bypass, exactly as the channel spec registry
 * does, and it runs once for the installation rather than once per customer.
 *
 * Why the templates are not copied into each brand: a copy is frozen at the
 * moment it is made. Correct a threshold next month and every brand created
 * before then keeps the old one, silently, for as long as the product exists.
 * Inheritance resolves at compile time instead — so a fix reaches everybody on
 * their next compile, while `ruleset_hash` still freezes the MERGED result and
 * a completed check run stays reproducible for audit.
 * ========================================================================== */

export interface RulePackSeedResult {
  packs: number;
  /** Templates in packs a brand gets without asking. */
  inheritedTemplates: number;
  /** Templates in opt-in packs — present, inherited by nobody yet. */
  optInTemplates: number;
  enabledByDefault: number;
  dayOneRules: number;
}

export async function seedRulePacks(tx: Database): Promise<RulePackSeedResult> {
  // Before any row: does every template's `check.params` name keys the
  // analyzer actually reads, and does its declared `needs` match the ontology
  // that analyzer really touches? These rows reach every tenant, so a wrong
  // one is wrong everywhere at once.
  assertRulePacksExecutable();

  const packRows = SEED_RULE_PACKS.map((pack) => ({
    id: seedId('rulepack', pack.key),
    orgId: null,
    key: pack.key,
    name: pack.name,
    description: pack.description,
    category: pack.category,
    version: 1,
    enabledByDefault: pack.enabledByDefault,
    jurisdictions: pack.jurisdictions ?? [],
    authority: pack.authority ?? null,
    docsUrl: pack.docsUrl ?? null,
    isActive: true,
  }));
  await upsertRows(tx, rulePacks, packRows);

  const templateRows = SEED_RULE_PACKS.flatMap((pack) =>
    pack.templates.map((t) => ({
      id: seedId('ruletemplate', pack.key, t.key),
      orgId: null,
      packId: seedId('rulepack', pack.key),
      key: t.key,
      version: 1,
      statement: t.statement,
      rationale: t.rationale,
      dimension: t.dimension,
      tier: t.tier,
      severity: t.severity,
      weight: t.weight,
      scope: t.scope ?? {},
      check: { fn: t.check.fn, params: t.check.params ?? {} },
      rubric: t.rubric ?? null,
      citation: t.citation ?? null,
      defaultStatus: t.defaultStatus ?? 'active',
      guidance: t.guidance,
      needs: t.needs ?? [],
      isActive: true,
    })),
  );
  await upsertRows(tx, ruleTemplates, templateRows);

  const enabled = SEED_RULE_PACKS.filter((p) => p.enabledByDefault);
  const optIn = SEED_RULE_PACKS.filter((p) => !p.enabledByDefault);
  return {
    packs: packRows.length,
    inheritedTemplates: enabled.reduce((n, p) => n + p.templates.length, 0),
    optInTemplates: optIn.reduce((n, p) => n + p.templates.length, 0),
    enabledByDefault: enabled.length,
    // The number that matters on day one: rules that produce a verdict on a
    // brand with an empty ontology. Everything else waits for data.
    dayOneRules: enabled
      .flatMap((p) => p.templates)
      .filter((t) => (t.needs ?? []).length === 0 && (t.defaultStatus ?? 'active') === 'active').length,
  };
}

/* --------------------------------------------------------------------------
 * The rows a brand inherits, in the shape the compile expects.
 *
 * The seed publishes a ruleset at the end of the ontology step, and that
 * ruleset has to be the one the API would produce on the next republish — the
 * hash IS the cache key, so a seeded hash that disagrees with the API's would
 * invalidate every seeded decision trace the first time somebody edits a rule.
 * Before packs existed the seed only had to mirror a field list. Now it has to
 * mirror the merge too, which is why `compile.spec.ts` in the API compares the
 * two implementations against a shared fixture rather than trusting a comment.
 *
 * Only `active` templates from packs that are on by default are here.
 * A `proposed` template is a suggestion waiting for a human, and a compiled
 * ruleset carries what gets enforced.
 * ------------------------------------------------------------------------ */
export interface InheritedCompileRow {
  id: string;
  key: string;
  version: number;
  statement: string;
  rationale: string | null;
  dimension: string;
  tier: string;
  severity: string;
  weight: number;
  scope: Record<string, unknown>;
  check: { fn: string; params?: Record<string, unknown> };
  rubric: Record<string, unknown> | null;
  provenance: string;
  citation: Record<string, unknown> | null;
  status: string;
  optimizedPromptHash: null;
  calibration: null;
  origin: 'inherited';
  packKey: string;
  createdAt: Date;
}

export function inheritedCompileRows(createdAt: Date): InheritedCompileRow[] {
  return SEED_RULE_PACKS.filter((pack) => pack.enabledByDefault).flatMap((pack) =>
    pack.templates
      .filter((t) => (t.defaultStatus ?? 'active') === 'active')
      .map((t) => ({
        // The template's own id: a finding has to be traceable back to the
        // standard that produced it, and minting a synthetic id here would
        // break that link the moment anybody asked where a rule came from.
        id: seedId('ruletemplate', pack.key, t.key),
        key: t.key,
        version: 1,
        statement: t.statement,
        rationale: t.rationale,
        dimension: t.dimension,
        tier: t.tier,
        severity: t.severity,
        weight: t.weight,
        scope: t.scope ?? {},
        check: { fn: t.check.fn, params: t.check.params ?? {} },
        rubric: t.rubric ?? null,
        // Always `transfer`: an inherited rule is an external standard imported
        // into this brand, never something induced from the brand's own work.
        provenance: 'transfer',
        citation: t.citation ?? null,
        status: 'active',
        optimizedPromptHash: null,
        // Calibration accrues on a tenant's own rules from its own reviewers.
        // An inherited rule has no history here, so it never auto-routes on
        // the strength of somebody else's decisions.
        calibration: null,
        origin: 'inherited' as const,
        packKey: pack.key,
        createdAt,
      })),
  );
}
