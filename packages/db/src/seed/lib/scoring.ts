/* ==========================================================================
 * Deterministic score aggregation.
 *
 * A verbatim port of apps/api/src/scoring/scoring.ts. The seeded check run has
 * to carry the score the API would compute for the same criteria — if it did
 * not, the very first re-run of that check in the demo would change the number
 * on the dashboard and the whole thing would look broken.
 *
 * The headline number is never a value a model produced. VLM judges rank well
 * and score badly: ask one "is the clear space respected, yes or no" and it is
 * useful; ask it "rate this asset out of 100" and the answer moves several
 * points between identical calls. So the model answers binary leaves and
 * arithmetic — reproducible, auditable and free — produces the number.
 * ========================================================================== */

export type Severity = 'blocker' | 'major' | 'minor' | 'advisory';
export type Verdict = 'pass' | 'fail' | 'not_applicable' | 'insufficient_evidence' | 'abstained';

export interface ScorableCriterion {
  ruleKey: string;
  dimension: string;
  severity: Severity;
  verdict: Verdict;
  weight: number;
}

export interface ScoringConfig {
  dimensionWeights: Record<string, number>;
  passThreshold: number;
  conditionalThreshold: number;
}

export interface ScoreResult {
  score: number | null;
  scoreBand: 'pass' | 'conditional' | 'fail' | null;
  hasBlocker: boolean;
  dimensionScores: Record<string, number>;
  criteriaTotal: number;
  criteriaEvaluated: number;
  criteriaPassed: number;
  criteriaFailed: number;
  criteriaAbstained: number;
  coverageRate: number | null;
  blockingRuleKeys: string[];
}

/**
 * `advisory` is 0 by design: an advisory must never move the number. The
 * moment a false-positive advisory costs a customer a point they stop trusting
 * the score and start arguing with it.
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  blocker: 4,
  major: 3,
  minor: 1,
  advisory: 0,
};

const DECIDED: ReadonlySet<Verdict> = new Set<Verdict>(['pass', 'fail', 'not_applicable']);
const ABSTAINED: ReadonlySet<Verdict> = new Set<Verdict>(['abstained', 'insufficient_evidence']);

export function scoreCriteria(criteria: readonly ScorableCriterion[], config: ScoringConfig): ScoreResult {
  const perDimension = new Map<string, { earned: number; possible: number }>();

  let passed = 0;
  let failed = 0;
  let abstained = 0;
  let decided = 0;
  const blockingRuleKeys: string[] = [];

  for (const c of criteria) {
    if (c.verdict === 'pass') passed += 1;
    else if (c.verdict === 'fail') failed += 1;
    if (ABSTAINED.has(c.verdict)) abstained += 1;
    if (DECIDED.has(c.verdict)) decided += 1;

    if (c.verdict === 'fail' && c.severity === 'blocker') blockingRuleKeys.push(c.ruleKey);

    // `not_applicable` means the rule did not apply; abstentions mean the
    // system does not know. Scoring either as a pass would inflate the number,
    // and as a fail would punish the customer for our uncertainty.
    if (c.verdict !== 'pass' && c.verdict !== 'fail') continue;

    const weight = Math.max(0, c.weight) * SEVERITY_WEIGHT[c.severity];
    if (weight === 0) continue;

    const bucket = perDimension.get(c.dimension) ?? { earned: 0, possible: 0 };
    bucket.possible += weight;
    if (c.verdict === 'pass') bucket.earned += weight;
    perDimension.set(c.dimension, bucket);
  }

  const dimensionScores: Record<string, number> = {};
  for (const [dimension, { earned, possible }] of perDimension) {
    if (possible <= 0) continue;
    dimensionScores[dimension] = round2((earned / possible) * 100);
  }

  // Weighted mean of the DIMENSION scores, not of the raw criteria: otherwise
  // a dimension with fifty typographic leaves drowns out one with three legal
  // ones.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [dimension, value] of Object.entries(dimensionScores)) {
    const w = config.dimensionWeights?.[dimension] ?? 1;
    if (w <= 0) continue;
    weightedSum += value * w;
    weightTotal += w;
  }

  const score = weightTotal > 0 ? round2(weightedSum / weightTotal) : null;
  const hasBlocker = blockingRuleKeys.length > 0;

  return {
    score,
    scoreBand: bandFor(score, hasBlocker, config),
    hasBlocker,
    dimensionScores,
    criteriaTotal: criteria.length,
    criteriaEvaluated: decided,
    criteriaPassed: passed,
    criteriaFailed: failed,
    criteriaAbstained: abstained,
    coverageRate: criteria.length > 0 ? round4(decided / criteria.length) : null,
    blockingRuleKeys: [...new Set(blockingRuleKeys)],
  };
}

/**
 * A failed blocker is `fail` even at score 99: "everything is perfect except
 * the mandatory legal disclaimer is missing" is not a conditional pass in any
 * jurisdiction that matters.
 */
export function bandFor(
  score: number | null,
  hasBlocker: boolean,
  config: ScoringConfig,
): 'pass' | 'conditional' | 'fail' | null {
  if (hasBlocker) return 'fail';
  if (score === null) return null;
  if (score >= config.passThreshold) return 'pass';
  if (score >= config.conditionalThreshold) return 'conditional';
  return 'fail';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
