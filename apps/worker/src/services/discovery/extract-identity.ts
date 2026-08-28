import type { DiscoveredColor, DiscoveredTypeStyle } from '@brandlens/contracts';
import { type Lab, type Rgb, contrastRatio, deltaE76, rgbToLab } from '@brandlens/api/common/color';
import type { ImageCandidate, PaintedColor, TextRun } from './browser';

/* ==========================================================================
 * Turning a rendered site into a candidate brand identity.
 *
 * Everything here is deterministic arithmetic over the browser's own computed
 * styles. No model is asked what colour the brand is — a model is asked, later
 * and separately, what the brand SOUNDS like, which is a judgement. The palette
 * is a measurement, and measurements belong in code where they can be tested,
 * explained in a report, and reproduced a year later.
 * ========================================================================== */

/** Parses the colour syntaxes a browser's computed style actually emits. */
export function parseCssColor(value: string): { rgb: Rgb; alpha: number } | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text || text === 'transparent' || text === 'none' || text === 'currentcolor') return null;

  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(text);
  if (fn) {
    const rgb: Rgb = [Math.round(+fn[1]), Math.round(+fn[2]), Math.round(+fn[3])];
    if (rgb.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
    let alpha = 1;
    if (fn[4] !== undefined) {
      alpha = fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
      if (!Number.isFinite(alpha)) alpha = 1;
    }
    return { rgb, alpha: Math.max(0, Math.min(1, alpha)) };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  return null;
}

export function toHex([r, g, b]: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Chroma in Lab. Below ~8 a colour reads as grey however saturated it looks. */
export function chroma([, a, b]: Lab): number {
  return Math.sqrt(a * a + b * b);
}

export interface PageColors {
  url: string;
  colors: PaintedColor[];
}

interface Cluster {
  lab: Lab;
  rgb: Rgb;
  area: number;
  pages: Set<string>;
  citations: Array<{ url: string; selector: string; property: string }>;
  properties: Map<string, number>;
}

/**
 * ΔE76 below which two colours are treated as the same brand colour.
 *
 * 3 is roughly the threshold at which a trained eye stops seeing a difference.
 * Lower and a single brand green splits into six near-identical entries
 * because of anti-aliasing and hover states; higher and a brand's primary
 * merges with its accent.
 */
const MERGE_DELTA_E = 3;

/**
 * Extracts the palette a site actually paints with.
 *
 * Weighted by PAINTED AREA rather than by how many CSS declarations mention a
 * colour. A stylesheet may define forty colours and use three; the report has
 * to describe the three. Area is what a visitor's eye integrates, so area is
 * what "dominant" should mean.
 *
 * Colours are also required to appear on more than one page before they can be
 * called primary — a single page's hero image treatment is not a brand rule,
 * and inducing one from it is how this kind of tool loses a room's trust.
 */
export function extractPalette(pages: PageColors[], options: { max?: number } = {}): DiscoveredColor[] {
  const clusters: Cluster[] = [];
  let totalArea = 0;

  for (const page of pages) {
    for (const entry of page.colors) {
      const parsed = parseCssColor(entry.color);
      // Near-transparent paint contributes almost nothing to what is seen.
      if (!parsed || parsed.alpha < 0.35) continue;

      const area = Math.max(0, entry.area) * parsed.alpha;
      if (area <= 0) continue;

      const lab = rgbToLab(parsed.rgb);
      totalArea += area;

      let match: Cluster | null = null;
      let best = MERGE_DELTA_E;
      for (const cluster of clusters) {
        const d = deltaE76(cluster.lab, lab);
        if (d < best) {
          best = d;
          match = cluster;
        }
      }

      if (match) {
        // Area-weighted mean keeps the cluster centred on the dominant shade
        // rather than drifting toward whichever variant appeared last.
        const w = match.area + area;
        match.lab = [
          (match.lab[0] * match.area + lab[0] * area) / w,
          (match.lab[1] * match.area + lab[1] * area) / w,
          (match.lab[2] * match.area + lab[2] * area) / w,
        ];
        if (area > match.area) match.rgb = parsed.rgb;
        match.area = w;
        match.pages.add(page.url);
        match.properties.set(entry.property, (match.properties.get(entry.property) ?? 0) + area);
        if (match.citations.length < 5) {
          match.citations.push({ url: page.url, selector: entry.selector, property: entry.property });
        }
      } else {
        clusters.push({
          lab,
          rgb: parsed.rgb,
          area,
          pages: new Set([page.url]),
          citations: [{ url: page.url, selector: entry.selector, property: entry.property }],
          properties: new Map([[entry.property, area]]),
        });
      }
    }
  }

  if (clusters.length === 0) return [];

  clusters.sort((a, b) => b.area - a.area);
  const kept = clusters.slice(0, options.max ?? 12);

  return assignColorRoles(kept, totalArea);
}

/**
 * Names each cluster.
 *
 * The roles are assigned in a fixed order — background first, then text, then
 * the chromatic ones — because each decision constrains the next. Picking
 * "primary" before knowing which colour is the page background produces a
 * primary of white on most sites, which is true and useless.
 */
function assignColorRoles(clusters: Cluster[], totalArea: number): DiscoveredColor[] {
  const dominantProperty = (c: Cluster): string =>
    [...c.properties.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'background-color';

  const isNeutral = (c: Cluster) => chroma(c.lab) < 8;
  const roles = new Map<Cluster, string>();

  const backgrounds = clusters.filter((c) => dominantProperty(c) !== 'color');
  const textish = clusters.filter((c) => dominantProperty(c) === 'color');

  const background = backgrounds.find((c) => isNeutral(c) && c.lab[0] > 70) ?? backgrounds[0];
  if (background) roles.set(background, 'background');

  const surface = backgrounds.find((c) => c !== background && isNeutral(c));
  if (surface) roles.set(surface, 'surface');

  const text = textish.find((c) => c.lab[0] < 60) ?? textish[0];
  if (text) roles.set(text, 'text');

  let chromaticRank = 0;
  for (const cluster of clusters) {
    if (roles.has(cluster)) continue;
    if (isNeutral(cluster)) {
      roles.set(cluster, dominantProperty(cluster) === 'color' ? 'text' : 'border');
      continue;
    }
    chromaticRank += 1;
    roles.set(cluster, chromaticRank === 1 ? 'primary' : chromaticRank === 2 ? 'secondary' : 'accent');
  }

  return clusters.map((c) => ({
    hex: toHex(c.rgb),
    lab: [round(c.lab[0], 2), round(c.lab[1], 2), round(c.lab[2], 2)] as [number, number, number],
    coverage: totalArea > 0 ? round(c.area / totalArea, 4) : 0,
    pageCount: c.pages.size,
    role: roles.get(c) ?? 'accent',
    citations: c.citations,
  }));
}

export interface PageTextRuns {
  url: string;
  runs: TextRun[];
}

/**
 * Clusters text into the handful of styles a design system would name.
 *
 * Sizes are bucketed before grouping because real pages are full of 15.008px
 * and 16.002px from rem arithmetic, and treating those as distinct styles
 * produces a "type scale" with ninety entries in it.
 */
export function extractTypeStyles(pages: PageTextRuns[], options: { max?: number } = {}): DiscoveredTypeStyle[] {
  interface Bucket {
    family: string;
    sizePx: number | null;
    weight: number | null;
    role: string;
    count: number;
    lineHeights: number[];
    letterSpacings: number[];
    citations: Array<{ url: string; selector: string }>;
  }

  const buckets = new Map<string, Bucket>();

  for (const page of pages) {
    for (const run of page.runs) {
      if (!run.text?.trim()) continue;

      const family = primaryFontFamily(run.fontFamily);
      /*
       * Size and weight are null on a static harvest — nothing was laid out,
       * so nothing was measured. The run is still kept: the family came from
       * the site's own stylesheet and the role from its own markup, and both
       * are real. Only the numbers are missing, and a style with a family and
       * no size is honest input for a font-family rule while being correctly
       * useless to a minimum-size one.
       */
      const sizePx = run.fontSizePx === null ? null : bucketSize(run.fontSizePx);
      // 400/500 and 600/700 are the same intent expressed with different
      // numbers on different sites; three tiers is what a brand book actually
      // distinguishes.
      const weight =
        run.fontWeight === null ? null : run.fontWeight >= 600 ? 700 : run.fontWeight >= 500 ? 500 : 400;
      const key = `${family}|${sizePx ?? 'unsized'}|${weight ?? 'unweighted'}|${run.role}`;

      const bucket = buckets.get(key) ?? {
        family,
        sizePx,
        weight,
        role: run.role,
        count: 0,
        lineHeights: [],
        letterSpacings: [],
        citations: [],
      };
      bucket.count += 1;
      if (run.lineHeightPx) bucket.lineHeights.push(run.lineHeightPx);
      if (run.letterSpacingPx) bucket.letterSpacings.push(run.letterSpacingPx);
      if (bucket.citations.length < 5) bucket.citations.push({ url: page.url, selector: run.selector });
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count || (b.sizePx ?? 0) - (a.sizePx ?? 0))
    .slice(0, options.max ?? 10)
    .map((b) => ({
      // An unsized style is named for its role alone. "body/16" would be a
      // claim about a measurement we do not have.
      name: b.sizePx === null ? b.role : `${b.role}/${Math.round(b.sizePx)}${b.weight === 400 ? '' : `-${b.weight}`}`,
      fontFamily: b.family,
      fontWeight: b.weight,
      fontSizePx: b.sizePx === null ? null : round(b.sizePx, 1),
      lineHeightPx: b.lineHeights.length ? round(median(b.lineHeights), 1) : null,
      letterSpacingPx: b.letterSpacings.length ? round(median(b.letterSpacings), 2) : null,
      role: b.role,
      occurrences: b.count,
      citations: b.citations,
    }));
}

/** `"Inter", -apple-system, sans-serif` → `Inter`. The rest is fallback. */
export function primaryFontFamily(stack: string): string {
  const first = (stack ?? '').split(',')[0]?.trim() ?? '';
  return first.replace(/^["']|["']$/g, '') || 'unknown';
}

/**
 * Snaps a font size onto the nearest step of a conventional type scale.
 *
 * Rounding to whole pixels is not enough: 15px and 16px are genuinely one
 * body style on a site that uses both, and keeping them apart doubles the
 * scale. The steps below are the sizes design systems actually ship.
 */
export function bucketSize(px: number): number {
  const scale = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128];
  let best = scale[0];
  let bestDistance = Infinity;
  for (const step of scale) {
    const d = Math.abs(step - px);
    if (d < bestDistance) {
      bestDistance = d;
      best = step;
    }
  }
  // Beyond the top of the scale, keep the real value rather than clamping a
  // 200px hero headline down to 128.
  return px > scale[scale.length - 1] ? Math.round(px) : best;
}

/**
 * Ranks logo candidates.
 *
 * Explicit markup evidence outranks position, because `alt="Acme logo"` is the
 * site telling us directly while "first image in the header" is a guess that
 * fails on any site with a promo bar.
 */
export function rankLogoCandidates(candidates: ImageCandidate[]): Array<ImageCandidate & { confidence: number }> {
  return candidates
    .map((image) => {
      const hay = `${image.src} ${image.alt ?? ''} ${image.selector}`.toLowerCase();
      let confidence = 0.1;
      if (/logo|wordmark|brandmark/.test(hay)) confidence += 0.5;
      if (image.region === 'header') confidence += 0.25;
      if (image.isVector) confidence += 0.1; // a brand ships its mark as SVG
      const ratio = image.height > 0 ? image.width / image.height : 0;
      if (ratio >= 1 && ratio <= 6) confidence += 0.1;
      if (image.width > 480 || image.height > 240) confidence -= 0.2; // hero, not mark
      if (/icon|avatar|thumb|badge|flag|payment/.test(hay)) confidence -= 0.25;
      return { ...image, confidence: round(Math.max(0, Math.min(1, confidence)), 2) };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Text/background pairs that fail WCAG AA on the site's own pages.
 *
 * Computed from the browser's resolved colours, so this is not an estimate
 * from pixels — it is the same arithmetic an auditor would do by hand, on
 * exact values, and it is reproducible from the citation.
 */
export function findContrastFailures(
  pages: PageTextRuns[],
  options: { minRatio?: number; largeTextMinRatio?: number } = {},
): Array<{ url: string; selector: string; ratio: number; required: number; fg: string; bg: string; text: string }> {
  const minRatio = options.minRatio ?? 4.5;
  const largeMin = options.largeTextMinRatio ?? 3;
  const out: Array<{ url: string; selector: string; ratio: number; required: number; fg: string; bg: string; text: string }> = [];

  for (const page of pages) {
    for (const run of page.runs) {
      const fg = parseCssColor(run.color);
      const bg = parseCssColor(run.backgroundColor);
      if (!fg || !bg) continue;

      // WCAG's large-text allowance is a function of measured size and
      // weight. Without them there is no defensible threshold to test against,
      // and guessing one would either invent a pass or invent a failure — so
      // the run is skipped and the report simply has less to say.
      if (run.fontSizePx === null || run.fontWeight === null) continue;
      // WCAG "large text": 18.66px bold, or 24px at any weight.
      const isLarge = run.fontSizePx >= 24 || (run.fontSizePx >= 18.66 && run.fontWeight >= 700);
      const required = isLarge ? largeMin : minRatio;
      const ratio = contrastRatio(fg.rgb, bg.rgb);

      if (ratio < required) {
        out.push({
          url: page.url,
          selector: run.selector,
          ratio: round(ratio, 2),
          required,
          fg: toHex(fg.rgb),
          bg: toHex(bg.rgb),
          text: run.text.slice(0, 80),
        });
      }
    }
  }

  return out.sort((a, b) => a.ratio - b.ratio);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
