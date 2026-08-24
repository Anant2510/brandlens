import { describe, expect, it } from 'vitest';
import {
  ANALYZER_MANIFEST,
  ANALYZER_NAMES,
  ONTOLOGY_FREE_ANALYZERS,
  analyzerContract,
  describeCheckDrift,
  formatCheckDrift,
} from './analyzer-manifest.js';

describe('the manifest itself', () => {
  it('covers the whole registry', () => {
    // If this drops, somebody added an analyzer and did not regenerate. The
    // guard would then let every rule targeting the new name through as
    // "unknown analyzer" noise or, worse, silently accept any params for it.
    expect(ANALYZER_NAMES.length).toBe(41);
  });

  it('carries the generic rubric judge, and reads no ontology for it', () => {
    /*
     * `vlm.rubric` is what lets a brand author a semantic rule — composition,
     * theme relevance — without an engine deploy. Every other vlm.* analyzer
     * hardcodes its question, so before this existed such a rule had to be
     * smuggled through `vlm.mood`, which labelled a composition check as one
     * about atmosphere.
     *
     * It must stay ontology-free: a brand with nothing configured is exactly
     * the one that needs to write its own rules.
     */
    expect(ANALYZER_MANIFEST['vlm.rubric']).toBeDefined();
    expect(ANALYZER_MANIFEST['vlm.rubric']!.ontology).toEqual([]);
    expect(ONTOLOGY_FREE_ANALYZERS).toContain('vlm.rubric');
  });

  it('names a real engine function for every analyzer', () => {
    for (const name of ANALYZER_NAMES) {
      expect(ANALYZER_MANIFEST[name]!.fn).toMatch(/^[a-z_]+\.check_[a-z_]+$/);
    }
  });

  it('records which analyzers work on a brand with an empty ontology', () => {
    // These are the only checks that can produce a verdict on day one; every
    // other analyzer returns not_applicable until somebody populates the
    // ontology it reads. Baseline packs are built from this list.
    expect(ONTOLOGY_FREE_ANALYZERS).toContain('accessibility.contrast');
    expect(ONTOLOGY_FREE_ANALYZERS).toContain('layout.margins');
    expect(ONTOLOGY_FREE_ANALYZERS).not.toContain('logo.presence');
    expect(ONTOLOGY_FREE_ANALYZERS).not.toContain('copy.banned_terms');
  });

  it('records the default a missing key falls back to', () => {
    expect(ANALYZER_MANIFEST['typography.hierarchy']!.params.minStepRatio).toBe(1.15);
    expect(ANALYZER_MANIFEST['logo.presence']!.params.minScore).toBe(0);
    // Null means "accepted but unset" — the analyzer skips that comparison
    // rather than substituting a number.
    expect(ANALYZER_MANIFEST['copy.readability']!.params.maxFleschKincaidGrade).toBeNull();
  });
});

describe('describeCheckDrift', () => {
  it('passes a check whose keys the analyzer reads', () => {
    expect(describeCheckDrift('copy.readability', { maxFleschKincaidGrade: 11, minWords: 20 })).toBeNull();
  });

  it('passes a check with no params at all', () => {
    expect(describeCheckDrift('typography.fallback_font', {})).toBeNull();
    expect(describeCheckDrift('typography.fallback_font', undefined)).toBeNull();
  });

  it('flags an analyzer that is not registered', () => {
    const drift = describeCheckDrift('typography.leading', { minPx: 4 });
    expect(drift?.unknownAnalyzer).toBe(true);
  });

  it('flags a key the analyzer never reads', () => {
    const drift = describeCheckDrift('typography.min_size', { minPx: 12 });
    expect(drift?.deadParams.map((d) => d.key)).toEqual(['minPx']);
  });

  it('suggests the key that was probably meant, and says what runs instead', () => {
    const drift = describeCheckDrift('typography.hierarchy', { minRatio: 1.25 });
    expect(drift?.deadParams[0]).toMatchObject({
      key: 'minRatio',
      didYouMean: 'minStepRatio',
      fallsBackTo: 1.15,
    });
  });

  it('offers no suggestion when nothing is close', () => {
    // A wrong guess sends somebody to change the wrong line, which is worse
    // than saying "no such key" and making them read the analyzer.
    const drift = describeCheckDrift('logo.clearspace', { tolerancePx: 2 });
    expect(drift?.deadParams[0]?.didYouMean).toBeNull();
  });

  it('flags every key on an analyzer that takes none', () => {
    const drift = describeCheckDrift('vlm.voice_tone', { axes: [], requireAllAxes: true });
    expect(drift?.deadParams).toHaveLength(2);
  });
});

describe('formatCheckDrift', () => {
  it('names the rule, the dead key, the suggestion and the real default', () => {
    const drift = describeCheckDrift('typography.hierarchy', { minRatio: 1.25 })!;
    const text = formatCheckDrift(drift, 'typography.hierarchy');
    expect(text).toContain('minRatio');
    expect(text).toContain('minStepRatio');
    expect(text).toContain('1.15');
    expect(text).toContain('accepted:');
  });

  it('says plainly when an analyzer accepts nothing', () => {
    const drift = describeCheckDrift('vlm.voice_tone', { axes: [] })!;
    expect(formatCheckDrift(drift)).toContain('takes no parameters');
  });

  it('says an unregistered analyzer would never execute', () => {
    const drift = describeCheckDrift('copy.vibes', {})!;
    expect(formatCheckDrift(drift, 'copy.vibes')).toContain('never execute');
  });
});

describe('analyzerContract', () => {
  it('returns null rather than throwing for an unknown name', () => {
    expect(analyzerContract('nope.nope')).toBeNull();
  });
});
