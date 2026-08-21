import type { DiscoveredColor, DiscoveredTypeStyle } from '@brandlens/contracts';
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
  });

  it('names a real analyzer for every rule', () => {
    const registered = new Set([
      'color.palette_conformance',
      'color.dominance_ratio',
      'typography.approved_family',
      'typography.min_size',
      'typography.hierarchy',
      'accessibility.contrast',
      'logo.presence',
      'logo.clearspace',
    ]);
    for (const rule of synthesizeRules(base)) {
      expect(registered.has(rule.check.fn)).toBe(true);
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
    expect(keys(rules)).not.toContain('color.primary-presence');
  });

  it('proposes a palette rule once enough pages agree', () => {
    expect(keys(synthesizeRules(base))).toContain('color.palette-conformance');
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
    const families = rules.find((r) => r.key === 'typography.approved-family')?.check.params.families as string[];
    expect(families).toEqual(['Inter']);
  });

  it('skips the family rule when nothing crossed the threshold', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontFamily: 'unknown', occurrences: 99 })] });
    expect(keys(rules)).not.toContain('typography.approved-family');
  });
});

describe('synthesizeRules — refuses to codify the site’s own mistakes', () => {
  it('proposes the 12px legibility floor rather than the 9px the site uses', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 9, role: 'caption' })] });
    const rule = rules.find((r) => r.key === 'typography.min-size');
    expect(rule?.check.params.minPx).toBe(12);
    expect(rule?.rationale).toContain('below the 12px');
  });

  it('gives legal copy its own floor instead of ignoring it', () => {
    // Caught by the end-to-end test: a 9px footer disclaimer is classified
    // 'legal', so a rule that only looked at body/caption never saw the one
    // place illegibly small type actually appears.
    const rules = synthesizeRules({
      ...base,
      typeStyles: [type({ fontSizePx: 16, role: 'body' }), type({ fontSizePx: 9, role: 'legal' })],
    });
    expect(rules.find((r) => r.key === 'typography.min-size')?.check.params.minPx).toBe(16);
    expect(rules.find((r) => r.key === 'typography.min-size-legal')?.check.params.minPx).toBe(12);
  });

  it('says plainly when the site itself violates the floor it proposes', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 9, role: 'legal' })] });
    expect(rules.find((r) => r.key === 'typography.min-size-legal')?.support?.note).toContain('currently violates');
  });

  it('keeps the site’s own floor when it is already above the minimum', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ fontSizePx: 14, role: 'body' })] });
    expect(rules.find((r) => r.key === 'typography.min-size')?.check.params.minPx).toBe(14);
  });

  it('emits no legal rule when the site has no legal copy', () => {
    const rules = synthesizeRules({ ...base, typeStyles: [type({ role: 'body' })] });
    expect(rules.map((r) => r.key)).not.toContain('typography.min-size-legal');
  });

  it('still proposes AA contrast when the site currently fails it, and says so', () => {
    const rule = synthesizeRules({ ...base, contrastFailures: 23 }).find((r) => r.key === 'accessibility.contrast');
    expect(rule?.check.params.minRatio).toBe(4.5);
    expect(rule?.rationale).toContain('23');
    expect(rule?.rationale).toContain('does not currently meet');
  });
});

describe('synthesizeRules — honesty about weak inferences', () => {
  it('marks the clear-space default as low-agreement rather than dressing it as measured', () => {
    const rule = synthesizeRules(base).find((r) => r.key === 'logo.clearspace');
    expect(rule?.support?.agreement).toBeLessThan(0.5);
    expect(rule?.support?.note).toContain('not measured');
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
