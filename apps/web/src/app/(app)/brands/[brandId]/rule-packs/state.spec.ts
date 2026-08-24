import { describe, expect, it } from 'vitest';
import type { InheritedRule } from '@/lib/types';
import { filterRules, summarise } from './state';
import { ontologyPhrase } from './ontology-labels';

const rule = (over: Partial<InheritedRule> = {}): InheritedRule => ({
  templateId: 't1',
  templateVersion: 1,
  packKey: 'craft-logo',
  packName: 'Logo craft',
  packVersion: 1,
  key: 'logo.min-size',
  statement: 'The logo must occupy at least 4% of the canvas height.',
  rationale: null,
  dimension: 'logo',
  tier: 'cv',
  severity: 'minor',
  weight: 1,
  check: { fn: 'logo.min_size', params: { minHeightPct: 4 } },
  status: 'active',
  guidance: null,
  citation: null,
  needs: [],
  missingOntology: [],
  overriddenBy: null,
  drift: null,
  ...over,
});

describe('summarise — the headline must not flatter the brand', () => {
  it('counts a rule with everything it needs as running', () => {
    expect(summarise([rule()])).toMatchObject({ total: 1, running: 1, waiting: 0 });
  });

  it('does not count a rule waiting on missing ontology as running', () => {
    /*
     * The whole reason this screen exists. A rule whose ontology is empty
     * returns not_applicable — it never fails an asset, so on a dashboard it
     * is indistinguishable from a rule that passed. Counting it as "checking
     * this brand" would be a confidently reassuring lie.
     */
    const s = summarise([rule({ missingOntology: ['logo_variants'] })]);
    expect(s).toMatchObject({ running: 0, waiting: 1 });
    expect(s.missing).toEqual(['logo_variants']);
  });

  it('counts an overridden rule as overridden, not as running or waiting', () => {
    // The brand's own rule is what runs. Counting the shadowed baseline too
    // would double-count one check.
    const s = summarise([
      rule({ overriddenBy: { ruleId: 'r1', version: 2, status: 'active', forked: true } }),
    ]);
    expect(s).toMatchObject({ running: 0, waiting: 0, overridden: 1 });
  });

  it('prefers "overridden" over "waiting" when both are true', () => {
    // A rule the brand has replaced is not waiting on anything — the
    // replacement decides what happens, and telling somebody to go and upload
    // logos for a rule that no longer runs would send them nowhere useful.
    const s = summarise([
      rule({
        missingOntology: ['logo_variants'],
        overriddenBy: { ruleId: 'r1', version: 1, status: 'active', forked: false },
      }),
    ]);
    expect(s).toMatchObject({ overridden: 1, waiting: 0, running: 0 });
    expect(s.missing).toEqual([]);
  });

  it('counts drift independently of the other three states', () => {
    // A drifted rule is also overridden — it has a fork shadowing it — so
    // drift is reported alongside rather than instead.
    const s = summarise([
      rule({
        overriddenBy: { ruleId: 'r1', version: 1, status: 'active', forked: true },
        drift: { forkedFromVersion: 1, currentVersion: 3 },
      }),
    ]);
    expect(s).toMatchObject({ overridden: 1, drifted: 1 });
  });

  it('deduplicates and sorts what the brand is missing', () => {
    const s = summarise([
      rule({ templateId: 'a', missingOntology: ['type_styles', 'logo_variants'] }),
      rule({ templateId: 'b', missingOntology: ['logo_variants'] }),
    ]);
    expect(s.missing).toEqual(['logo_variants', 'type_styles']);
  });

  it('reports nothing at all for a brand with no packs enabled', () => {
    expect(summarise([])).toMatchObject({ total: 0, running: 0, waiting: 0, missing: [] });
  });
});

describe('filterRules', () => {
  const rules = [
    rule({ templateId: 'running', key: 'logo.min-size' }),
    rule({ templateId: 'waiting', key: 'logo.presence', missingOntology: ['logo_variants'] }),
    rule({
      templateId: 'overridden',
      key: 'copy.readability',
      dimension: 'copy',
      overriddenBy: { ruleId: 'r', version: 1, status: 'active', forked: false },
    }),
    rule({
      templateId: 'drifted',
      key: 'typography.min-size',
      dimension: 'typography',
      overriddenBy: { ruleId: 'r2', version: 1, status: 'active', forked: true },
      drift: { forkedFromVersion: 1, currentVersion: 2 },
    }),
  ];

  const ids = (result: InheritedRule[]) => result.map((r) => r.templateId);

  it('returns everything with no filters', () => {
    expect(filterRules(rules, { search: '', dimension: '', state: '' })).toHaveLength(4);
  });

  it('separates running from waiting', () => {
    expect(ids(filterRules(rules, { search: '', dimension: '', state: 'running' }))).toEqual(['running']);
    expect(ids(filterRules(rules, { search: '', dimension: '', state: 'waiting' }))).toEqual(['waiting']);
  });

  it('lists both overridden rules under overridden, and only the stale one under drifted', () => {
    expect(ids(filterRules(rules, { search: '', dimension: '', state: 'overridden' }))).toEqual([
      'overridden',
      'drifted',
    ]);
    expect(ids(filterRules(rules, { search: '', dimension: '', state: 'drifted' }))).toEqual(['drifted']);
  });

  it('filters by dimension', () => {
    expect(ids(filterRules(rules, { search: '', dimension: 'logo', state: '' }))).toEqual(['running', 'waiting']);
  });

  it('searches the key, the statement and the pack name', () => {
    expect(ids(filterRules(rules, { search: 'presence', dimension: '', state: '' }))).toEqual(['waiting']);
    expect(filterRules(rules, { search: 'logo craft', dimension: '', state: '' })).toHaveLength(4);
    expect(filterRules(rules, { search: 'canvas height', dimension: '', state: '' })).toHaveLength(4);
  });

  it('ignores case and surrounding whitespace in the search', () => {
    expect(ids(filterRules(rules, { search: '  PRESENCE ', dimension: '', state: '' }))).toEqual(['waiting']);
  });

  it('combines filters rather than treating them as alternatives', () => {
    expect(filterRules(rules, { search: 'presence', dimension: 'copy', state: '' })).toHaveLength(0);
  });
});

describe('ontologyPhrase — a sentence, not a list of identifiers', () => {
  it('turns engine attribute names into words somebody can act on', () => {
    expect(ontologyPhrase(['logo_variants'])).toBe('logo files');
    expect(ontologyPhrase(['logo_variants', 'type_styles'])).toBe('logo files and type styles');
  });

  it('caps a long list rather than naming ten things in a headline', () => {
    const many = ['logo_variants', 'type_styles', 'lexicon', 'claims', 'disclaimers'];
    expect(ontologyPhrase(many)).toBe('logo files, type styles, lexicon terms and 2 more');
  });

  it('honours a higher cap where the full list is short enough to read', () => {
    const many = ['logo_variants', 'type_styles', 'lexicon', 'claims'];
    expect(ontologyPhrase(many, 5)).toBe('logo files, type styles, lexicon terms and a claims register');
  });

  it('falls back to a readable form for an attribute it does not know', () => {
    // A new analyzer reading something new must not surface as `foo_bar`.
    expect(ontologyPhrase(['motion_tokens'])).toBe('motion tokens');
  });

  it('returns an empty string for nothing missing, so callers can skip the clause', () => {
    expect(ontologyPhrase([])).toBe('');
  });
});
