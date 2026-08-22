import { describe, expect, it } from 'vitest';
import { checkDrifts, explainCheck, missingRubricProblem, sanitiseCheck } from './analyzer-check.js';

describe('explainCheck', () => {
  it('is null for a clean check', () => {
    expect(explainCheck({ fn: 'accessibility.contrast', params: { level: 'AA' } })).toBeNull();
  });

  it('reads as something a person could act on', () => {
    const message = explainCheck({ fn: 'typography.min_size', params: { minPx: 12 } }, 'typography.body');
    expect(message).toContain('typography.body');
    expect(message).toContain('minPx');
    expect(message).toContain('minSizePt');
  });

  it('reaches into the nested check a hybrid rule runs', () => {
    // `measureParams` is handed to a different analyzer entirely, so a typo
    // there is invisible to a check of the outer params.
    const message = explainCheck({
      fn: 'vlm.rule_adjudication',
      params: { measuredBy: 'copy.banned_terms', measureParams: { words: ['best'] } },
    });
    expect(message).toContain('words');
    expect(message).toContain('terms');
  });

  it('ignores measureParams when no inner analyzer is named', () => {
    expect(checkDrifts({ fn: 'vlm.rule_adjudication', params: { measureParams: { anything: 1 } } })).toHaveLength(0);
  });
});

describe('sanitiseCheck', () => {
  it('returns a clean check untouched', () => {
    const check = { fn: 'copy.readability', params: { minWords: 20 } };
    expect(sanitiseCheck(check).check).toBe(check);
  });

  it('drops the dead key and keeps the live one', () => {
    const { check, removed } = sanitiseCheck({
      fn: 'copy.readability',
      params: { maxGrade: 11, minWords: 20 },
    });
    expect(check.params).toEqual({ minWords: 20 });
    expect(removed).toEqual(['copy.readability.maxGrade']);
  });

  it('writes a sentence a reviewer can read', () => {
    const { note } = sanitiseCheck({ fn: 'logo.presence', params: { minConfidence: 0.6 } });
    expect(note).toContain('minConfidence');
    expect(note).toContain('dropped');
  });

  it('sanitises the nested check without disturbing the outer one', () => {
    const { check, removed } = sanitiseCheck({
      fn: 'vlm.rule_adjudication',
      params: {
        measuredBy: 'copy.banned_terms',
        adjudicatePasses: true,
        measureParams: { terms: ['best'], fuzzy: 90 },
      },
    });
    expect(check.params).toMatchObject({ measuredBy: 'copy.banned_terms', adjudicatePasses: true });
    expect(check.params?.measureParams).toEqual({ terms: ['best'] });
    expect(removed).toEqual(['copy.banned_terms.fuzzy']);
  });

  it('leaves an unregistered analyzer alone and says the rule cannot run', () => {
    // Emptying its params would hide the real problem behind a tidier object.
    const { check, removed, note } = sanitiseCheck({ fn: 'typography.leading', params: { maxPx: 4 } });
    expect(check.params).toEqual({ maxPx: 4 });
    expect(removed).toEqual([]);
    expect(note).toContain('cannot be evaluated');
  });
});

describe('missingRubricProblem — the rubric IS the criterion', () => {
  const check = { fn: 'vlm.rubric', params: {} };

  it('accepts a rubric-driven check that carries a question', () => {
    expect(missingRubricProblem(check, { question: 'Is the subject centred?' })).toBeNull();
  });

  it('refuses one with no rubric at all', () => {
    // The engine already reports this as insufficient_evidence at check time,
    // which is correct but late — by then the rule is in somebody's ruleset,
    // shown as a criterion, returning nothing forever.
    expect(missingRubricProblem(check, null, 'composition.vague')).toContain('needs a rubric');
  });

  it('refuses a rubric whose question is blank', () => {
    expect(missingRubricProblem(check, { question: '   ' })).toBeTruthy();
  });

  it('says nothing about analyzers that do not read a rubric', () => {
    // `copy.readability` has no rubric and needs none; complaining would be
    // noise on 40 of the 41 analyzers.
    expect(missingRubricProblem({ fn: 'copy.readability', params: {} }, null)).toBeNull();
  });

  it('is folded into explainCheck, so every caller enforces it', () => {
    const message = explainCheck({ fn: 'vlm.rubric', params: {} }, 'composition.vague', null);
    expect(message).toContain('needs a rubric');
  });

  it('reports a missing rubric and a dead parameter together', () => {
    // Two problems, one 400. Fixing them one round-trip at a time is worse.
    const message = explainCheck({ fn: 'vlm.rubric', params: { question: 'x' } }, 'composition.vague', null);
    expect(message).toContain('needs a rubric');
    expect(message).toContain('never read');
  });
});
