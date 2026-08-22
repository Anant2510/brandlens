import type { DiscoveredColor, DiscoveredTypeStyle } from '@brandlens/contracts';
import { customerOntology, describeCheckDrift, formatCheckDrift } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import { synthesizeRules } from './synthesize-rules';

const color = (over: Partial<DiscoveredColor> = {}): DiscoveredColor => ({
  hex: '#005a3c',
  lab: [33, -30, 15],
  coverage: 0.2,
  pageCount: 6,
  role: 'primary',
  citations: [],
  ...over,
});

const type = (over: Partial<DiscoveredTypeStyle> = {}): DiscoveredTypeStyle => ({
  name: 'body/16',
  fontFamily: 'Inter',
  fontWeight: 400,
  fontSizePx: 16,
  lineHeightPx: 24,
  letterSpacingPx: 0,
  role: 'body',
  occurrences: 40,
  citations: [],
  ...over,
});

const base = {
  colors: [color(), color({ hex: '#ffffff', role: 'background', lab: [100, 0, 0] })],
  typeStyles: [type()],
  pageCount: 8,
  logoDetected: true,
  contrastFailures: 0,
};

const keys = (rules: { key: string }[]) => rules.map((r) => r.key);

describe('synthesizeRules — governance invariants', () => {
  it('proposes every rule and activates none', () => {
    // The single most important property in this file. A discovery tool that
    // silently activated rules would enforce whatever the site got wrong.
    for (const rule of synthesizeRules(base)) {
      expect(rule.status).toBe('proposed');
    }
  });

  it('attaches support evidence to every rule', () => {
    for (const rule of synthesizeRules(base)) {
      expect(rule.support).toBeTruthy();
      expect(rule.support?.sampleSize).toBeGreaterThan(0);
    }
  });

  it('labels measured rules inductive and imported standards transfer', () => {
    const rules = synthesizeRules(base);
    expect(rules.find((r) => r.key === 'typography.approved-family')?.provenance).toBe('inductive');
    // WCAG is not something the site taught us; claiming otherwise would
    // misrepresent where the threshold came from.
    expect(rules.find((r) => r.key === 'accessibility.contrast')?.provenance).toBe('transfer');
    expect(rules.find((r) => r.key === 'accessibility.font-size-floor')?.provenance).toBe('transfer');
  });
});

describe('synthesizeRules — every parameter reaches the engine', () => {
  /*
   * This replaced a test that checked `check.fn` against a hand-written set of
   * names. It passed throughout, while six of the eight rules in this file
   * carried parameter keys no analyzer reads — `minPx`, `minConfidence`,
   * `multiple`, `minRatio`, `families`, `hex`. Each one displayed a threshold
   * in the console and enforced the analyzer's default instead. The name of
   * the function was never the risky half.
   */
  const everyInput = [
    base,
    { ...base, typeStyles: [type({ fontSizePx: 9, role: 'legal' })] },
    { ...base, logoDetected: false, contrastFailures: 23 },
    { colors: [], typeStyles: [], pageCount: 0, logoDetected: false, contrastFailures: 0 },
  ];

  it('names an analyzer that exists and passes it only keys it reads', () => {
    for (const input of everyInput) {
      for (const rule of synthesizeRules(input)) {
        const drift = describeCheckDrift(rule.check.fn, rule.check.params);
        // Rendered rather than asserted as a boolean: on failure the message
        // names the dead key, the key that was probably meant, and the value
        // the engine used instead.
        expect(drift ? formatCheckDrift(drift, rule.key) : null).toBeNull();
      }
    }
  });

  it('proposes nothing that needs ontology this run does not write', () => {
    // A rule reading an ontology attribute discovery never populates returns
    // not_applicable forever: present in the console, green, and inert.
    const written = new Set(['color_tokens', 'type_styles', 'logo_variants', 'forbidden_fonts']);
    for (const rule of synthesizeRules(base)) {
      for (const need of customerOntology(rule.check.fn)) {
        expect({ rule: rule.key, needsOntology: need, written: written.has(need) }).toMatchObject({
          written: true,
        });
      }
    }
  });
});

describe('synthesizeRules — evidence thresholds', () => {
  it('ignores colours seen on too few pages', () => {
    const rules = synthesizeRules({
      ...base,
      colors: [color({ pageCount: 1 }), color({ hex: '#ffffff', role: 'background', pageCount: 1 })],
    });
    expect(keys(rules)).not.toContain('color.palette-conformance');
  });

  it('proposes a palette rule once enough pages agree', () => {
    expect(keys(synthesizeRules(base))).toContain('color.palette-conformance');
  });

  it('never proposes a colour dominance rule from a website crawl', () => {
    // `color.dominance_ratio` compares the primary/secondary/accent MIX against
    // a declared split. A homepage's paint ratios are not a creative's, so the
    // site cannot evidence that number — and the rule it used to back read as
    // "the primary colour should be present", which is a different claim.
    for (const rule of synthesizeRules(base)) {
      expect(rule.check.fn).not.toBe('color.dominance_ratio');
    }
  });

  it('never drops the corroboration floor below two pages, even on a tiny crawl', () => {
    const rules = synthesizeRules({
      ...base,
      pageCount: 1,
      colors: [color({ pageCount: 1 }), color({ hex: '#fff', role: 'background', pageCount: 1 })],
    });
    expect(keys(rules)).not.toContain('color.palette-conformance');
  });

  it('ignores a font family used only by an embedded widget', () => {
    const rules = synthesizeRules({
      ...base,
      typeStyles: [type({ fontFamily: 'Inter', occurrences: 40 }), type({ fontFamily: 'WidgetSans', occurrences: 2 })],
    });
    // The families reach the analyzer through the ontology's type styles, not
    // through params, so the rule's own text is where they are asserted.
    expect(rules.find((r) => r.key === 'typography.approved-family')?.statement).toContain('Inter');
    expect(rules.find((r) => r.key === 'typography.approved-family')?.statement).not.toContain('WidgetSans');
  });

  it('skips the family rule when nothing crossed the threshold', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontFamily: 'unknown', occurrences: 99 })] });
    expect(keys(rules)).not.toContain('typography.approved-family');
  });
});

describe('synthesizeRules — size floors', () => {
  /*
   * Two analyzers, two jobs. `typography.min_size` holds creative to the
   * brand's per-style scale, which lives in the ontology; its only parameter is
   * a single global floor that would override every style at once. The
   * absolute "nobody can read this" line is `accessibility.font_size_floor`,
   * which reads no ontology at all.
   */
  it('lets the ontology carry the per-style floors instead of one global number', () => {
    const rule = synthesizeRules({
      ...base,
      typeStyles: [type({ fontSizePx: 16, role: 'body' }), type({ fontSizePx: 9, role: 'legal' })],
    }).find((r) => r.key === 'typography.min-size');
    expect(rule?.check.params).toEqual({});
    // The floors are still evidenced — in support, where a reviewer reads them.
    expect(rule?.support?.observed).toEqual([
      { style: 'body/16', role: 'body', floorPx: 16 },
      { style: 'body/16', role: 'legal', floorPx: 9 },
    ]);
  });

  it('proposes the absolute legibility floor in points, the unit the engine measures in', () => {
    const rule = synthesizeRules(base).find((r) => r.key === 'accessibility.font-size-floor');
    // 12px at 96dpi is 9pt. The old rule passed 12 under a key called `minPx`;
    // renaming it to `minSizePt` without converting would have demanded 16px.
    expect(rule?.check.params.minSizePt).toBe(9);
    expect(rule?.statement).toContain('12px');
  });

  it('covers legal copy through the absolute floor rather than a band of its own', () => {
    // Caught originally by the end-to-end test: a 9px footer disclaimer is
    // classified 'legal', and a body-only rule never saw the one place
    // illegibly small type actually appears. A second `typography.min_size`
    // rule cannot express that — the analyzer has no per-role parameter — so
    // the absolute floor is what catches it.
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 9, role: 'legal' })] });
    expect(keys(rules)).toContain('accessibility.font-size-floor');
    expect(keys(rules)).not.toContain('typography.min-size-legal');
  });

  it('says plainly when the site itself violates the floor it proposes', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 9, role: 'legal' })] });
    expect(rules.find((r) => r.key === 'accessibility.font-size-floor')?.support?.note).toContain(
      'currently violates',
    );
  });

  it('still proposes the floor when the site already clears it', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 14, role: 'body' })] });
    const rule = rules.find((r) => r.key === 'accessibility.font-size-floor');
    expect(rule?.rationale).toContain('already at or above');
  });

  it('proposes no size rules at all when no type was measured', () => {
    const rules = keys(synthesizeRules({ ...base, typeStyles: [] }));
    expect(rules).not.toContain('typography.min-size');
    expect(rules).not.toContain('accessibility.font-size-floor');
  });
});

describe('synthesizeRules — refuses to codify the site’s own mistakes', () => {
  it('still proposes AA contrast when the site currently fails it, and says so', () => {
    const rule = synthesizeRules({ ...base, contrastFailures: 23 }).find((r) => r.key === 'accessibility.contrast');
    expect(rule?.rationale).toContain('23');
    expect(rule?.rationale).toContain('does not currently meet');
  });

  it('lets WCAG set the per-run threshold instead of pinning one ratio', () => {
    // `minRatio` applies one number to every run regardless of size, so 4.5
    // would fail large headlines that WCAG passes at 3:1 — a rule stricter
    // than the statement printed beside it.
    const rule = synthesizeRules(base).find((r) => r.key === 'accessibility.contrast');
    expect(rule?.check.params).toEqual({ level: 'AA' });
    expect(rule?.statement).toContain('3:1 for large text');
  });
});

describe('synthesizeRules — honesty about weak inferences', () => {
  it('marks the clear-space default as low-agreement rather than dressing it as measured', () => {
    const rule = synthesizeRules(base).find((r) => r.key === 'logo.clearspace');
    expect(rule?.support?.agreement).toBeLessThan(0.5);
    expect(rule?.support?.note).toContain('not measured');
  });

  it('sends the clear-space multiple under the key the analyzer reads', () => {
    const rule = synthesizeRules(base).find((r) => r.key === 'logo.clearspace');
    expect(rule?.check.params).toEqual({ clearSpaceMultiple: 0.5, basis: 'height' });
  });

  it('requires a real match score for logo presence, not any detection at all', () => {
    // The analyzer's default `minScore` is 0.0, so the old `minConfidence` key
    // meant the weakest possible match satisfied a blocker-severity rule.
    const rule = synthesizeRules(base).find((r) => r.key === 'logo.presence');
    expect(rule?.check.params.minScore).toBe(0.6);
  });

  it('omits logo rules entirely when no logo was found', () => {
    const rules = keys(synthesizeRules({ ...base, logoDetected: false }));
    expect(rules).not.toContain('logo.presence');
    expect(rules).not.toContain('logo.clearspace');
  });

  it('makes logo presence a blocker but clear space only a minor', () => {
    const rules = synthesizeRules(base);
    expect(rules.find((r) => r.key === 'logo.presence')?.severity).toBe('blocker');
    expect(rules.find((r) => r.key === 'logo.clearspace')?.severity).toBe('minor');
  });
});

describe('synthesizeRules — degenerate inputs', () => {
  it('returns only the imported standard when the site yielded nothing', () => {
    const rules = synthesizeRules({
      colors: [],
      typeStyles: [],
      pageCount: 0,
      logoDetected: false,
      contrastFailures: 0,
    });
    expect(keys(rules)).toEqual(['accessibility.contrast']);
  });

  it('produces unique rule keys', () => {
    const k = keys(synthesizeRules(base));
    expect(new Set(k).size).toBe(k.length);
  });
});
