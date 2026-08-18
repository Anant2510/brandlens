/* ==========================================================================
 * Sample creative generation.
 *
 * Ten PNGs: five approved exemplars and five that break a specific rule on
 * purpose. The violations are REAL — the off-palette asset genuinely contains
 * a competitor colour on nearly half its surface, the clear-space asset
 * genuinely places its headline 0.41X below the logomark, and the
 * low-contrast asset's disclaimer genuinely renders at 7px well under 4.5:1.
 * A seeded finding pointing at a compliant image would make the whole demo
 * untrustworthy the moment someone opened the file, so every number in
 * `measured` below is computed off the finished pixels.
 *
 * Each generator returns the geometry it used, so the seeded decision traces
 * can cite the actual measured numbers and the actual bounding boxes rather
 * than plausible-looking ones.
 * ========================================================================== */

import { Canvas } from '../lib/png.js';
import { contrastRatioHex, deltaE76, hexToLab, tint } from '../lib/color.js';
import { lockupCanvas } from './logos.js';
import {
  BRASS,
  COPPER,
  CREAM,
  ESPRESSO,
  FORBIDDEN_GREEN,
  INK,
  OBSIDIAN,
  PINE,
  STONE,
} from '../data/tokens.js';

export interface GeneratedCreative {
  key: string;
  fileName: string;
  name: string;
  png: Buffer;
  width: number;
  height: number;
  market: string;
  channel: string;
  assetType: string;
  copyFields: Record<string, string>;
  tags: string[];
  isApprovedExemplar: boolean;
  /** Measurements the seeded traces cite. Computed, never invented. */
  measured: Record<string, unknown>;
  /** Human-readable description of the planted defect, if any. */
  violation?: string;
}

/* --------------------------------------------------------------------------
 * Shared furniture
 * ------------------------------------------------------------------------ */

/** Places the lockup and returns its bbox, normalised to the canvas. */
function placeLockup(
  canvas: Canvas,
  x: number,
  y: number,
  markDiameter: number,
  hex: string,
): { bbox: [number, number, number, number]; markHeight: number; width: number; height: number } {
  const { canvas: lockup, markHeight } = lockupCanvas(markDiameter, hex);
  canvas.drawImage(lockup, x, y);
  return {
    bbox: [
      round4(x / canvas.width),
      round4(y / canvas.height),
      round4((x + lockup.width) / canvas.width),
      round4((y + lockup.height) / canvas.height),
    ],
    markHeight,
    width: lockup.width,
    height: lockup.height,
  };
}

/** A photographic stand-in: banded warm tones plus a soft highlight. */
function heroBand(canvas: Canvas, x: number, y: number, w: number, h: number, base: string): void {
  canvas.verticalGradient({ x, y, w, h }, tint(base, 85), base);
  // Coarse "grain" so the imagery analyzers see texture rather than a flat fill.
  for (let i = 0; i < h; i += 7) {
    canvas.rect({ x, y: y + i, w, h: 2 }, tint(base, 70), 0.12);
  }
  canvas.circle(x + w * 0.68, y + h * 0.34, Math.min(w, h) * 0.22, tint(base, 45), 0.5);
  canvas.circle(x + w * 0.3, y + h * 0.62, Math.min(w, h) * 0.14, tint(base, 30), 0.35);
}

/** Legal line at a given size and colour; returns its measured properties. */
function legalLine(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  hex: string,
  backgroundHex: string,
  scale: number,
): { bbox: [number, number, number, number]; contrast: number; heightPx: number; lines: string[] } {
  const result = canvas.paragraph(text, x, y, maxWidth, { hex, scale, tracking: 1, lineGap: Math.round(scale * 2) });
  return {
    bbox: [
      round4(x / canvas.width),
      round4(y / canvas.height),
      round4((x + result.width) / canvas.width),
      round4((y + result.height) / canvas.height),
    ],
    contrast: round2(contrastRatioHex(hex, backgroundHex)),
    // 5×7 glyphs: the cap height is 7 rows, so the rendered px height is 7×scale.
    heightPx: 7 * scale,
    lines: result.lines,
  };
}

/* ==========================================================================
 * 1 — Meta feed hero. Compliant exemplar.
 * ======================================================================== */
function feedHeroCompliant(): GeneratedCreative {
  const canvas = new Canvas(1080, 1080, CREAM);

  heroBand(canvas, 0, 0, 1080, 520, ESPRESSO);
  canvas.rect({ x: 0, y: 520, w: 1080, h: 560 }, CREAM);

  const logo = placeLockup(canvas, 72, 72, 68, '#FFFFFF');

  canvas.paragraph('YOUR MORNING, BETTER SORTED', 72, 600, 936, {
    hex: ESPRESSO,
    scale: 10,
    tracking: 2,
    lineGap: 24,
  });

  canvas.paragraph(
    'Washed Ethiopian, roasted eleven days ago. Bright, with a lemon finish. 100% Arabica, every lot.',
    72,
    800,
    860,
    { hex: ESPRESSO, scale: 4, tracking: 1, lineGap: 12 },
  );

  // CTA in the bottom third, Copper, inside the margin.
  canvas.rect({ x: 72, y: 930, w: 300, h: 78 }, COPPER);
  canvas.textCentered('SHOP NOW', 72, 300, 958, { hex: CREAM, scale: 5, tracking: 2 });

  const legal = legalLine(
    canvas,
    'Roast date printed on every bag. Best before 12 months from roast.',
    440,
    958,
    560,
    ESPRESSO,
    CREAM,
    2,
  );

  return {
    key: 'creative.feed-hero',
    fileName: '01-feed-hero-compliant.png',
    name: 'Autumn — feed hero (en-US)',
    png: canvas.toPng(),
    width: 1080,
    height: 1080,
    market: 'en-US',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'Your morning, better sorted',
      body: 'Washed Ethiopian, roasted eleven days ago. Bright, with a lemon finish. 100% Arabica, every lot.',
      cta: 'Shop now',
      altText: 'A Northwind coffee bag on a warm wooden counter beside a filled cup.',
      legal: 'Roast date printed on every bag. Best before 12 months from roast.',
    },
    tags: ['autumn-2026', 'exemplar', 'hero'],
    isApprovedExemplar: true,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      clearSpaceRatio: round2(72 / logo.markHeight),
      legalContrast: legal.contrast,
      legalHeightPx: legal.heightPx,
      espressoCreamSurfaceRatio: 0.79,
      copperSurfaceRatio: 0.02,
    },
  };
}

/* ==========================================================================
 * 2 — Sourcing post with a substantiated claim + its disclaimer. Compliant.
 * ======================================================================== */
function feedSourcingCompliant(): GeneratedCreative {
  const canvas = new Canvas(1080, 1350, CREAM);

  canvas.rect({ x: 0, y: 0, w: 1080, h: 300 }, PINE);
  const logo = placeLockup(canvas, 72, 96, 60, '#FFFFFF');

  canvas.paragraph('WE PAY FARMERS ABOVE THE C-PRICE ON EVERY LOT', 72, 380, 936, {
    hex: ESPRESSO,
    scale: 9,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph(
    'Thirty-eight percent above, on the 2026 harvest. Three farms, named on every bag, visited twice a year.',
    72,
    740,
    880,
    { hex: ESPRESSO, scale: 4, tracking: 1, lineGap: 12 },
  );

  canvas.rect({ x: 72, y: 900, w: 420, h: 78 }, COPPER);
  canvas.textCentered('LEARN MORE', 72, 420, 928, { hex: CREAM, scale: 5, tracking: 2 });

  // Disclaimer directly under the claim: 172px away on a 1350px canvas is
  // 12.7% of the height, comfortably inside the 25% proximity requirement.
  const legal = legalLine(
    canvas,
    'Premium calculated against the ICE Arabica C price at contract date. Contracts published quarterly at northwind.test/sourcing.',
    72,
    1180,
    936,
    ESPRESSO,
    CREAM,
    2,
  );

  return {
    key: 'creative.feed-sourcing',
    fileName: '02-feed-sourcing-compliant.png',
    name: 'Sourcing — above C-price (en-GB)',
    png: canvas.toPng(),
    width: 1080,
    height: 1350,
    market: 'en-GB',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'We pay farmers above the C-price on every lot',
      body: 'Thirty-eight percent above, on the 2026 harvest. Three farms, named on every bag, visited twice a year.',
      cta: 'Learn more',
      altText: 'Green Pine banner over cream, with the Northwind sourcing commitment set in large type.',
      legal:
        'Premium calculated against the ICE Arabica C price at contract date. Contracts published quarterly at northwind.test/sourcing.',
    },
    tags: ['sourcing', 'exemplar'],
    isApprovedExemplar: true,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      legalContrast: legal.contrast,
      legalHeightPx: legal.heightPx,
      claimBboxY: 0.29,
      disclaimerBboxY: 0.874,
      disclaimerProximityPct: 0.127,
    },
  };
}

/* ==========================================================================
 * 3 — Reserve story, inverted palette. Compliant exemplar.
 * ======================================================================== */
function storyReserveCompliant(): GeneratedCreative {
  const canvas = new Canvas(1080, 1920, OBSIDIAN);

  heroBand(canvas, 0, 250, 1080, 820, OBSIDIAN);

  // Everything sits inside the Meta Stories safe zone: 250 top, 340 bottom.
  const logo = placeLockup(canvas, 72, 300, 64, CREAM);

  canvas.paragraph('NORTHWIND RESERVE', 72, 1100, 936, {
    hex: CREAM,
    scale: 11,
    tracking: 3,
    lineGap: 20,
  });

  canvas.rect({ x: 72, y: 1310, w: 220, h: 5 }, BRASS);

  canvas.paragraph(
    'One farm. One harvest of the 2026 crop. Ninety bags, numbered.',
    72,
    1360,
    880,
    { hex: CREAM, scale: 4, tracking: 1, lineGap: 12 },
  );

  canvas.strokeRect({ x: 72, y: 1460, w: 380, h: 82 }, BRASS, 3);
  canvas.textCentered('ORDER NOW', 72, 380, 1489, { hex: BRASS, scale: 5, tracking: 2 });

  return {
    key: 'creative.story-reserve',
    fileName: '03-story-reserve-compliant.png',
    name: 'Reserve — story (en-GB)',
    png: canvas.toPng(),
    width: 1080,
    height: 1920,
    market: 'en-GB',
    channel: 'meta-story',
    assetType: 'image',
    copyFields: {
      headline: 'Northwind Reserve',
      body: 'One farm. One harvest of the 2026 crop. Ninety bags, numbered.',
      cta: 'Order now',
      altText: 'A dark Obsidian story frame with the Northwind Reserve wordmark in cream and a brass rule.',
    },
    tags: ['reserve', 'exemplar', 'story'],
    isApprovedExemplar: true,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      safeZoneTopPx: 250,
      safeZoneBottomPx: 340,
      topmostElementY: 300,
      bottommostElementY: 1542,
      obsidianSurfaceRatio: 0.71,
      copperSurfaceRatio: 0,
    },
  };
}

/* ==========================================================================
 * 4 — IAB medium rectangle. Compliant exemplar.
 * ======================================================================== */
function displayMpuCompliant(): GeneratedCreative {
  const canvas = new Canvas(300, 250, CREAM);
  canvas.strokeRect({ x: 0, y: 0, w: 300, h: 250 }, tint(ESPRESSO, 25), 1);

  const logo = placeLockup(canvas, 16, 16, 20, ESPRESSO);

  canvas.paragraph('FRESH ROAST, EVERY TUESDAY', 16, 84, 268, {
    hex: ESPRESSO,
    scale: 3,
    tracking: 1,
    lineGap: 7,
  });

  canvas.rect({ x: 16, y: 190, w: 110, h: 34 }, COPPER);
  canvas.textCentered('SHOP NOW', 16, 110, 201, { hex: CREAM, scale: 2, tracking: 1 });

  return {
    key: 'creative.display-mpu',
    fileName: '04-display-mpu-compliant.png',
    name: 'Always-on — 300x250 MPU (en-US)',
    png: canvas.toPng(),
    width: 300,
    height: 250,
    market: 'en-US',
    channel: 'display',
    assetType: 'image',
    copyFields: {
      headline: 'Fresh roast, every Tuesday',
      cta: 'Shop now',
      altText: 'Northwind display banner with the wordmark and a shop now button.',
    },
    tags: ['always-on', 'exemplar', 'iab'],
    isApprovedExemplar: true,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      exactSize: '300x250',
      hasBorder: true,
    },
  };
}

/* ==========================================================================
 * 5 — LinkedIn square. Compliant exemplar.
 * ======================================================================== */
function linkedinCompliant(): GeneratedCreative {
  const canvas = new Canvas(1200, 1200, CREAM);

  canvas.rect({ x: 0, y: 0, w: 1200, h: 420 }, ESPRESSO);
  const logo = placeLockup(canvas, 80, 130, 62, CREAM);

  canvas.paragraph('WE ROAST ON TUESDAYS', 80, 520, 1040, {
    hex: ESPRESSO,
    scale: 10,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph(
    'So Wednesday is the bag to order. Office subscriptions from twelve bags a month, delivered the morning after roast.',
    80,
    720,
    1000,
    { hex: ESPRESSO, scale: 4, tracking: 1, lineGap: 12 },
  );

  canvas.rect({ x: 80, y: 950, w: 360, h: 80 }, COPPER);
  canvas.textCentered('SUBSCRIBE', 80, 360, 979, { hex: CREAM, scale: 5, tracking: 2 });

  return {
    key: 'creative.linkedin',
    fileName: '05-linkedin-compliant.png',
    name: 'Office subscriptions — LinkedIn (en-GB)',
    png: canvas.toPng(),
    width: 1200,
    height: 1200,
    market: 'en-GB',
    channel: 'linkedin-feed',
    assetType: 'image',
    copyFields: {
      headline: 'We roast on Tuesdays',
      body: 'So Wednesday is the bag to order. Office subscriptions from twelve bags a month, delivered the morning after roast.',
      cta: 'Subscribe',
      altText: 'Northwind LinkedIn creative announcing office coffee subscriptions.',
    },
    tags: ['b2b', 'exemplar'],
    isApprovedExemplar: true,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      espressoCreamSurfaceRatio: 0.94,
    },
  };
}

/* ==========================================================================
 * 6 — VIOLATION: off-palette competitor green.
 * ======================================================================== */
function feedOffPaletteViolation(): GeneratedCreative {
  const canvas = new Canvas(1080, 1080, CREAM);

  // Two flat fields of the competitor's equity green. Every approved token is
  // far outside the ΔE 12 forbidden threshold from it, and together the bands
  // cover ~41% of the canvas — well past the 2% minimum cluster share.
  const topBandH = 380;
  const bottomBandY = 940;
  canvas.rect({ x: 0, y: 0, w: 1080, h: topBandH }, FORBIDDEN_GREEN);
  canvas.rect({ x: 0, y: bottomBandY, w: 1080, h: 1080 - bottomBandY }, FORBIDDEN_GREEN);

  const logo = placeLockup(canvas, 72, 110, 68, '#FFFFFF');

  canvas.paragraph('THE SMOOTHEST CUP YOU WILL DRINK', 72, 430, 936, {
    hex: ESPRESSO,
    scale: 9,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph('Northwind single origin, ground to order.', 72, 690, 880, {
    hex: ESPRESSO,
    scale: 4,
    tracking: 1,
    lineGap: 12,
  });

  canvas.rect({ x: 72, y: 800, w: 300, h: 78 }, COPPER);
  canvas.textCentered('SHOP NOW', 72, 300, 828, { hex: CREAM, scale: 5, tracking: 2 });

  // Measured off the finished pixels, not asserted. ΔE 5 matches the
  // palette-conformance tolerance the engine uses.
  const share = canvas.surfaceShare([FORBIDDEN_GREEN], 5);
  const brandShare = canvas.surfaceShare([ESPRESSO, CREAM], 5);
  const copperShare = canvas.surfaceShare([COPPER], 5);

  return {
    key: 'creative.feed-offpalette',
    fileName: '06-feed-offpalette-violation.png',
    name: 'Winter promo — feed (en-US) [OFF-PALETTE]',
    png: canvas.toPng(),
    width: 1080,
    height: 1080,
    market: 'en-US',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'The smoothest cup you will drink',
      body: 'Northwind single origin, ground to order.',
      cta: 'Shop now',
      altText: 'Green banded Northwind promotional creative.',
    },
    tags: ['winter-2026', 'violation'],
    isApprovedExemplar: false,
    violation: `color.forbidden-competitor — a competitor equity colour covers ${Math.round(share * 100)}% of the canvas`,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      offPaletteHex: FORBIDDEN_GREEN,
      offPaletteSurfaceRatio: round4(share),
      offPaletteBbox: [0, 0, 1, round4(topBandH / 1080)] as [number, number, number, number],
      espressoCreamSurfaceRatio: round4(brandShare),
      copperSurfaceRatio: round4(copperShare),
      // ΔE76 from the nearest approved token, computed from the token table so
      // the trace cites a number that is true of these exact pixels.
      nearestApprovedToken: 'color.brand.pine',
      deltaEToNearestApprovedToken: round2(
        deltaE76(hexToLab(FORBIDDEN_GREEN), hexToLab(PINE)),
      ),
      forbiddenTokenPath: 'color.forbidden.competitor-green',
    },
  };
}

/* ==========================================================================
 * 7 — VIOLATION: insufficient logo clear space.
 * ======================================================================== */
function storyClearspaceViolation(): GeneratedCreative {
  const canvas = new Canvas(1080, 1920, CREAM);
  heroBand(canvas, 0, 0, 1080, 900, ESPRESSO);

  const markDiameter = 68;
  const logo = placeLockup(canvas, 72, 300, markDiameter, '#FFFFFF');

  // Headline pushed hard up against the lockup. The gap below the lockup is
  // 0.41 × the logomark height, against a required 1.35 ×.
  const gapPx = Math.round(logo.markHeight * 0.41);
  const headlineY = 300 + logo.height + gapPx;

  canvas.paragraph('LIMITED WINTER ROAST', 72, headlineY, 936, {
    hex: CREAM,
    scale: 10,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph('Order before the end of the month.', 72, 1200, 880, {
    hex: ESPRESSO,
    scale: 4,
    tracking: 1,
    lineGap: 12,
  });

  canvas.rect({ x: 72, y: 1420, w: 320, h: 80 }, COPPER);
  canvas.textCentered('ORDER NOW', 72, 320, 1449, { hex: CREAM, scale: 5, tracking: 2 });

  return {
    key: 'creative.story-clearspace',
    fileName: '07-story-clearspace-violation.png',
    name: 'Winter roast — story (en-US) [CLEAR SPACE]',
    png: canvas.toPng(),
    width: 1080,
    height: 1920,
    market: 'en-US',
    channel: 'meta-story',
    assetType: 'image',
    copyFields: {
      headline: 'Limited winter roast',
      body: 'Order before the end of the month.',
      cta: 'Order now',
      altText: 'Northwind story creative for the limited winter roast.',
    },
    tags: ['winter-2026', 'violation'],
    isApprovedExemplar: false,
    violation: 'logo.clearspace — headline sits 0.41X below the logomark, against a required 1.35X',
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: round2(logo.markHeight),
      requiredClearSpacePx: round2(logo.markHeight * 1.35),
      measuredClearSpacePx: gapPx,
      measuredMultiple: round2(gapPx / logo.markHeight),
      encroachingElement: 'headline',
    },
  };
}

/* ==========================================================================
 * 8 — VIOLATION: low-contrast legal copy.
 * ======================================================================== */
function feedLowContrastLegal(): GeneratedCreative {
  const canvas = new Canvas(1080, 1080, CREAM);

  canvas.rect({ x: 0, y: 0, w: 1080, h: 360 }, ESPRESSO);
  const logo = placeLockup(canvas, 72, 110, 62, CREAM);

  canvas.paragraph('WINNER, BEST INDEPENDENT ROASTER 2026', 72, 450, 936, {
    hex: ESPRESSO,
    scale: 9,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph('Judged by the Guild of Fine Food. Try the blend that won it.', 72, 730, 880, {
    hex: ESPRESSO,
    scale: 4,
    tracking: 1,
    lineGap: 12,
  });

  canvas.rect({ x: 72, y: 810, w: 440, h: 76 }, COPPER);
  canvas.textCentered('FIND YOUR ROAST', 72, 440, 838, { hex: CREAM, scale: 4, tracking: 2 });

  // Stone on Cream at scale 1 → 7px tall, and 2.1:1 contrast. Two separate
  // failures on the same element: below the 11px floor and below 4.5:1.
  const legalHex = tint(STONE, 55);
  const legal = legalLine(
    canvas,
    'Guild of Fine Food, Best Independent Roaster, 2026. Awarded in the United Kingdom only.',
    72,
    1000,
    936,
    legalHex,
    CREAM,
    1,
  );

  return {
    key: 'creative.feed-lowcontrast',
    fileName: '08-feed-lowcontrast-legal.png',
    name: 'Award — feed (en-GB) [LOW CONTRAST LEGAL]',
    png: canvas.toPng(),
    width: 1080,
    height: 1080,
    market: 'en-GB',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'Winner, Best Independent Roaster 2026',
      body: 'Judged by the Guild of Fine Food. Try the blend that won it.',
      cta: 'Find your roast',
      legal: 'Guild of Fine Food, Best Independent Roaster, 2026. Awarded in the United Kingdom only.',
      altText: 'Northwind award announcement creative.',
    },
    tags: ['award', 'violation'],
    isApprovedExemplar: false,
    violation:
      `accessibility.legal-contrast + typography.legal-min-size — the disclaimer renders at ${legal.heightPx}px and ${legal.contrast}:1`,
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      legalBbox: legal.bbox,
      legalHex,
      legalBackgroundHex: CREAM,
      legalContrast: legal.contrast,
      legalHeightPx: legal.heightPx,
      requiredContrast: 4.5,
      requiredHeightPx: 11,
    },
  };
}

/* ==========================================================================
 * 9 — VIOLATION: expired claim.
 * ======================================================================== */
function feedExpiredClaim(): GeneratedCreative {
  const canvas = new Canvas(1080, 1080, CREAM);

  heroBand(canvas, 0, 0, 1080, 480, PINE);
  const logo = placeLockup(canvas, 72, 72, 66, CREAM);

  canvas.paragraph('SINGLE-FARM, SINGLE-HARVEST', 72, 560, 936, {
    hex: ESPRESSO,
    // scale 9, not 10: at 10 the single word "SINGLE-HARVEST" measures 960px
    // and would run past the 936px text column. The generator does not
    // hyphenate, so the scale has to be chosen to fit the longest token.
    scale: 9,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph(
    'Finca La Ventana, one lot, ninety bags. Northwind buys the whole harvest.',
    72,
    760,
    880,
    { hex: ESPRESSO, scale: 4, tracking: 1, lineGap: 12 },
  );

  canvas.rect({ x: 72, y: 900, w: 340, h: 76 }, COPPER);
  canvas.textCentered('ORDER NOW', 72, 340, 928, { hex: CREAM, scale: 5, tracking: 2 });

  return {
    key: 'creative.feed-expired-claim',
    fileName: '09-feed-expired-claim.png',
    name: 'Finca La Ventana — feed (en-US) [EXPIRED CLAIM]',
    png: canvas.toPng(),
    width: 1080,
    height: 1080,
    market: 'en-US',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'Single-farm, single-harvest',
      body: 'Finca La Ventana, one lot, ninety bags. Northwind buys the whole harvest.',
      cta: 'Order now',
      altText: 'Northwind single-farm coffee announcement.',
    },
    tags: ['single-origin', 'violation'],
    isApprovedExemplar: false,
    violation: 'legal.claim-in-date — "Single-farm, single-harvest" expired on 2025-10-01',
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      claimKey: 'claim.origin-single-farm',
      claimText: 'Single-farm, single-harvest',
      claimBbox: [0.0667, 0.5185, 0.9333, 0.6019],
      claimExpiresAt: '2025-10-01T00:00:00Z',
    },
  };
}

/* ==========================================================================
 * 10 — VIOLATION: claim used outside its approved jurisdiction.
 * ======================================================================== */
function feedJurisdictionClaim(): GeneratedCreative {
  const canvas = new Canvas(1080, 1350, CREAM);

  canvas.rect({ x: 0, y: 0, w: 1080, h: 340 }, PINE);
  const logo = placeLockup(canvas, 72, 110, 62, CREAM);

  canvas.paragraph('KERBSIDE-RECYCLABLE PACKAGING', 72, 430, 936, {
    hex: ESPRESSO,
    // "KERBSIDE-RECYCLABLE" is 19 characters and cannot be broken; at scale 9
    // it would be 1179px wide and run off a 1080px canvas.
    scale: 7,
    tracking: 2,
    lineGap: 22,
  });

  canvas.paragraph(
    'The whole bag, the valve and the label. Northwind packaging, redesigned.',
    72,
    700,
    880,
    { hex: ESPRESSO, scale: 4, tracking: 1, lineGap: 12 },
  );

  canvas.rect({ x: 72, y: 880, w: 390, h: 78 }, COPPER);
  canvas.textCentered('LEARN MORE', 72, 390, 908, { hex: CREAM, scale: 5, tracking: 2 });

  // The disclaimer IS present, legible and adjacent — so the only thing wrong
  // is the jurisdiction. That is deliberate: it isolates the catch.
  const legal = legalLine(
    canvas,
    'Kerbside recycling availability varies by local authority. Check your local scheme before disposal.',
    72,
    1180,
    936,
    INK,
    CREAM,
    2,
  );

  return {
    key: 'creative.feed-jurisdiction',
    fileName: '10-feed-jurisdiction-claim.png',
    name: 'Packaging — feed (en-US) [WRONG JURISDICTION]',
    png: canvas.toPng(),
    width: 1080,
    height: 1350,
    market: 'en-US',
    channel: 'meta-feed',
    assetType: 'image',
    copyFields: {
      headline: 'Kerbside-recyclable packaging',
      body: 'The whole bag, the valve and the label. Northwind packaging, redesigned.',
      cta: 'Learn more',
      legal: 'Kerbside recycling availability varies by local authority. Check your local scheme before disposal.',
      altText: 'Northwind packaging recyclability announcement.',
    },
    tags: ['packaging', 'violation'],
    isApprovedExemplar: false,
    violation: 'legal.claim-jurisdiction — the recyclability claim is approved for en-GB and de-DE only',
    measured: {
      logoBbox: logo.bbox,
      logomarkHeightPx: logo.markHeight,
      claimKey: 'claim.recyclable-packaging',
      claimText: 'Kerbside-recyclable packaging',
      assetMarket: 'en-US',
      approvedJurisdictions: ['en-GB', 'de-DE'],
      legalContrast: legal.contrast,
      legalHeightPx: legal.heightPx,
    },
  };
}

export function generateCreatives(): GeneratedCreative[] {
  return [
    feedHeroCompliant(),
    feedSourcingCompliant(),
    storyReserveCompliant(),
    displayMpuCompliant(),
    linkedinCompliant(),
    feedOffPaletteViolation(),
    storyClearspaceViolation(),
    feedLowContrastLegal(),
    feedExpiredClaim(),
    feedJurisdictionClaim(),
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
