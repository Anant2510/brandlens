/* ==========================================================================
 * Colour maths.
 *
 * Every colour token is stored with its CIELAB coordinates precomputed. Doing
 * it at import time rather than at check time matters: palette conformance is
 * a per-pixel-cluster ΔE comparison against every brand colour, and re-parsing
 * hex → sRGB → linear → XYZ → Lab inside that loop is the difference between a
 * check that costs nothing and one that dominates the request.
 * ========================================================================== */

export type Lab = [number, number, number];
export type Rgb = [number, number, number];

/** Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`. Returns null on anything else. */
export function parseHex(input: string): { rgb: Rgb; alpha: number; hex: string } | null {
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
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { rgb: [r, g, b], alpha, hex: `#${hex.toLowerCase()}` };
}

/** sRGB transfer function inverse (gamma decode). */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB → CIE XYZ under D65. */
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

const D65: [number, number, number] = [0.95047, 1.0, 1.08883];

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

export function hexToLab(hex: string): Lab | null {
  const parsed = parseHex(hex);
  return parsed ? rgbToLab(parsed.rgb) : null;
}

/** CIE76 ΔE. Cheap, and adequate for the pre-filter before ΔE2000. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** WCAG relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Normalises any CSS-ish colour literal we can understand to `#rrggbb`. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = parseHex(value);
  if (parsed) return parsed.hex.length === 9 ? parsed.hex : parsed.hex;
  const rgbMatch = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value.trim());
  if (rgbMatch) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
  }
  return null;
}
