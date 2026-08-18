/* ==========================================================================
 * Colour maths for the seed.
 *
 * `design_tokens` stores CIELAB coordinates alongside the hex so that palette
 * conformance — a ΔE comparison of every extracted pixel cluster against every
 * brand colour — never has to re-parse anything at check time. Seeding those
 * columns with anything other than the real conversion would make the demo
 * lie about the product's most-used code path, so this is the full pipeline:
 *
 *     hex → sRGB → linear RGB → CIE XYZ (D65) → CIELAB
 *
 * Deliberately duplicated from apps/api/src/common/color.ts rather than
 * imported: @brandlens/db must not depend on the API package (the dependency
 * runs the other way), and the constants below are fixed by the CIE spec, so
 * the two copies cannot drift in any way that matters.
 * ========================================================================== */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

/** Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`. */
export function parseHex(input: string): { rgb: Rgb; alpha: number; hex: string } {
  const raw = input.trim().replace(/^#/, '');
  let hex: string;
  if (raw.length === 3) {
    hex = raw
      .split('')
      .map((c) => c + c)
      .join('');
  } else if (raw.length === 6 || raw.length === 8) {
    hex = raw;
  } else {
    throw new Error(`Not a hex colour: ${input}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Not a hex colour: ${input}`);

  return {
    rgb: [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ],
    alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    hex: `#${hex.slice(0, 6).toLowerCase()}`,
  };
}

/** Inverse sRGB transfer function (gamma decode) for one 0–255 channel. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear sRGB → CIE XYZ, sRGB primaries under a D65 white point. */
export function rgbToXyz([r, g, b]: Rgb): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return [
    lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375,
    lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175,
    lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041,
  ];
}

/** D65 reference white, 2° observer — the sRGB standard illuminant. */
const D65: [number, number, number] = [0.95047, 1.0, 1.08883];

// The CIE-recommended rational forms. Using 0.008856 / 903.3 instead produces
// a small discontinuity at the knee, which shows up as a ΔE of ~0.01 on very
// dark colours — invisible, but there is no reason to introduce it.
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

export function rgbToLab(rgb: Rgb): Lab {
  const [x, y, z] = rgbToXyz(rgb);
  const f = (t: number): number => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(x / D65[0]);
  const fy = f(y / D65[1]);
  const fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex: string): Lab {
  return rgbToLab(parseHex(hex).rgb);
}

/** Rounded to 4 dp — `real` columns carry ~7 significant digits anyway. */
export function hexToLabRounded(hex: string): { l: number; a: number; b: number } {
  const [l, a, b] = hexToLab(hex);
  return { l: round4(l), a: round4(a), b: round4(b) };
}

/** CIE76 ΔE. Used here only to sanity-check the seeded palette's separation. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio in [1, 21]. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastRatioHex(a: string, b: string): number {
  return contrastRatio(parseHex(a).rgb, parseHex(b).rgb);
}

/**
 * Mixes `hex` toward white by `pct` (0–100). This is what "tint" means in a
 * brand book: `Espresso 40%` is 40% ink on white, not 40% opacity.
 */
export function tint(hex: string, pct: number): string {
  const { rgb } = parseHex(hex);
  const k = Math.min(100, Math.max(0, pct)) / 100;
  const mixed = rgb.map((c) => Math.round(255 + (c - 255) * k)) as Rgb;
  return rgbToHex(mixed);
}

export function rgbToHex([r, g, b]: Rgb): string {
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
