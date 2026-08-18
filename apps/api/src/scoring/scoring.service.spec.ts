import { describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT, bandFor, scoreCriteria, type ScorableCriterion } from './scoring.service';
import { DEFAULT_SCORING, type ScoringConfig } from '../rulesets/ruleset-compiler.service';

const config: ScoringConfig = { ...DEFAULT_SCORING };

function criterion(over: Partial<ScorableCriterion> = {}): ScorableCriterion {
  return {
    ruleKey: 'rule.a',
    dimension: 'logo',
    severity: 'major',
    verdict: 'pass',
    weight: 1,
    ...over,
  };
}

describe('ScoringService — deterministic aggregation', () => {
  it('scores 100 when every evaluated criterion passes', () => {
    const result = scoreCriteria([criterion(), criterion({ ruleKey: 'rule.b' })], config);
    expect(result.score).toBe(100);
    expect(result.scoreBand).toBe('pass');
    expect(result.criteriaPassed).toBe(2);
  });

  it('scores 0 when every evaluated criterion fails', () => {
    const result = scoreCriteria([criterion({ verdict: 'fail' }), criterion({ ruleKey: 'rule.b', verdict: 'fail' })], config);
    expect(result.score).toBe(0);
    expect(result.scoreBand).toBe('fail');
  });

  it('weights a criterion by rule weight × severity', () => {
    // One major pass (3) against one minor fail (1) ⇒ 3/4 = 75.
    const result = scoreCriteria(
      [criterion({ severity: 'major' }), criterion({ ruleKey: 'rule.b', severity: 'minor', verdict: 'fail' })],
      config,
    );
    expect(result.score).toBe(75);
    expect(SEVERITY_WEIGHT.major).toBeGreaterThan(SEVERITY_WEIGHT.minor);
  });

  it('excludes advisories from the score entirely — they must never cost a point', () => {
    const withAdvisory = scoreCriteria(
      [criterion(), criterion({ ruleKey: 'rule.adv', severity: 'advisory', verdict: 'fail' })],
      config,
    );
    const without = scoreCriteria([criterion()], config);
    expect(withAdvisory.score).toBe(without.score);
    expect(withAdvisory.score).toBe(100);
    // The advisory is still counted as a failure for reporting purposes.
    expect(withAdvisory.criteriaFailed).toBe(1);
  });

  describe('blockers override the score', () => {
    it('forces band `fail` even at a score that would otherwise pass', () => {
      // 20 major passes (weight 3 each) against one failed blocker (weight 4)
      // in the same dimension ⇒ 60/64 = 93.75, comfortably over passThreshold.
      const criteria = [
        ...Array.from({ length: 20 }, (_, i) => criterion({ ruleKey: `pass.${i}`, dimension: 'legal' })),
        criterion({ ruleKey: 'legal.disclaimer', severity: 'blocker', verdict: 'fail', dimension: 'legal' }),
      ];
      const result = scoreCriteria(criteria, config);
      expect(result.score).toBeGreaterThan(config.passThreshold);
      expect(result.hasBlocker).toBe(true);
      // "Everything is perfect except the mandatory legal disclaimer" is not a
      // conditional pass in any jurisdiction that matters.
      expect(result.scoreBand).toBe('fail');
      expect(result.blockingRuleKeys).toEqual(['legal.disclaimer']);
    });

    it('does not trip on a blocker that passed', () => {
      const result = scoreCriteria([criterion({ severity: 'blocker', verdict: 'pass' })], config);
      expect(result.hasBlocker).toBe(false);
      expect(result.scoreBand).toBe('pass');
    });

    it('reports each distinct blocking rule once', () => {
      const result = scoreCriteria(
        [
          criterion({ ruleKey: 'legal.a', severity: 'blocker', verdict: 'fail' }),
          criterion({ ruleKey: 'legal.a', severity: 'blocker', verdict: 'fail' }),
          criterion({ ruleKey: 'legal.b', severity: 'blocker', verdict: 'fail' }),
        ],
        config,
      );
      expect(result.blockingRuleKeys.sort()).toEqual(['legal.a', 'legal.b']);
    });
  });

  describe('abstentions', () => {
    it('are excluded from the score denominator', () => {
      const withAbstention = scoreCriteria(
        [criterion(), criterion({ ruleKey: 'rule.b', verdict: 'abstained' })],
        config,
      );
      expect(withAbstention.score).toBe(100);
      expect(withAbstention.criteriaAbstained).toBe(1);
    });

    it('counts insufficient_evidence as an abstention', () => {
      const result = scoreCriteria([criterion({ verdict: 'insufficient_evidence' })], config);
      expect(result.criteriaAbstained).toBe(1);
      expect(result.score).toBeNull();
    });

    it('lowers coverageRate, which is the point of tracking them', () => {
      const result = scoreCriteria(
        [criterion(), criterion({ ruleKey: 'b', verdict: 'fail' }), criterion({ ruleKey: 'c', verdict: 'abstained' })],
        config,
      );
      expect(result.criteriaTotal).toBe(3);
      expect(result.criteriaEvaluated).toBe(2);
      expect(result.coverageRate).toBeCloseTo(2 / 3, 4);
    });

    it('treats not_applicable as decided (it needed no human)', () => {
      const result = scoreCriteria([criterion({ verdict: 'not_applicable' })], config);
      expect(result.coverageRate).toBe(1);
      expect(result.criteriaEvaluated).toBe(1);
      // …but it does not participate in the score.
      expect(result.score).toBeNull();
    });
  });

  describe('dimension aggregation', () => {
    it('aggregates per dimension before combining, so a big dimension cannot drown a small one', () => {
      const criteria: ScorableCriterion[] = [
        ...Array.from({ length: 10 }, (_, i) => criterion({ ruleKey: `typo.${i}`, dimension: 'typography' })),
        criterion({ ruleKey: 'legal.1', dimension: 'legal', verdict: 'fail', severity: 'major' }),
      ];
      const result = scoreCriteria(criteria, config);
      expect(result.dimensionScores.typography).toBe(100);
      expect(result.dimensionScores.legal).toBe(0);
      // Unweighted mean of the two dimensions, not 10/11.
      expect(result.score).toBe(50);
    });

    it('honours configured dimension weights', () => {
      const criteria: ScorableCriterion[] = [
        criterion({ ruleKey: 'typo.1', dimension: 'typography' }),
        criterion({ ruleKey: 'legal.1', dimension: 'legal', verdict: 'fail' }),
      ];
      const weighted = scoreCriteria(criteria, { ...config, dimensionWeights: { legal: 3, typography: 1 } });
      // (100*1 + 0*3) / 4 = 25
      expect(weighted.score).toBe(25);
    });

    it('ignores dimensions with no evaluated criteria', () => {
      const result = scoreCriteria(
        [criterion({ dimension: 'logo' }), criterion({ ruleKey: 'b', dimension: 'copy', verdict: 'abstained' })],
        config,
      );
      expect(Object.keys(result.dimensionScores)).toEqual(['logo']);
      expect(result.score).toBe(100);
    });
  });

  describe('bands', () => {
    it('uses the configured thresholds', () => {
      expect(bandFor(90, false, config)).toBe('pass');
      expect(bandFor(85, false, config)).toBe('pass');
      expect(bandFor(84.99, false, config)).toBe('conditional');
      expect(bandFor(70, false, config)).toBe('conditional');
      expect(bandFor(69.99, false, config)).toBe('fail');
    });

    it('returns null when nothing was scoreable and nothing blocked', () => {
      expect(bandFor(null, false, config)).toBeNull();
    });

    it('still fails on a blocker with no numeric score', () => {
      expect(bandFor(null, true, config)).toBe('fail');
    });

    it('respects custom thresholds from the ruleset', () => {
      const strict = { ...config, passThreshold: 95, conditionalThreshold: 90 };
      expect(bandFor(92, false, strict)).toBe('conditional');
      expect(bandFor(96, false, strict)).toBe('pass');
    });
  });

  it('returns a null score and null band for an empty criteria set', () => {
    const result = scoreCriteria([], config);
    expect(result.score).toBeNull();
    expect(result.scoreBand).toBeNull();
    expect(result.coverageRate).toBeNull();
    expect(result.criteriaTotal).toBe(0);
  });

  it('is a pure function — same input, same output', () => {
    const criteria = [criterion(), criterion({ ruleKey: 'b', verdict: 'fail', severity: 'blocker' })];
    expect(scoreCriteria(criteria, config)).toEqual(scoreCriteria(criteria, config));
  });

  it('ignores negative weights rather than letting them invert the score', () => {
    const result = scoreCriteria([criterion({ weight: -5, verdict: 'fail' }), criterion({ ruleKey: 'b' })], config);
    expect(result.score).toBe(100);
  });
});
