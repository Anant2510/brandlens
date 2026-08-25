import { hexToLab } from '@brandlens/api/common/color';
import type { DiscoveredColor, DiscoveredTypeStyle } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import type { BrandEnrichment } from './brand-enrichment';
import type { ImageCandidate } from './browser';
import { mergeEnrichment, providerCitation } from './enrichment-merge';

const color = (hex: string, role: string, coverage: number, pageCount: number): DiscoveredColor => ({
  hex,
  lab: hexToLab(hex)!,
  coverage,
  pageCount,
  role,
  citations: [{ url: 'https://acme.com/', selector: 'body', property: 'background-color' }],
});

const enrichment = (over: Partial<BrandEnrichment> = {}): BrandEnrichment => ({
  provider: 'brandfetch',
  domain: 'acme.com',
  name: 'Acme',
  description: 'We make everything.',
  colors: [{ hex: '#1946c8', role: 'primary', brightness: 0.4 }],
  fonts: [{ name: 'Inter', role: 'body' }],
  logos: [{ src: 'https://asset.brandfetch.io/acme/logo.svg', theme: 'light', format: 'svg', kind: 'logo', isVector: true }],
  links: [],
  industries: [],
  qualityScore: 0.8,
  ...over,
});

describe('mergeEnrichment', () => {
  it('adds a colour the crawl never saw as a zero-coverage candidate with provider provenance', () => {
    // The SPA case: the crawl found nothing, the provider knows the brand blue.
    const merged = mergeEnrichment([], [], [], enrichment());
    expect(merged.colors).toHaveLength(1);
    expect(merged.colors[0]).toMatchObject({ hex: '#1946c8', coverage: 0, pageCount: 0, role: 'primary' });
    expect(merged.colors[0].citations[0].url).toBe(providerCitation('brandfetch', 'acme.com'));
  });

  it('annotates a colour the crawl already measured instead of duplicating it', () => {
    // The provider's #1845c7 is within ΔE 3 of the crawled #1946c8 — the same
    // brand blue. It must corroborate, not create a second entry.
    const crawled = color('#1946c8', 'primary', 0.42, 6);
    const merged = mergeEnrichment([crawled], [], [], enrichment({ colors: [{ hex: '#1845c7', role: 'primary', brightness: 0.4 }] }));
    expect(merged.colors).toHaveLength(1);
    expect(merged.colors[0].coverage).toBe(0.42); // measured value preserved
    expect(merged.colors[0].citations.map((c) => c.url)).toContain(providerCitation('brandfetch', 'acme.com'));
  });

  it('never mutates the input arrays', () => {
    const crawled = [color('#1946c8', 'primary', 0.42, 6)];
    const before = crawled[0].citations.length;
    mergeEnrichment(crawled, [], [], enrichment());
    expect(crawled[0].citations.length).toBe(before);
  });

  it('adds a provider font the crawl did not observe, and skips one it did', () => {
    const crawled: DiscoveredTypeStyle[] = [
      { name: 'Body', fontFamily: 'Inter', fontWeight: 400, fontSizePx: 16, lineHeightPx: null, letterSpacingPx: null, role: 'body', occurrences: 12, citations: [] },
    ];
    const merged = mergeEnrichment([], crawled, [], enrichment({ fonts: [{ name: 'Inter', role: 'body' }, { name: 'Camphor', role: 'display' }] }));
    // Inter already known → not duplicated; Camphor is new → added.
    expect(merged.typeStyles.map((s) => s.fontFamily)).toEqual(['Inter', 'Camphor']);
    expect(merged.typeStyles[1].occurrences).toBe(0);
  });

  it('appends a provider logo below the crawl-detected ones and prefers vectors', () => {
    const detected: Array<ImageCandidate & { confidence: number }> = [
      { src: 'https://acme.com/header-logo.png', alt: 'Acme', selector: 'img', width: 180, height: 40, isVector: false, region: 'header', confidence: 0.9 },
    ];
    const merged = mergeEnrichment([], [], detected, enrichment());
    expect(merged.logos[0].confidence).toBe(0.9); // the crawl's mark stays on top
    const provided = merged.logos.find((l) => l.src.includes('brandfetch.io'));
    expect(provided).toMatchObject({ isVector: true, confidence: 0.6 });
  });
});
