import type { Severity, Verdict } from '@brandlens/contracts';
import type { ScoringConfig } from '../rulesets/compile';

/* ==========================================================================
 * SCORING — pure, dependency-free.
 *
 * The headline number is DETERMINISTIC AGGREGATION over atomic criteria. It is
 * never a number a model produced.
 *
 * The reason is empirical: VLM judges rank well and score badly. Ask one "is
 * the clear space respected, yes or no" and it is useful; ask it "rate this
 * asset's brand compliance out of 100" and the answer moves several points
 * between identical calls, correlates with image aesthetics rather than
 * compliance, and cannot be explained to a reviewer. So the model only ever
 * answers binary/ordinal leaves, and arithmetic — which is reproducible,
 * auditable and free — turns those leaves into the number on the dashboard.
 *
 * This module has no framework imports precisely so the worker can share it
 * with the API. A score computed in the queue must equal the score computed
 * inline, or the same asset gets two different answers depending on which
 * process happened to run it.
 * ========================================================================== */

export interface ScorableCriterion {
  ruleKey: string;
  dimension: string;
  severity: Severity;
  verdict: Verdict;
  /** Rule weight; contribution to its dimension score. */
  weight: number;
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
 * Severity multipliers applied on top of the per-rule weight.
 *
 * `advisory` is 0 by design: an advisory must never move the number, because
 * the moment a false-positive advisory costs a customer a point they stop
 * trusting the score and start arguing with it. Advisories still produce
 * findings — they are surfaced, they just do not price.
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  blocker: 4,
  major: 3,
  minor: 1,
  advisory: 0,
};

/** Verdicts that count as "the machine decided this without a human". */
const DECIDED: ReadonlySet<Verdict> = new Set<Verdict>(['pass', 'fail', 'not_applicable']);
/** Verdicts that are excluded from the score denominator. */
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

    // A failed blocker forces the band regardless of arithmetic. Recorded even
    // when the rule's weight is zero — severity is a gate, not a weight.
    if (c.verdict === 'fail' && c.severity === 'blocker') blockingRuleKeys.push(c.ruleKey);

    // Only pass/fail participate in the score. `not_applicable` means the rule
    // did not apply to this asset (no disclaimer needed in this market), and
    // abstentions mean the system does not know — scoring either of them as a
    // pass would inflate the number, and as a fail would punish the customer
    // for our uncertainty.
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

  // Holistic score: weighted mean of the dimension scores, NOT of the raw
  // criteria. Aggregating per dimension first stops a dimension with fifty
  // typographic leaves from drowning out a dimension with three legal ones.
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
  const total = criteria.length;

  return {
    score,
    scoreBand: bandFor(score, hasBlocker, config),
    hasBlocker,
    dimensionScores,
    criteriaTotal: total,
    criteriaEvaluated: decided,
    criteriaPassed: passed,
    criteriaFailed: failed,
    criteriaAbstained: abstained,
    // The headline customer-facing metric: what share the system settled
    // without a human. Abstentions are the denominator's whole point.
    coverageRate: total > 0 ? round4(decided / total) : null,
    blockingRuleKeys: [...new Set(blockingRuleKeys)],
  };
}

/**
 * Band assignment. A failed blocker is `fail` even at score 99: "everything is
 * perfect except the mandatory legal disclaimer is missing" is not a
 * conditional pass in any jurisdiction that matters.
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
