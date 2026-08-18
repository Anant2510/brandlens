import { Injectable } from '@nestjs/common';
import type { ScoringConfig } from '../rulesets/compile';
import { scoreCriteria, type ScorableCriterion, type ScoreResult } from './scoring';

/**
 * Injectable wrapper over the pure scorer in `./scoring`.
 *
 * The arithmetic lives in a framework-free module so the worker imports the
 * exact same function. A score computed on the queue must equal the score
 * computed inline; two implementations would eventually disagree, and the
 * customer would see it as the product being non-deterministic.
 */
@Injectable()
export class ScoringService {
  score(criteria: readonly ScorableCriterion[], config: ScoringConfig): ScoreResult {
    return scoreCriteria(criteria, config);
  }
}

export { SEVERITY_WEIGHT, bandFor, scoreCriteria } from './scoring';
export type { ScorableCriterion, ScoreResult } from './scoring';
