import { describe, expect, it } from 'vitest';
import {
  SPECIFICITY_WEIGHTS,
  compareRules,
  computeSpecificity,
  isWildcard,
  resolveByKey,
  scopeMatches,
  type ResolvableRule,
} from './specificity';

const ctx = { subBrand: 'retail', market: 'de-DE', channel: 'meta-feed', assetType: 'image', campaign: 'spring26' };

describe('computeSpecificity', () => {
  it('is 0 for a global rule', () => {
    expect(computeSpecificity({})).toBe(0);
    expect(computeSpecificity(null)).toBe(0);
    expect(computeSpecificity({ markets: [] })).toBe(0);
    expect(computeSpecificity({ markets: ['*'] })).toBe(0);
  });

  it('adds one axis weight per constrained axis', () => {
    expect(computeSpecificity({ markets: ['de-DE'] })).toBe(SPECIFICITY_WEIGHTS.markets);
    expect(computeSpecificity({ markets: ['de-DE'], channels: ['meta-feed'] })).toBe(
      SPECIFICITY_WEIGHTS.markets + SPECIFICITY_WEIGHTS.channels,
    );
  });

  it('does not reward listing more values on the same axis', () => {
    expect(computeSpecificity({ markets: ['de-DE'] })).toBe(computeSpecificity({ markets: ['de-DE', 'fr-FR', 'it-IT'] }));
  });

  it('orders the lattice global < sub-brand < market < channel < assetType < campaign', () => {
    const s = (scope: Parameters<typeof computeSpecificity>[0]) => computeSpecificity(scope);
    expect(s({})).toBeLessThan(s({ subBrands: ['x'] }));
    expect(s({ subBrands: ['x'] })).toBeLessThan(s({ markets: ['x'] }));
    expect(s({ markets: ['x'] })).toBeLessThan(s({ channels: ['x'] }));
    expect(s({ channels: ['x'] })).toBeLessThan(s({ assetTypes: ['x'] }));
    expect(s({ assetTypes: ['x'] })).toBeLessThan(s({ campaigns: ['x'] }));
  });

  it('makes a campaign rule beat every combination of less specific axes — the CSS property', () => {
    const everythingElse = computeSpecificity({
      subBrands: ['a'],
      markets: ['b'],
      channels: ['c'],
      assetTypes: ['d'],
    });
    expect(computeSpecificity({ campaigns: ['spring26'] })).toBeGreaterThan(everythingElse);
  });
});

describe('isWildcard', () => {
  it('treats absent, empty and ["*"] alike', () => {
    expect(isWildcard(undefined)).toBe(true);
    expect(isWildcard([])).toBe(true);
    expect(isWildcard(['*'])).toBe(true);
    expect(isWildcard(['de-DE'])).toBe(false);
    expect(isWildcard(['*', 'de-DE'])).toBe(false);
  });
});

describe('scopeMatches', () => {
  it('matches a global rule against anything', () => {
    expect(scopeMatches({}, ctx)).toBe(true);
    expect(scopeMatches({}, {})).toBe(true);
  });

  it('matches when the context value is listed', () => {
    expect(scopeMatches({ markets: ['de-DE', 'fr-FR'] }, ctx)).toBe(true);
  });

  it('does not match when the context value is absent from the list', () => {
    expect(scopeMatches({ markets: ['fr-FR'] }, ctx)).toBe(false);
  });

  it('requires EVERY constrained axis to match', () => {
    expect(scopeMatches({ markets: ['de-DE'], channels: ['tiktok'] }, ctx)).toBe(false);
    expect(scopeMatches({ markets: ['de-DE'], channels: ['meta-feed'] }, ctx)).toBe(true);
  });

  it('refuses to match a constrained axis the asset never populated', () => {
    // Treating an unknown market as "matches all" would fire German legal
    // rules on assets whose market was never set.
    expect(scopeMatches({ markets: ['de-DE'] }, { market: null })).toBe(false);
    expect(scopeMatches({ markets: ['de-DE'] }, {})).toBe(false);
    expect(scopeMatches({ markets: ['de-DE'] }, { market: '' })).toBe(false);
  });

  it('honours a wildcard axis', () => {
    expect(scopeMatches({ markets: ['*'] }, { market: null })).toBe(true);
  });
});

describe('resolveByKey — most-specific-wins', () => {
  const global: ResolvableRule = { key: 'logo.clearspace', version: 1, scope: {}, createdAt: new Date('2026-01-01') };
  const german: ResolvableRule = {
    key: 'logo.clearspace',
    version: 1,
    scope: { markets: ['de-DE'] },
    createdAt: new Date('2026-01-01'),
  };
  const campaign: ResolvableRule = {
    key: 'logo.clearspace',
    version: 1,
    scope: { campaigns: ['spring26'] },
    createdAt: new Date('2026-01-01'),
  };

  it('picks the more specific rule for a matching context', () => {
    const [winner] = resolveByKey([global, german], ctx);
    expect(winner).toBe(german);
  });

  it('falls back to the global rule when the specific one does not apply', () => {
    const [winner] = resolveByKey([global, german], { market: 'fr-FR' });
    expect(winner).toBe(global);
  });

  it('lets a campaign exemption beat a stack of lower-axis constraints', () => {
    const stacked: ResolvableRule = {
      key: 'logo.clearspace',
      version: 1,
      scope: { subBrands: ['retail'], markets: ['de-DE'], channels: ['meta-feed'], assetTypes: ['image'] },
      createdAt: new Date('2026-01-01'),
    };
    const [winner] = resolveByKey([stacked, campaign], ctx);
    expect(winner).toBe(campaign);
  });

  it('returns exactly one rule per key', () => {
    const resolved = resolveByKey([global, german, campaign], ctx);
    expect(resolved).toHaveLength(1);
  });

  it('keeps distinct keys side by side', () => {
    const other: ResolvableRule = { key: 'color.palette', version: 1, scope: {} };
    const resolved = resolveByKey([global, other], ctx);
    expect(resolved.map((r) => r.key)).toEqual(['color.palette', 'logo.clearspace']);
  });

  it('drops rules whose scope excludes the context entirely', () => {
    expect(resolveByKey([german], { market: 'fr-FR' })).toHaveLength(0);
  });

  it('is deterministic regardless of input order — the hash depends on it', () => {
    const a = resolveByKey([global, german, campaign], ctx);
    const b = resolveByKey([campaign, german, global], ctx);
    expect(a).toEqual(b);
  });

  it('prefers the newest version at equal specificity', () => {
    const v1 = { key: 'k', version: 1, scope: { markets: ['de-DE'] }, createdAt: new Date('2026-01-01') };
    const v2 = { key: 'k', version: 2, scope: { markets: ['de-DE'] }, createdAt: new Date('2026-01-01') };
    expect(resolveByKey([v1, v2], ctx)[0]).toBe(v2);
    expect(resolveByKey([v2, v1], ctx)[0]).toBe(v2);
  });

  it('breaks a version tie on createdAt, then deterministically', () => {
    const older = { key: 'k', version: 1, scope: { markets: ['de-DE'] }, createdAt: new Date('2026-01-01') };
    const newer = { key: 'k', version: 1, scope: { markets: ['de-DE', 'fr-FR'] }, createdAt: new Date('2026-06-01') };
    expect(resolveByKey([older, newer], ctx)[0]).toBe(newer);
  });

  it('respects a stored specificity override when present', () => {
    const stored = { key: 'k', version: 1, scope: {}, specificity: 99_999 };
    const computed = { key: 'k', version: 1, scope: { campaigns: ['spring26'] } };
    expect(resolveByKey([stored, computed], ctx)[0]).toBe(stored);
  });
});

describe('compareRules', () => {
  it('sorts more specific first', () => {
    const a: ResolvableRule = { key: 'k', version: 1, scope: { campaigns: ['x'] } };
    const b: ResolvableRule = { key: 'k', version: 1, scope: {} };
    expect(compareRules(a, b)).toBeLessThan(0);
    expect(compareRules(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 only for genuinely indistinguishable rules', () => {
    const a: ResolvableRule = { key: 'k', version: 1, scope: {}, createdAt: new Date('2026-01-01') };
    const b: ResolvableRule = { key: 'k', version: 1, scope: {}, createdAt: new Date('2026-01-01') };
    expect(compareRules(a, b)).toBe(0);
  });
});
