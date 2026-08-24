import type { ScopeSelector } from '@brandlens/contracts';

/* ==========================================================================
 * The scope lattice.
 *
 *   global → sub-brand → market → channel → asset type → campaign
 *
 * Resolution is most-specific-wins with CSS-like specificity: each axis has a
 * weight, and the weights are chosen so that a constraint on a more specific
 * axis outranks ANY combination of constraints on less specific axes. That is
 * what "CSS-like" actually buys — one id beats a hundred classes — and it is
 * why the weights are powers of ten rather than 1/2/3/4/5.
 *
 * The alternative (summing equal weights) produces genuinely wrong answers: a
 * campaign-specific co-branding exemption would lose to a rule that merely
 * names two markets and a channel, and the exemption is the entire reason the
 * campaign axis exists.
 * ========================================================================== */

export const SPECIFICITY_WEIGHTS = {
  subBrands: 1,
  markets: 10,
  channels: 100,
  assetTypes: 1_000,
  campaigns: 10_000,
} as const;

export type ScopeAxis = keyof typeof SPECIFICITY_WEIGHTS;

export const SCOPE_AXES: ScopeAxis[] = ['subBrands', 'markets', 'channels', 'assetTypes', 'campaigns'];

/** A resolution context: the concrete coordinates of the asset being checked. */
export interface ScopeContext {
  subBrand?: string | null;
  market?: string | null;
  channel?: string | null;
  assetType?: string | null;
  campaign?: string | null;
}

const AXIS_FOR_CONTEXT: Record<ScopeAxis, keyof ScopeContext> = {
  subBrands: 'subBrand',
  markets: 'market',
  channels: 'channel',
  assetTypes: 'assetType',
  campaigns: 'campaign',
};

/** An axis is unconstrained when it is absent, empty, or the wildcard `*`. */
export function isWildcard(values: string[] | undefined | null): boolean {
  if (!values || values.length === 0) return true;
  return values.length === 1 && values[0] === '*';
}

/**
 * Weighted integer specificity. `0` means global.
 *
 * Deliberately not a function of how MANY values an axis lists: `markets:
 * ['de-DE']` and `markets: ['de-DE','fr-FR']` are equally specific statements
 * about the market axis, and letting cardinality leak into the score would
 * make a broader rule beat a narrower one.
 */
export function computeSpecificity(scope: ScopeSelector | null | undefined): number {
  if (!scope) return 0;
  let total = 0;
  for (const axis of SCOPE_AXES) {
    if (!isWildcard(scope[axis] as string[] | undefined)) total += SPECIFICITY_WEIGHTS[axis];
  }
  return total;
}

/** True when every constrained axis of `scope` admits the context. */
export function scopeMatches(scope: ScopeSelector | null | undefined, ctx: ScopeContext): boolean {
  if (!scope) return true;
  for (const axis of SCOPE_AXES) {
    const values = scope[axis] as string[] | undefined;
    if (isWildcard(values)) continue;

    const actual = ctx[AXIS_FOR_CONTEXT[axis]];
    // A rule that constrains an axis the asset does not populate cannot apply.
    // Silently treating "unknown market" as "matches every market" would fire
    // German legal rules on assets whose market was never set.
    if (actual === undefined || actual === null || actual === '') return false;
    if (!(values as string[]).includes(actual)) return false;
  }
  return true;
}

export interface ResolvableRule {
  key: string;
  version: number;
  scope?: ScopeSelector | null;
  specificity?: number | null;
  /**
   * Who owns the rule. `brand` is the tenant's own; `inherited` came from a
   * shipped rule pack.
   *
   * This is a SEPARATE tier from specificity on purpose. A baseline rule and
   * a brand's override of it both carry an empty scope, so both compute
   * specificity 0 — leaving the winner to be decided by version and
   * timestamp, which is arbitrary. A brand's own rule must beat the shipped
   * default every time, whenever it was written.
   */
  origin?: 'brand' | 'inherited' | null;
  /** Tie-break of last resort, so resolution is deterministic across runs. */
  createdAt?: Date | string | null;
  status?: string;
}

/** Brand-owned sorts before inherited. Unset is treated as brand-owned, so
 *  every rule written before packs existed keeps its previous precedence. */
function originRank(origin: ResolvableRule['origin']): number {
  return origin === 'inherited' ? 1 : 0;
}

/**
 * Most-specific-wins resolution over a rule key.
 *
 * Ordering within a key: specificity desc, then brand-owned before inherited,
 * then version desc, then createdAt desc, then key ordering. Every tier is needed — two rules can legitimately
 * share a specificity (`markets:['de-DE']` vs `markets:['fr-FR']` both = 10),
 * and without a total order the compiled snapshot would depend on the row
 * order Postgres happened to return, which would change the ruleset hash and
 * silently invalidate the entire result cache.
 */
export function resolveByKey<T extends ResolvableRule>(rules: readonly T[], ctx: ScopeContext): T[] {
  const winners = new Map<string, T>();

  for (const rule of rules) {
    if (!scopeMatches(rule.scope, ctx)) continue;
    const current = winners.get(rule.key);
    if (!current || compareRules(rule, current) < 0) winners.set(rule.key, rule);
  }

  return [...winners.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Negative when `a` should win over `b`. */
export function compareRules(a: ResolvableRule, b: ResolvableRule): number {
  const sa = a.specificity ?? computeSpecificity(a.scope);
  const sb = b.specificity ?? computeSpecificity(b.scope);
  if (sa !== sb) return sb - sa;

  // Ownership outranks recency: a brand that forked a baseline rule two years
  // ago still means it, even after the shipped version was updated yesterday.
  const oa = originRank(a.origin);
  const ob = originRank(b.origin);
  if (oa !== ob) return oa - ob;

  if (a.version !== b.version) return b.version - a.version;
  const ta = toTime(a.createdAt);
  const tb = toTime(b.createdAt);
  if (ta !== tb) return tb - ta;
  return a.key.localeCompare(b.key);
}

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
