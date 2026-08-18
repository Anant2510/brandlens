/* ==========================================================================
 * Northwind design tokens — W3C DTCG shape.
 *
 * The DTCG format (`$value` / `$type` / `$description`) is what Figma
 * Variables, Style Dictionary and Tailwind's token exporters all speak, so
 * storing it verbatim means a customer's existing pipeline imports without a
 * translation layer.
 *
 * The colour rows additionally carry:
 *
 *   hex / lab_l / lab_a / lab_b   precomputed CIELAB, so palette conformance
 *                                 never re-parses a colour inside its
 *                                 per-cluster ΔE loop
 *   role                          primary | secondary | accent | neutral |
 *                                 functional | forbidden
 *   allowed_tints                 which tints of this ink are legal, as
 *                                 percentages of full ink on white
 *   usage                         surface-share constraints the
 *                                 color.dominance_ratio analyzer reads
 * ========================================================================== */

import { hexToLabRounded, contrastRatioHex, tint } from '../lib/color.js';

export type TokenType =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'duration'
  | 'number'
  | 'shadow'
  | 'typography'
  | 'other';

export interface SeedToken {
  path: string;
  type: TokenType;
  value: unknown;
  description: string;
  hex?: string;
  role?: string;
  allowedTints?: number[];
  usage?: Record<string, unknown>;
  source?: string;
}

/* --------------------------------------------------------------------------
 * The palette.
 *
 * A real coffee brand's system: two brand inks, a warm accent, a cool
 * secondary for the Reserve sub-brand, three neutrals and two functional
 * signal colours. Then two competitor colours marked `forbidden`, which is
 * what turns "don't use Starbucks green" from folklore into a check.
 * ------------------------------------------------------------------------ */

interface ColorSpec {
  path: string;
  hex: string;
  role: string;
  description: string;
  tints?: number[];
  usage?: Record<string, unknown>;
}

const COLORS: ColorSpec[] = [
  {
    path: 'color.brand.espresso',
    hex: '#2B1B12',
    role: 'primary',
    description: 'Espresso. The primary brand ink: wordmark, headlines, body copy on light grounds.',
    tints: [20, 40, 60, 80],
    // The dominant-surface rule the brand book actually states: on any
    // primary-brand surface, Espresso or Cream must carry at least 55% of
    // the pixels, which is what stops a "Northwind" ad reading as a generic
    // stock template with a small logo pasted on.
    usage: { minSurfaceRatio: 0.25, pairsWith: ['color.brand.cream', 'color.neutral.paper'] },
  },
  {
    path: 'color.brand.cream',
    hex: '#F4EDE1',
    role: 'primary',
    description: 'Cream. The primary ground. Every light layout starts here, not on pure white.',
    tints: [40, 60, 80],
    usage: { minSurfaceRatio: 0.3, role: 'background' },
  },
  {
    path: 'color.brand.copper',
    hex: '#C2703D',
    role: 'accent',
    description: 'Copper. Accent only — CTAs, underlines, iconography. Never a full-bleed background.',
    tints: [20, 40, 60],
    usage: { maxSurfaceRatio: 0.18, allowedElements: ['cta', 'rule', 'icon', 'highlight'] },
  },
  {
    path: 'color.brand.pine',
    hex: '#1F4D3D',
    role: 'secondary',
    description: 'Pine. Secondary ink, reserved for sustainability and sourcing communications.',
    tints: [20, 40, 60, 80],
    usage: { maxSurfaceRatio: 0.4, contexts: ['sourcing', 'sustainability'] },
  },
  {
    path: 'color.reserve.obsidian',
    hex: '#12100F',
    role: 'primary',
    description: 'Obsidian. Northwind Reserve ground. Reserve layouts invert: dark ground, cream ink.',
    tints: [60, 80],
    usage: { subBrand: 'northwind-reserve', role: 'background', minSurfaceRatio: 0.5 },
  },
  {
    path: 'color.reserve.brass',
    hex: '#B08D4F',
    role: 'accent',
    description: 'Brass. The Reserve accent. Replaces Copper entirely on Reserve work — never both.',
    tints: [40, 60],
    usage: { subBrand: 'northwind-reserve', maxSurfaceRatio: 0.15, mutuallyExclusiveWith: ['color.brand.copper'] },
  },
  {
    path: 'color.neutral.paper',
    hex: '#FFFFFF',
    role: 'neutral',
    description: 'Paper white. Permitted for legal copy grounds and print stock only.',
    tints: [],
    usage: { allowedElements: ['legal', 'print-stock'] },
  },
  {
    path: 'color.neutral.stone',
    hex: '#8A8177',
    role: 'neutral',
    description: 'Stone. Dividers, disabled states, secondary metadata.',
    tints: [20, 40, 60, 80],
    usage: { maxSurfaceRatio: 0.2 },
  },
  {
    path: 'color.neutral.ink',
    hex: '#171310',
    role: 'neutral',
    description: 'Ink. Maximum-contrast text. Use for legal and disclaimer copy, never for headlines.',
    tints: [],
    usage: { allowedElements: ['legal', 'disclaimer', 'body'] },
  },
  {
    path: 'color.functional.success',
    hex: '#2E7D5B',
    role: 'functional',
    description: 'Success. UI and product-state signalling only; never decorative.',
    tints: [],
    usage: { allowedElements: ['ui-state'] },
  },
  {
    path: 'color.functional.warning',
    hex: '#B4531B',
    role: 'functional',
    description: 'Warning. UI and product-state signalling only; never decorative.',
    tints: [],
    usage: { allowedElements: ['ui-state'] },
  },
  /* --- forbidden -------------------------------------------------------
   * Competitor equity colours. Marked `forbidden` so color.forbidden fires
   * a blocker when they appear, with a rationale a reviewer can defend to
   * the agency that submitted the work.
   * ------------------------------------------------------------------- */
  {
    path: 'color.forbidden.competitor-green',
    hex: '#00704A',
    role: 'forbidden',
    description:
      'FORBIDDEN — the dominant competitor’s equity green. Any surface within ΔE 12 of this reads as them, not us.',
    tints: [],
    usage: { deltaEThreshold: 12, reason: 'competitor-equity', competitor: 'category leader' },
  },
  {
    path: 'color.forbidden.competitor-orange',
    hex: '#FF8000',
    role: 'forbidden',
    description:
      'FORBIDDEN — the QSR competitor’s orange. Also close enough to Copper to be mistaken for a bad print of it.',
    tints: [],
    usage: { deltaEThreshold: 10, reason: 'competitor-equity', competitor: 'QSR chain' },
  },
];

/** DTCG colour tokens, with CIELAB computed from the hex at seed time. */
const colorTokens: SeedToken[] = COLORS.map((c) => {
  const lab = hexToLabRounded(c.hex);
  return {
    path: c.path,
    type: 'color' as const,
    value: {
      $type: 'color',
      $value: c.hex,
      $description: c.description,
      $extensions: {
        'com.brandlens': {
          role: c.role,
          lab: { l: lab.l, a: lab.a, b: lab.b },
          // The tint ramp expanded to concrete hexes, so the console can render
          // swatches without re-deriving them and a designer can copy one out.
          tints: (c.tints ?? []).map((pct) => ({ pct, hex: tint(c.hex, pct) })),
          contrastOnCream: round2(contrastRatioHex(c.hex, '#F4EDE1')),
          contrastOnObsidian: round2(contrastRatioHex(c.hex, '#12100F')),
        },
      },
    },
    description: c.description,
    hex: c.hex,
    role: c.role,
    allowedTints: c.tints ?? [],
    usage: c.usage ?? {},
    source: 'brandbook',
  };
});

/* --------------------------------------------------------------------------
 * Non-colour tokens.
 * ------------------------------------------------------------------------ */

const otherTokens: SeedToken[] = [
  {
    path: 'font.family.display',
    type: 'fontFamily',
    value: { $type: 'fontFamily', $value: ['Sole Serif Display', 'Georgia', 'serif'] },
    description: 'Display face. Headlines only, 32px and above.',
    source: 'brandbook',
  },
  {
    path: 'font.family.text',
    type: 'fontFamily',
    value: { $type: 'fontFamily', $value: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'] },
    description: 'Text face. Everything that is not a headline.',
    source: 'brandbook',
  },
  {
    path: 'font.weight.regular',
    type: 'fontWeight',
    value: { $type: 'fontWeight', $value: 400 },
    description: 'Regular.',
    source: 'brandbook',
  },
  {
    path: 'font.weight.medium',
    type: 'fontWeight',
    value: { $type: 'fontWeight', $value: 500 },
    description: 'Medium. The default for UI labels and CTAs.',
    source: 'brandbook',
  },
  {
    path: 'font.weight.bold',
    type: 'fontWeight',
    value: { $type: 'fontWeight', $value: 700 },
    description: 'Bold. Display and H1 only — never synthesised from Regular.',
    source: 'brandbook',
  },
  {
    path: 'space.unit',
    type: 'dimension',
    value: { $type: 'dimension', $value: '8px' },
    description: 'Base spacing unit. Every margin and gap is a multiple of this.',
    source: 'brandbook',
  },
  {
    path: 'space.margin.min',
    type: 'dimension',
    value: { $type: 'dimension', $value: '48px' },
    description: 'Minimum outer margin on any digital canvas ≥ 1080px on its short edge.',
    source: 'brandbook',
  },
  {
    path: 'radius.card',
    type: 'dimension',
    value: { $type: 'dimension', $value: '12px' },
    description: 'Corner radius for cards and image containers.',
    source: 'brandbook',
  },
  {
    path: 'logo.clearspace.multiple',
    type: 'number',
    value: { $type: 'number', $value: 1.35 },
    description:
      'Clear space around the logomark, expressed as a multiple of the logomark height (the "X" unit).',
    source: 'brandbook',
  },
  {
    path: 'logo.min-width.digital',
    type: 'dimension',
    value: { $type: 'dimension', $value: '120px' },
    description: 'Minimum rendered logo width on screen.',
    source: 'brandbook',
  },
  {
    path: 'logo.min-width.print',
    type: 'dimension',
    value: { $type: 'dimension', $value: '25mm' },
    description: 'Minimum reproduced logo width in print.',
    source: 'brandbook',
  },
  {
    path: 'motion.duration.standard',
    type: 'duration',
    value: { $type: 'duration', $value: '240ms' },
    description: 'Standard transition duration.',
    source: 'brandbook',
  },
  {
    path: 'elevation.card',
    type: 'shadow',
    value: {
      $type: 'shadow',
      $value: { color: '#2B1B1226', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '0px' },
    },
    description: 'Card elevation. The only permitted shadow.',
    source: 'brandbook',
  },
  {
    path: 'type.style.legal',
    type: 'typography',
    value: {
      $type: 'typography',
      $value: {
        fontFamily: 'Inter',
        fontSize: '11px',
        fontWeight: 400,
        lineHeight: 1.35,
        letterSpacing: '0.01em',
      },
    },
    description: 'Legal / disclaimer composite style. 11px is the floor, not a suggestion.',
    source: 'brandbook',
  },
];

export const SEED_TOKENS: SeedToken[] = [...colorTokens, ...otherTokens];

/** Convenience lookups used elsewhere in the seed. */
export const PALETTE: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.path, c.hex]));

export const ESPRESSO = PALETTE['color.brand.espresso'];
export const CREAM = PALETTE['color.brand.cream'];
export const COPPER = PALETTE['color.brand.copper'];
export const PINE = PALETTE['color.brand.pine'];
export const OBSIDIAN = PALETTE['color.reserve.obsidian'];
export const BRASS = PALETTE['color.reserve.brass'];
export const STONE = PALETTE['color.neutral.stone'];
export const INK = PALETTE['color.neutral.ink'];
export const PAPER = PALETTE['color.neutral.paper'];
export const FORBIDDEN_GREEN = PALETTE['color.forbidden.competitor-green'];
export const FORBIDDEN_ORANGE = PALETTE['color.forbidden.competitor-orange'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
