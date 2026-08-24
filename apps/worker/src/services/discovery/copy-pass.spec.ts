import type { AnalyzeCopyResponse } from '@brandlens/contracts';
import { describeCheckDrift, formatCheckDrift } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import { synthesizeCopyRules } from './copy-pass';

const copy = (over: Partial<AnalyzeCopyResponse> = {}): AnalyzeCopyResponse => ({
  requestId: 'r',
  voiceAxes: [],
  lexicon: [],
  claims: [],
  disclaimers: [],
  readability: { metrics: {}, degraded: false, stats: {} },
  costUsd: 0,
  warnings: [],
  ...over,
});

const keys = (rules: { key: string }[]) => rules.map((r) => r.key);

describe('synthesizeCopyRules — governance', () => {
  it('proposes everything and activates nothing', () => {
    const rules = synthesizeCopyRules({
      copy: copy({
        lexicon: [{ term: 'synergy', kind: 'banned', note: null, uses: 4, pageCount: 3 }],
        claims: [
          {
            text: 'The best coffee in Britain.',
            url: 'https://x/',
            triggers: ['best'],
            claimType: 'superlative',
            needsSubstantiation: true,
            suggestedEvidence: null,
            judged: true,
          },
        ],
        disclaimers: [{ text: 'Terms apply.', url: 'https://x/', triggerCondition: null }],
      }),
      pageCount: 8,
    });

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.status).toBe('proposed');
      expect(rule.provenance).toBe('inductive');
      expect(rule.support).toBeTruthy();
    }
  });

  it('names an analyzer that exists and passes it only keys it reads', () => {
    // Checking the function name alone was not enough: three rules here once
    // named a real analyzer and handed it keys nothing read — `maxGrade`,
    // `requireApproval`, `axes` — so each displayed a threshold and enforced
    // the analyzer's default.
    const rules = synthesizeCopyRules({
      copy: copy({
        lexicon: [
          { term: 'synergy', kind: 'banned', note: null, uses: 3, pageCount: 2 },
          { term: 'traceable', kind: 'required', note: null, uses: 6, pageCount: 4 },
        ],
        claims: [
          {
            text: 'Best in class.',
            url: 'u',
            triggers: ['best'],
            claimType: 'superlative',
            needsSubstantiation: true,
            suggestedEvidence: null,
            judged: true,
          },
        ],
        disclaimers: [{ text: 'Terms apply.', url: 'u', triggerCondition: null }],
        readability: { metrics: { fleschKincaidGrade: 8.4 }, degraded: false, stats: { words: 900 } },
        voiceAxes: [
          {
            name: 'Directness',
            lowLabel: 'Ornate',
            highLabel: 'Plain',
            value: 0.8,
            rationale: null,
            evidence: ['We roast on Tuesdays.'],
          },
        ],
      }),
      pageCount: 8,
    });

    for (const rule of rules) {
      const drift = describeCheckDrift(rule.check.fn, rule.check.params);
      expect(drift ? formatCheckDrift(drift, rule.key) : null).toBeNull();
    }
  });

  it('uses only dimensions the rule schema accepts', () => {
    const allowed = new Set(['logo', 'color', 'typography', 'layout', 'imagery', 'copy', 'accessibility', 'channel_spec', 'legal']);
    const rules = synthesizeCopyRules({
      copy: copy({
        voiceAxes: [
          { name: 'Warmth', lowLabel: 'Cold', highLabel: 'Warm', value: 0.7, rationale: null, evidence: ['x'] },
        ],
      }),
      pageCount: 4,
    });
    for (const rule of rules) expect(allowed.has(rule.dimension)).toBe(true);
  });
});

describe('synthesizeCopyRules — emits nothing it cannot evidence', () => {
  it('proposes no rules at all from an empty analysis', () => {
    expect(synthesizeCopyRules({ copy: copy(), pageCount: 8 })).toEqual([]);
  });

  it('skips the claim rule when no claim needs substantiating', () => {
    const rules = synthesizeCopyRules({
      copy: copy({
        claims: [
          {
            text: 'We roast on Tuesdays.',
            url: 'u',
            triggers: [],
            claimType: 'other',
            needsSubstantiation: false,
            suggestedEvidence: null,
            judged: true,
          },
        ],
      }),
      pageCount: 8,
    });
    // An active substantiation rule with an empty register fails every asset
    // that mentions anything, which teaches people to switch rules off.
    expect(keys(rules)).not.toContain('copy.claim-substantiation');
  });

  it('skips readability on a corpus too small to measure', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ readability: { metrics: { fleschKincaidGrade: 9 }, degraded: false, stats: { words: 120 } } }),
      pageCount: 3,
    });
    expect(keys(rules)).not.toContain('copy.readability');
  });

  it('proposes readability once there is enough prose', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ readability: { metrics: { fleschKincaidGrade: 9.2 }, degraded: false, stats: { words: 1200 } } }),
      pageCount: 6,
    });
    expect(keys(rules)).toContain('copy.readability');
  });
});

describe('synthesizeCopyRules — thresholds follow the brand, not a template', () => {
  it('sets the grade ceiling one step above what the site achieves', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ readability: { metrics: { fleschKincaidGrade: 9.2 }, degraded: false, stats: { words: 1200 } } }),
      pageCount: 6,
    });
    expect(rules.find((r) => r.key === 'copy.readability')?.check.params.maxFleschKincaidGrade).toBe(11);
  });

  it('never proposes a ceiling below grade 6, however simple the site', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ readability: { metrics: { fleschKincaidGrade: 1.1 }, degraded: false, stats: { words: 1200 } } }),
      pageCount: 6,
    });
    expect(rules.find((r) => r.key === 'copy.readability')?.check.params.maxFleschKincaidGrade).toBe(6);
  });

  it('says so when the grade came from the degraded fallback', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ readability: { metrics: { fleschKincaidGrade: 9 }, degraded: true, stats: { words: 1200 } } }),
      pageCount: 6,
    });
    expect(rules.find((r) => r.key === 'copy.readability')?.support?.note).toContain('approximate');
  });
});

describe('synthesizeCopyRules — voice', () => {
  const axes = [
    { name: 'Directness', lowLabel: 'Ornate', highLabel: 'Plain', value: 0.85, rationale: null, evidence: ['a', 'b'] },
    { name: 'Warmth', lowLabel: 'Clinical', highLabel: 'Warm', value: 0.2, rationale: null, evidence: ['c'] },
  ];

  it('is the only VLM-tier rule discovery proposes', () => {
    const rules = synthesizeCopyRules({
      copy: copy({
        voiceAxes: axes,
        lexicon: [{ term: 'synergy', kind: 'banned', note: null, uses: 3, pageCount: 2 }],
      }),
      pageCount: 8,
    });
    const vlm = rules.filter((r) => r.tier === 'vlm');
    expect(vlm).toHaveLength(1);
    expect(vlm[0].key).toBe('copy.voice-tone');
  });

  it('renders the axes as a sentence a judge can act on', () => {
    const rule = synthesizeCopyRules({ copy: copy({ voiceAxes: axes }), pageCount: 8 }).find(
      (r) => r.key === 'copy.voice-tone',
    );
    // 0.85 → the high label; 0.2 → the low label.
    expect(rule?.rubric?.question).toContain('Plain rather than Ornate');
    expect(rule?.rubric?.question).toContain('Clinical rather than Warm');
  });

  it('ships a fully labelled symmetric ordinal scale', () => {
    // Unlabelled or lopsided anchors bias a judge toward the middle or the top.
    const rule = synthesizeCopyRules({ copy: copy({ voiceAxes: axes }), pageCount: 8 }).find(
      (r) => r.key === 'copy.voice-tone',
    );
    expect(rule?.rubric?.kind).toBe('ordinal');
    expect(rule?.rubric?.levels).toHaveLength(5);
    for (const level of rule?.rubric?.levels ?? []) {
      expect(level.label.length).toBeGreaterThan(0);
      expect(level.anchor.length).toBeGreaterThan(0);
    }
  });

  it('leaves the axes to the ontology instead of inventing per-axis tolerances', () => {
    // The judge reads `ctx.brand.voice_attributes`, which the same discovery
    // run writes as a "we are / we are NOT" pair weighted by how firmly the
    // brand sits on the axis. The `axes` array that used to sit in params was
    // read by nothing — and it carried `target` and `tolerance` floats, which
    // is false precision for a voice inferred from one reading of a website.
    const rule = synthesizeCopyRules({ copy: copy({ voiceAxes: axes }), pageCount: 8 }).find(
      (r) => r.key === 'copy.voice-tone',
    );
    expect(rule?.check.params).toEqual({});
    // The axes still reach a human, in the rubric the judge is prompted with.
    expect(rule?.rubric?.question).toContain('Plain rather than Ornate');
  });
});

describe('synthesizeCopyRules — honesty in the support block', () => {
  it('marks the disclaimer rule down because legal never confirmed it', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ disclaimers: [{ text: 'Terms apply.', url: 'u', triggerCondition: null }] }),
      pageCount: 8,
    });
    const rule = rules.find((r) => r.key === 'copy.disclaimer-present');
    expect(rule?.support?.agreement).toBeLessThan(0.5);
    expect(rule?.support?.note).toContain('unconfirmed');
  });

  it('claims only presence, because presence is all the analyzer checks', () => {
    // The statement used to promise "present, legible and close to the claim
    // they qualify" while passing `minFontSizePt` and `minContrastRatio` to an
    // analyzer that reads neither — so a 5pt grey disclaimer passed a rule
    // whose own text promised to catch it.
    const rule = synthesizeCopyRules({
      copy: copy({ disclaimers: [{ text: 'Terms apply.', url: 'u', triggerCondition: null }] }),
      pageCount: 8,
    }).find((r) => r.key === 'copy.disclaimer-present');
    expect(rule?.statement).not.toMatch(/legib/i);
    expect(rule?.check.params).toEqual({ fuzzyThreshold: 85 });
  });

  it('says how many claims went unjudged', () => {
    const rules = synthesizeCopyRules({
      copy: copy({
        claims: [
          {
            text: 'Best in class.',
            url: 'u',
            triggers: ['best'],
            claimType: 'superlative',
            needsSubstantiation: true,
            suggestedEvidence: null,
            judged: false,
          },
        ],
      }),
      pageCount: 8,
    });
    expect(rules.find((r) => r.key === 'copy.claim-substantiation')?.rationale).toContain('could not be judged');
  });

  it('records the observed usage counts behind a lexicon rule', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ lexicon: [{ term: 'synergy', kind: 'banned', note: 'filler', uses: 7, pageCount: 4 }] }),
      pageCount: 8,
    });
    const observed = rules.find((r) => r.key === 'copy.banned-terms')?.support?.observed;
    expect(observed?.[0]).toMatchObject({ term: 'synergy', uses: 7, pages: 4 });
  });

  it('treats "avoid" as banned so the analyzer receives one vocabulary', () => {
    const rules = synthesizeCopyRules({
      copy: copy({ lexicon: [{ term: 'leverage', kind: 'avoid', note: null, uses: 3, pageCount: 2 }] }),
      pageCount: 8,
    });
    expect(rules.find((r) => r.key === 'copy.banned-terms')?.check.params.terms).toEqual(['leverage']);
  });

  it('produces unique rule keys', () => {
    const k = keys(
      synthesizeCopyRules({
        copy: copy({
          lexicon: [
            { term: 'a', kind: 'banned', note: null, uses: 3, pageCount: 2 },
            { term: 'b', kind: 'required', note: null, uses: 3, pageCount: 2 },
          ],
          claims: [
            {
              text: 'Best.',
              url: 'u',
              triggers: ['best'],
              claimType: 'superlative',
              needsSubstantiation: true,
              suggestedEvidence: null,
              judged: true,
            },
          ],
          disclaimers: [{ text: 'Terms apply.', url: 'u', triggerCondition: null }],
          readability: { metrics: { fleschKincaidGrade: 8 }, degraded: false, stats: { words: 900 } },
          voiceAxes: [
            { name: 'X', lowLabel: 'a', highLabel: 'b', value: 0.6, rationale: null, evidence: ['e'] },
          ],
        }),
        pageCount: 8,
      }),
    );
    expect(new Set(k).size).toBe(k.length);
    expect(k).toHaveLength(6);
  });
});
