import { CHANNEL_SPEC_KEYS, formatSpecDrift, specKeyContract } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import { SEED_CHANNEL_SPECS } from './channel-specs.js';
import { channelSpecProblems } from './validate.js';

const specs = SEED_CHANNEL_SPECS.map((row) => ({
  where: `${row.platform}/${row.placement} (${row.assetType})`,
  spec: row.spec,
}));

describe('the shipped channel spec registry', () => {
  it('publishes nothing the engine does not account for', () => {
    /*
     * The registry is data and the analyzer is code, and for a while they
     * shared three keys out of forty: the Meta Story row published safe zones,
     * the A4 row published 3mm of bleed and a 300% ink limit, and
     * `channel_spec.conformance` read none of them. Nothing failed. The rule
     * was severity `blocker`, it ran on every asset, and it checked minimum
     * width, minimum height and DPI.
     *
     * A key here has to be ACCOUNTED for, not necessarily enforced — there is
     * no video decoder in this engine and `fps` says so — but the difference
     * between "not enforced, and here is why" and silence is the whole point.
     */
    expect(channelSpecProblems()).toEqual([]);
  });

  it('reports a key nobody reads rather than ignoring it', () => {
    // The guard above only means something if it can fail.
    const message = formatSpecDrift({ minWidth: 600, maxTextOverlayPct: 20 }, 'invented/placement');
    expect(message).toContain('maxTextOverlayPct');
    expect(message).toContain('constrain nothing');
    expect(formatSpecDrift({ minWidth: 600 }, 'invented/placement')).toBeNull();
  });

  it('says who enforces every key it does not enforce itself', () => {
    for (const [key, entry] of Object.entries(CHANNEL_SPEC_KEYS)) {
      if (entry.role === 'delegated' || entry.role === 'authorable') {
        expect({ key, by: entry.by }).not.toMatchObject({ by: '' });
      }
      if (entry.role !== 'enforced') {
        // Without a reason the verdict tells a reader a constraint was skipped
        // and gives them nothing to do about it.
        expect({ key, hasDetail: entry.detail.length > 20 }).toMatchObject({ hasDetail: true });
      }
    }
  });

  it('enforces the print and social keys the registry exists to carry', () => {
    // Named individually because these are the ones customers buy the registry
    // for. A regression that quietly downgraded any of them to `unmeasurable`
    // would still pass every other test in this file.
    for (const key of ['bleedMm', 'trimSize', 'totalInkCoverageMaxPct', 'requiresCropMarks']) {
      expect({ key, role: specKeyContract(key)?.role }).toMatchObject({ role: 'enforced' });
    }
    expect(specKeyContract('safeZones')).toMatchObject({ role: 'delegated', by: 'layout.safe_zone' });
    expect(specKeyContract('minLegalFontPx')).toMatchObject({ role: 'delegated', by: 'typography.min_size' });
  });

  it('gives every spec the reference size its pixel figures are quoted at', () => {
    // Safe zones are published in pixels — TikTok's caption bar is 310 of the
    // 1920 on a Story canvas. Without `referenceSize` there is no denominator,
    // and the zones silently become unusable rather than wrong.
    for (const { where, spec } of specs) {
      const hasPixelFigures = 'safeZones' in spec || 'minLegalFontPx' in spec;
      if (!hasPixelFigures) continue;
      expect({ where, referenceSize: Boolean(spec.referenceSize) }).toMatchObject({ referenceSize: true });
    }
  });

  it('gives every print spec what the bleed check needs', () => {
    for (const { where, spec } of specs) {
      if (!('bleedMm' in spec)) continue;
      // Bleed is a distance beyond the trim. Without a trim size there is
      // nothing to measure it from and the check can only report that.
      expect({ where, trimSize: Boolean(spec.trimSize) }).toMatchObject({ trimSize: true });
    }
  });
});
