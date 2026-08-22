/* ==========================================================================
 * Logo variant generation.
 *
 * Four real PNG files, drawn programmatically so the geometry is exact and
 * reproducible:
 *
 *   primary          full lockup: mark + wordmark, Espresso on transparent
 *   monochrome-white knockout for dark grounds
 *   monochrome-black single-ink for print and fax-grade reproduction
 *   icon-only        the mark alone, for avatars and favicons
 *
 * The `logomarkHeightPx` recorded against each variant is the height of the
 * MARK, not of the file. That is the "X" unit every brand book expresses
 * clear space in, and getting it wrong would make every clear-space verdict
 * wrong by a constant factor — the kind of error that looks like the check
 * being broken rather than the metadata being wrong.
 *
 * The device is a compass rose crossed with a coffee bean: a ring, a seam
 * down the middle, and four cardinal ticks. Simple enough to render exactly
 * at 64px, distinctive enough to be a real detection target.
 * ========================================================================== */

import { Canvas } from '../lib/png.js';
import { CREAM, ESPRESSO } from '../data/tokens.js';

export interface GeneratedLogo {
  key: string;
  name: string;
  kind:
    | 'primary'
    | 'horizontal_lockup'
    | 'stacked_lockup'
    | 'monochrome_black'
    | 'monochrome_white'
    | 'knockout'
    | 'icon_only'
    | 'wordmark_only'
    | 'cobrand_lockup';
  fileName: string;
  png: Buffer;
  width: number;
  height: number;
  /** Height of the logomark inside the file, in pixels. The "X" unit. */
  logomarkHeightPx: number;
  aspectRatio: number;
  palette: string[];
  constraints: Record<string, unknown>;
}

/** Draws the compass-bean mark centred at (cx, cy) with the given diameter. */
function drawMark(canvas: Canvas, cx: number, cy: number, diameter: number, hex: string): void {
  const radius = diameter / 2;
  const stroke = Math.max(2, Math.round(diameter * 0.1));

  // Outer ring.
  canvas.circle(cx, cy, radius, hex);
  canvas.circleTransparent(cx, cy, radius - stroke);

  // The bean seam: a vertical bar with the middle third pinched out, which
  // reads as a seam at 512px and as a solid stroke at 32px.
  const seamW = Math.max(2, Math.round(diameter * 0.085));
  const seamH = radius - stroke * 1.4;
  canvas.rect({ x: cx - seamW / 2, y: cy - seamH, w: seamW, h: seamH * 2 }, hex);
  canvas.rect(
    { x: cx - seamW * 1.4, y: cy - seamW / 2, w: seamW * 2.8, h: seamW },
    hex,
  );

  // Four cardinal ticks just outside the ring.
  const tick = Math.max(2, Math.round(diameter * 0.09));
  const gap = stroke * 0.9;
  canvas.rect({ x: cx - stroke / 2, y: cy - radius - gap - tick, w: stroke, h: tick }, hex);
  canvas.rect({ x: cx - stroke / 2, y: cy + radius + gap, w: stroke, h: tick }, hex);
  canvas.rect({ x: cx - radius - gap - tick, y: cy - stroke / 2, w: tick, h: stroke }, hex);
  canvas.rect({ x: cx + radius + gap, y: cy - stroke / 2, w: tick, h: stroke }, hex);
}

/** The full horizontal lockup: mark on the left, wordmark on the right. */
function buildLockup(inkHex: string): { canvas: Canvas; markHeight: number } {
  const width = 720;
  const height = 200;
  const canvas = new Canvas(width, height, '#ffffff');
  canvas.clear(); // transparent — a logo file must sit on any ground

  // Mark: 128px tall, vertically centred, with a 36px left margin.
  const markDiameter = 112;
  const tick = Math.round(markDiameter * 0.09);
  const stroke = Math.round(markDiameter * 0.1);
  // Total mark height = ring + both ticks + both gaps.
  const markHeight = markDiameter + 2 * (tick + stroke * 0.9);

  const cx = 36 + markDiameter / 2 + tick + stroke;
  const cy = height / 2;
  drawMark(canvas, cx, cy, markDiameter, inkHex);

  // Wordmark. 5x7 glyphs at scale 7 give 35px caps; tracking 2 opens it up.
  const scale = 7;
  const tracking = 2;
  const wordX = cx + markDiameter / 2 + tick + stroke + 40;
  const wordY = Math.round(cy - Canvas.textHeight(scale) / 2) - 10;
  canvas.text('NORTHWIND', wordX, wordY, { hex: inkHex, scale, tracking });

  // Descriptor line, letterspaced under the wordmark.
  canvas.text('COFFEE CO.', wordX + 2, wordY + Canvas.textHeight(scale) + 14, {
    hex: inkHex,
    scale: 3,
    tracking: 4,
  });

  return { canvas, markHeight };
}

function buildIcon(inkHex: string): { canvas: Canvas; markHeight: number } {
  const size = 256;
  const canvas = new Canvas(size, size, '#ffffff');
  canvas.clear();

  const markDiameter = 176;
  const tick = Math.round(markDiameter * 0.09);
  const stroke = Math.round(markDiameter * 0.1);
  const markHeight = markDiameter + 2 * (tick + stroke * 0.9);

  drawMark(canvas, size / 2, size / 2, markDiameter, inkHex);
  return { canvas, markHeight };
}

/**
 * Shared usage constraints. Clear space is 1.35× the logomark height.
 *
 * These are the variant's OWN defaults, used by `logo.clearspace` and
 * `logo.min_size` when the rule sets no threshold of its own — so the key
 * names have to be the ones the engine looks up, exactly as they do in
 * `check.params`. They previously were not: `clearSpaceUnit` (the engine reads
 * `clearSpaceBasis`) and `minWidthPx/Pct/Mm` (the engine measures HEIGHT, and
 * reads `minHeightPx/Pct/Mm`), plus four keys — allowedBackgrounds,
 * allowedZones, maxAspectDeviationPct, forbidEffects — that no analyzer reads
 * from a variant at all. Placement and distortion take their thresholds from
 * the rule, not from here.
 *
 * A constraint the engine cannot see is a guideline nobody is held to, and it
 * is harder to notice here than in a rule: there is no console screen showing
 * these numbers back to anyone.
 */
function constraintsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clearSpaceMultiple: 1.35,
    clearSpaceBasis: 'height',
    // 6% of canvas height, and 12mm tall in print — the same figures the
    // logo.min-size rules carry, so a rule and its variant cannot disagree.
    minHeightPct: 6,
    minHeightMm: 12,
    ...overrides,
  };
}

export function generateLogos(): GeneratedLogo[] {
  const primary = buildLockup(ESPRESSO);
  const monoBlack = buildLockup('#000000');
  const monoWhite = buildLockup('#FFFFFF');
  const icon = buildIcon(ESPRESSO);

  return [
    {
      key: 'logo.primary',
      name: 'Northwind — primary lockup',
      kind: 'primary',
      fileName: 'northwind-primary.png',
      png: primary.canvas.toPng(),
      width: primary.canvas.width,
      height: primary.canvas.height,
      logomarkHeightPx: round2(primary.markHeight),
      aspectRatio: round4(primary.canvas.width / primary.canvas.height),
      palette: [ESPRESSO],
      constraints: constraintsFor(),
    },
    {
      key: 'logo.mono-white',
      name: 'Northwind — monochrome white (knockout)',
      kind: 'monochrome_white',
      fileName: 'northwind-mono-white.png',
      png: monoWhite.canvas.toPng(),
      width: monoWhite.canvas.width,
      height: monoWhite.canvas.height,
      logomarkHeightPx: round2(monoWhite.markHeight),
      aspectRatio: round4(monoWhite.canvas.width / monoWhite.canvas.height),
      palette: ['#FFFFFF'],
      constraints: constraintsFor({
        allowedBackgrounds: 'dark',
        // The only variant permitted over photography, and only when the
        // region behind it is dark enough to keep the mark legible.
        minBackgroundLuminanceDelta: 0.45,
        notes: 'Use on Obsidian, Espresso or a photographic region with mean luminance below 0.35.',
      }),
    },
    {
      key: 'logo.mono-black',
      name: 'Northwind — monochrome black',
      kind: 'monochrome_black',
      fileName: 'northwind-mono-black.png',
      png: monoBlack.canvas.toPng(),
      width: monoBlack.canvas.width,
      height: monoBlack.canvas.height,
      logomarkHeightPx: round2(monoBlack.markHeight),
      aspectRatio: round4(monoBlack.canvas.width / monoBlack.canvas.height),
      palette: ['#000000'],
      constraints: constraintsFor({
        allowedBackgrounds: 'light',
        notes: 'Single-ink print, fax-grade reproduction and embossing only. Not for screen.',
      }),
    },
    {
      key: 'logo.icon',
      name: 'Northwind — icon only',
      kind: 'icon_only',
      fileName: 'northwind-icon.png',
      png: icon.canvas.toPng(),
      width: icon.canvas.width,
      height: icon.canvas.height,
      logomarkHeightPx: round2(icon.markHeight),
      aspectRatio: round4(icon.canvas.width / icon.canvas.height),
      palette: [ESPRESSO, CREAM],
      constraints: constraintsFor({
        minWidthPx: 32,
        minWidthMm: 8,
        allowedZones: ['*'],
        allowedContexts: ['avatar', 'favicon', 'app-icon', 'stamp'],
        notes:
          'Permitted only where the wordmark appears elsewhere in the same surface, or where the context already identifies the brand.',
      }),
    },
  ];
}

/** Reusable mark for the creative generator, at an arbitrary size. */
export function markCanvas(diameter: number, hex: string): Canvas {
  const tick = Math.round(diameter * 0.09);
  const stroke = Math.round(diameter * 0.1);
  const pad = tick + stroke;
  const size = diameter + pad * 2;
  const canvas = new Canvas(size, size, '#ffffff');
  canvas.clear();
  drawMark(canvas, size / 2, size / 2, diameter, hex);
  return canvas;
}

/** Small horizontal lockup for placing into creatives. */
export function lockupCanvas(markDiameter: number, hex: string): { canvas: Canvas; markHeight: number } {
  const tick = Math.round(markDiameter * 0.09);
  const stroke = Math.round(markDiameter * 0.1);
  const markHeight = markDiameter + 2 * (tick + stroke * 0.9);

  const scale = Math.max(1, Math.round(markDiameter / 16));
  const tracking = 2;
  const wordWidth = Canvas.textWidth('NORTHWIND', scale, tracking);
  const gap = Math.round(markDiameter * 0.35);

  const width = Math.round(markDiameter + (tick + stroke) * 2 + gap + wordWidth);
  const height = Math.round(markHeight);
  const canvas = new Canvas(width, height, '#ffffff');
  canvas.clear();

  const cx = (markDiameter + (tick + stroke) * 2) / 2;
  drawMark(canvas, cx, height / 2, markDiameter, hex);
  canvas.text('NORTHWIND', markDiameter + (tick + stroke) * 2 + gap, Math.round(height / 2 - Canvas.textHeight(scale) / 2), {
    hex,
    scale,
    tracking,
  });

  return { canvas, markHeight };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
