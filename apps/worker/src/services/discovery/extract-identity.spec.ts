import { describe, expect, it } from 'vitest';
import type { ImageCandidate, PaintedColor, TextRun } from './browser';
import {
  bucketSize,
  chroma,
  extractPalette,
  extractTypeStyles,
  findContrastFailures,
  parseCssColor,
  primaryFontFamily,
  rankLogoCandidates,
  toHex,
} from './extract-identity';

const paint = (color: string, area: number, over: Partial<PaintedColor> = {}): PaintedColor => ({
  color,
  property: 'background-color',
  selector: 'div.x',
  area,
  ...over,
});

const run = (over: Partial<TextRun> = {}): TextRun => ({
  selector: 'p',
  text: 'Some copy',
  fontFamily: '"Inter", sans-serif',
  fontSizePx: 16,
  fontWeight: 400,
  lineHeightPx: 24,
  letterSpacingPx: 0,
  textTransform: 'none',
  color: 'rgb(0, 0, 0)',
  backgroundColor: 'rgb(255, 255, 255)',
  role: 'body',
  bbox: { x: 0, y: 0, width: 100, height: 20 },
  ...over,
});

describe('parseCssColor', () => {
  it('parses what a browser computed style actually emits', () => {
    expect(parseCssColor('rgb(18, 52, 86)')).toEqual({ rgb: [18, 52, 86], alpha: 1 });
    expect(parseCssColor('rgba(18, 52, 86, 0.5)')).toEqual({ rgb: [18, 52, 86], alpha: 0.5 });
    expect(parseCssColor('rgb(18 52 86 / 50%)')).toEqual({ rgb: [18, 52, 86], alpha: 0.5 });
  });

  it('parses hex in all its lengths', () => {
    expect(parseCssColor('#123456')?.rgb).toEqual([18, 52, 86]);
    expect(parseCssColor('#abc')?.rgb).toEqual([170, 187, 204]);
    expect(parseCssColor('#12345680')?.alpha).toBeCloseTo(0.502, 2);
  });

  it('returns null for the non-colours a computed style also emits', () => {
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor('none')).toBeNull();
    expect(parseCssColor('currentcolor')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('url(#grad)')).toBeNull();
  });

  it('rejects out-of-range channels rather than clamping them silently', () => {
    expect(parseCssColor('rgb(300, 0, 0)')).toBeNull();
  });
});

describe('toHex / chroma', () => {
  it('round-trips', () => {
    expect(toHex([18, 52, 86])).toBe('#123456');
  });

  it('treats greys as achromatic and brand colours as not', () => {
    expect(chroma([50, 0, 0])).toBeLessThan(8);
    expect(chroma([50, 40, -30])).toBeGreaterThan(8);
  });
});

describe('extractPalette', () => {
  it('weights by painted area, not by how often a colour is declared', () => {
    // Green is declared once over a huge area; red forty times over slivers.
    const colors = [paint('rgb(0, 128, 0)', 900_000), ...Array.from({ length: 40 }, () => paint('rgb(255, 0, 0)', 100))];
    const palette = extractPalette([{ url: 'https://acme.com/', colors }]);
    expect(palette[0].hex).toBe('#008000');
  });

  it('merges near-identical shades into one brand colour', () => {
    // Anti-aliasing and hover states produce a spray of near-identical values.
    const colors = [
      paint('rgb(0, 100, 200)', 1000),
      paint('rgb(1, 101, 201)', 900),
      paint('rgb(0, 99, 199)', 800),
      paint('rgb(2, 100, 200)', 700),
    ];
    const palette = extractPalette([{ url: 'https://acme.com/', colors }]);
    expect(palette).toHaveLength(1);
    expect(palette[0].coverage).toBeCloseTo(1, 3);
  });

  it('keeps genuinely different colours apart', () => {
    const palette = extractPalette([
      { url: 'https://acme.com/', colors: [paint('rgb(0, 100, 200)', 1000), paint('rgb(200, 30, 40)', 1000)] },
    ]);
    expect(palette).toHaveLength(2);
  });

  it('counts the pages a colour appears on, so a one-page fluke is visible', () => {
    const palette = extractPalette([
      { url: 'https://acme.com/', colors: [paint('rgb(0, 100, 200)', 1000)] },
      { url: 'https://acme.com/about', colors: [paint('rgb(0, 100, 200)', 1000)] },
      { url: 'https://acme.com/blog', colors: [paint('rgb(240, 90, 10)', 1000)] },
    ]);
    const brand = palette.find((c) => c.hex === '#0064c8');
    const fluke = palette.find((c) => c.hex === '#f05a0a');
    expect(brand?.pageCount).toBe(2);
    expect(fluke?.pageCount).toBe(1);
  });

  it('ignores near-transparent paint', () => {
    const palette = extractPalette([
      { url: 'https://acme.com/', colors: [paint('rgba(0, 0, 255, 0.05)', 100_000), paint('rgb(0, 128, 0)', 500)] },
    ]);
    expect(palette).toHaveLength(1);
    expect(palette[0].hex).toBe('#008000');
  });

  it('names white the background and the chromatic colour the primary', () => {
    const palette = extractPalette([
      {
        url: 'https://acme.com/',
        colors: [
          paint('rgb(255, 255, 255)', 1_000_000),
          paint('rgb(0, 90, 60)', 120_000),
          paint('rgb(20, 20, 20)', 4_000, { property: 'color' }),
        ],
      },
    ]);
    expect(palette.find((c) => c.hex === '#ffffff')?.role).toBe('background');
    expect(palette.find((c) => c.hex === '#005a3c')?.role).toBe('primary');
    expect(palette.find((c) => c.hex === '#141414')?.role).toBe('text');
  });

  it('returns Lab coordinates, since ΔE is what conformance is measured in', () => {
    const palette = extractPalette([{ url: 'https://acme.com/', colors: [paint('rgb(255, 255, 255)', 100)] }]);
    expect(palette[0].lab[0]).toBeCloseTo(100, 0);
  });

  it('survives a page with no usable colours', () => {
    expect(extractPalette([{ url: 'https://acme.com/', colors: [] }])).toEqual([]);
    expect(extractPalette([])).toEqual([]);
  });
});

describe('bucketSize', () => {
  it('snaps rem arithmetic noise onto one step', () => {
    expect(bucketSize(15.008)).toBe(16);
    expect(bucketSize(16.002)).toBe(16);
    expect(bucketSize(15.6)).toBe(16);
  });

  it('keeps distinct scale steps distinct', () => {
    expect(bucketSize(24)).toBe(24);
    expect(bucketSize(28)).toBe(28);
  });

  it('does not clamp an oversized hero headline down to the scale', () => {
    expect(bucketSize(200)).toBe(200);
  });
});

describe('primaryFontFamily', () => {
  it('takes the first family and drops the fallbacks', () => {
    expect(primaryFontFamily('"Inter", -apple-system, sans-serif')).toBe('Inter');
    expect(primaryFontFamily("'Helvetica Neue', Arial")).toBe('Helvetica Neue');
    expect(primaryFontFamily('system-ui')).toBe('system-ui');
    expect(primaryFontFamily('')).toBe('unknown');
  });
});

describe('extractTypeStyles', () => {
  it('collapses rem noise into a single body style', () => {
    const runs = [run({ fontSizePx: 16 }), run({ fontSizePx: 16.002 }), run({ fontSizePx: 15.99 })];
    const styles = extractTypeStyles([{ url: 'https://acme.com/', runs }]);
    expect(styles).toHaveLength(1);
    expect(styles[0].occurrences).toBe(3);
    expect(styles[0].fontSizePx).toBe(16);
  });

  it('separates styles that differ by role', () => {
    const styles = extractTypeStyles([
      { url: 'https://acme.com/', runs: [run({ role: 'body' }), run({ role: 'button' })] },
    ]);
    expect(styles).toHaveLength(2);
  });

  it('normalises weights to the three tiers a brand book distinguishes', () => {
    const styles = extractTypeStyles([
      { url: 'https://acme.com/', runs: [run({ fontWeight: 600 }), run({ fontWeight: 700 })] },
    ]);
    expect(styles).toHaveLength(1);
    expect(styles[0].fontWeight).toBe(700);
  });

  it('takes the median line height rather than the last one seen', () => {
    const styles = extractTypeStyles([
      {
        url: 'https://acme.com/',
        runs: [run({ lineHeightPx: 20 }), run({ lineHeightPx: 24 }), run({ lineHeightPx: 28 })],
      },
    ]);
    expect(styles[0].lineHeightPx).toBe(24);
  });

  it('orders by how much the style is actually used', () => {
    const runs = [
      ...Array.from({ length: 10 }, () => run({ role: 'body' })),
      run({ role: 'display', fontSizePx: 48 }),
    ];
    const styles = extractTypeStyles([{ url: 'https://acme.com/', runs }]);
    expect(styles[0].role).toBe('body');
  });

  it('carries a citation so every style can be traced back to a page', () => {
    const styles = extractTypeStyles([{ url: 'https://acme.com/pricing', runs: [run({ selector: 'h1.hero' })] }]);
    expect(styles[0].citations[0]).toEqual({ url: 'https://acme.com/pricing', selector: 'h1.hero' });
  });

  it('ignores empty text nodes', () => {
    expect(extractTypeStyles([{ url: 'https://acme.com/', runs: [run({ text: '   ' })] }])).toEqual([]);
  });
});

describe('rankLogoCandidates', () => {
  const img = (over: Partial<ImageCandidate> = {}): ImageCandidate => ({
    src: 'https://acme.com/a.png',
    alt: null,
    selector: 'img',
    width: 140,
    height: 40,
    isVector: false,
    region: 'header',
    ...over,
  });

  it('ranks explicit markup evidence above mere position', () => {
    const ranked = rankLogoCandidates([
      img({ src: 'https://acme.com/promo-banner.png', region: 'header' }),
      img({ src: 'https://acme.com/acme-logo.svg', isVector: true, region: 'content' }),
    ]);
    expect(ranked[0].src).toContain('logo');
  });

  it('reads the alt text', () => {
    const ranked = rankLogoCandidates([img({ region: 'content' }), img({ alt: 'Acme logo', region: 'content' })]);
    expect(ranked[0].alt).toBe('Acme logo');
  });

  it('demotes payment badges and flags that also live in headers', () => {
    const ranked = rankLogoCandidates([
      img({ src: 'https://acme.com/brand-wordmark.svg' }),
      img({ src: 'https://acme.com/payment-visa.png' }),
    ]);
    expect(ranked[0].src).toContain('wordmark');
    expect(ranked[1].confidence).toBeLessThan(ranked[0].confidence);
  });

  it('demotes anything hero-sized', () => {
    const ranked = rankLogoCandidates([img(), img({ width: 1440, height: 600 })]);
    expect(ranked[0].width).toBe(140);
  });

  it('keeps confidence inside 0..1', () => {
    for (const c of rankLogoCandidates([img({ src: 'logo-logo-logo.svg', alt: 'logo', isVector: true })])) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('findContrastFailures', () => {
  it('flags grey-on-white body copy', () => {
    const fails = findContrastFailures([
      { url: 'https://acme.com/', runs: [run({ color: 'rgb(170, 170, 170)', backgroundColor: 'rgb(255,255,255)' })] },
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0].ratio).toBeLessThan(4.5);
    expect(fails[0].required).toBe(4.5);
  });

  it('passes black on white', () => {
    expect(findContrastFailures([{ url: 'https://acme.com/', runs: [run()] }])).toEqual([]);
  });

  // #8c8c8c on white is 3.36:1 — the only interesting band, because it sits
  // between the large-text threshold (3.0) and the body threshold (4.5). A
  // greyer value fails both and proves nothing about the size rule.
  const BORDERLINE_GREY = { color: 'rgb(140, 140, 140)', backgroundColor: 'rgb(255,255,255)' };

  it('applies the relaxed threshold to large text, as WCAG does', () => {
    const grey = BORDERLINE_GREY;
    expect(findContrastFailures([{ url: 'u', runs: [run({ ...grey, fontSizePx: 16 })] }])).toHaveLength(1);
    expect(findContrastFailures([{ url: 'u', runs: [run({ ...grey, fontSizePx: 24 })] }])).toHaveLength(0);
  });

  it('treats 18.66px bold as large, but 18.66px regular as body', () => {
    const grey = BORDERLINE_GREY;
    expect(findContrastFailures([{ url: 'u', runs: [run({ ...grey, fontSizePx: 18.66, fontWeight: 700 })] }])).toHaveLength(0);
    expect(findContrastFailures([{ url: 'u', runs: [run({ ...grey, fontSizePx: 18.66, fontWeight: 400 })] }])).toHaveLength(1);
  });

  it('reports the worst failures first', () => {
    const fails = findContrastFailures([
      {
        url: 'u',
        runs: [
          run({ color: 'rgb(160,160,160)', backgroundColor: 'rgb(255,255,255)' }),
          run({ color: 'rgb(230,230,230)', backgroundColor: 'rgb(255,255,255)' }),
        ],
      },
    ]);
    expect(fails[0].ratio).toBeLessThan(fails[1].ratio);
  });
});
