import type { DiscoveredColor, DiscoveredTypeStyle, RuleDefinition } from '@brandlens/contracts';

/* ==========================================================================
 * Measurements → proposed rules.
 *
 * The whole point of discovery is that nobody wrote this brand's rules down.
 * So they are inferred from what the site consistently DOES, and every rule
 * carries the evidence that produced it: how many pages agreed, what the
 * measured spread was, which selector it came from.
 *
 * Two disciplines make the output defensible rather than impressive:
 *
 *   1. Nothing is proposed from a single page. One page is a design choice;
 *      several pages agreeing is a convention. `minPages` is the floor and
 *      rules that fail it are simply not emitted.
 *
 *   2. Every rule lands as `status: 'proposed'` with `provenance: 'inductive'`
 *      and a populated `support` block. A human activates it or does not.
 *      A tool that silently turned observations into enforced policy would be
 *      worse than useless — it would enshrine whatever the site got wrong.
 * ========================================================================== */

export interface SynthesisInput {
  colors: DiscoveredColor[];
  typeStyles: DiscoveredTypeStyle[];
  pageCount: number;
  logoDetected: boolean;
  /** Text/background pairs already found failing WCAG on the site itself. */
  contrastFailures: number;
}

export interface SynthesisOptions {
  /** Pages a pattern must appear on before it can become a rule. */
  minPages?: number;
}

const SEED_NOTE =
  'Proposed from the brand’s own public site. Review the evidence before activating: ' +
  'a convention the site follows is not necessarily a standard the brand intends.';

export function synthesizeRules(input: SynthesisInput, options: SynthesisOptions = {}): RuleDefinition[] {
  // With one or two pages there is no such thing as a corroborated pattern,
  // so the floor never drops below 2 however small the crawl was.
  const minPages = Math.max(2, options.minPages ?? Math.min(3, Math.ceil(input.pageCount / 2)));
  const rules: RuleDefinition[] = [];

  const corroborated = input.colors.filter((c) => c.pageCount >= minPages);
  const brandColors = corroborated.filter((c) => ['primary', 'secondary', 'accent'].includes(c.role));
  const paletteForCheck = corroborated.filter((c) => c.role !== 'border');

  /* ---------------------------------------------------------------- colour */
  if (paletteForCheck.length >= 2) {
    rules.push({
      key: 'color.palette-conformance',
      version: 1,
      statement:
        `Colours must fall within ΔE00 3 of the ${paletteForCheck.length} palette colours observed ` +
        `across ${input.pageCount} pages of the brand's site.`,
      rationale:
        'Every page measured painted with this palette. A colour outside it is either a new brand decision ' +
        'or a mistake, and both are worth a human look.',
      dimension: 'color',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      scope: {},
      check: {
        fn: 'color.palette_conformance',
        params: { maxDeltaE: 3, minShare: 0.03, ignoreNeutrals: true, allowTints: true, maxOffendingShare: 0.05 },
      },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: input.pageCount,
        agreement: round(mean(paletteForCheck.map((c) => c.pageCount / input.pageCount)), 3),
        note: SEED_NOTE,
        observed: paletteForCheck.map((c) => ({ hex: c.hex, role: c.role, pages: c.pageCount })),
      } as RuleDefinition['support'],
    });
  }

  /*
   * There is deliberately NO "the primary colour must be present" rule here.
   *
   * The engine has no colour-presence analyzer. The nearest thing,
   * `color.dominance_ratio`, checks something else entirely: whether the mix of
   * primary/secondary/accent matches a declared 60/30/10-style split. Pointing
   * a presence statement at it produced a rule that read one way in the console
   * and failed assets for a different reason — and the ratio it would have
   * enforced was never measured, because a website's paint ratios are not a
   * creative's. A homepage is mostly white with a small mark; the ad it links
   * to is mostly brand colour. Both are correct.
   *
   * The primary colour and its coverage are recorded in the ontology, which is
   * where an observation belongs. `color.palette-conformance` above carries the
   * part discovery can actually evidence: colours must come from the palette.
   */

  /* ------------------------------------------------------------ typography */
  const families = new Map<string, number>();
  for (const style of input.typeStyles) {
    families.set(style.fontFamily, (families.get(style.fontFamily) ?? 0) + style.occurrences);
  }
  // A family used twice is somebody's embedded widget, not the brand's type.
  const approved = [...families.entries()]
    .filter(([family, uses]) => uses >= 3 && family !== 'unknown')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([family]) => family);

  if (approved.length > 0) {
    rules.push({
      key: 'typography.approved-family',
      version: 1,
      statement: `Type must be set in ${formatList(approved)}.`,
      rationale: `These are the families the site actually renders with, ranked by how much text each sets.`,
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      scope: {},
      // No `families` parameter: the analyzer resolves every run against the
      // brand's approved type styles in the ontology — which this same
      // discovery run wrote — and takes only matching tuning from params. A
      // `families` array here would be read by nobody and drift from the
      // ontology the moment either side changed.
      check: { fn: 'typography.approved_family', params: {} },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: input.pageCount,
        agreement: 1,
        note: SEED_NOTE,
        observed: approved.map((f) => ({ family: f, uses: families.get(f) ?? 0 })),
      } as RuleDefinition['support'],
    });
  }

  /**
   * Size floors come in two kinds, and they are enforced by two DIFFERENT
   * analyzers. Getting this wrong is easy and silent, so it is written down.
   *
   *   * The brand's own scale — "body is never smaller than 16px, legal never
   *     smaller than 12px" — is per style, and `typography.min_size` reads it
   *     from the ontology's type styles, NOT from `check.params`. The only
   *     parameter it accepts is `minSizePt`, and that is a single GLOBAL floor
   *     that overrides every style at once. Passing the body floor there would
   *     fail every line of legal copy on the asset, which is the opposite of
   *     what a per-band rule was for. Discovery already writes `minSizePx` on
   *     each type style, so the rule needs no parameters at all.
   *
   *   * The absolute legibility floor — "nobody can read 6pt" — is not the
   *     brand's business and applies where the guidelines are silent. That is
   *     `accessibility.font_size_floor`, which reads nothing from the ontology
   *     and so still works on a brand nobody has configured.
   *
   * An earlier version emitted two `typography.min_size` rules with `minPx`
   * and `appliesTo`. The analyzer reads neither: both rules displayed a
   * threshold in the console and enforced the ontology's floors regardless.
   */
  const sizedStyles = input.typeStyles.filter((s) => s.fontSizePx > 0);
  if (sizedStyles.length > 0) {
    const perRole = [...new Map(sizedStyles.map((s) => [s.role, s])).keys()].sort();
    rules.push({
      key: 'typography.min-size',
      version: 1,
      statement: 'Type must not be set smaller than the minimum recorded for its style.',
      rationale:
        `Each of the ${sizedStyles.length} type styles discovered on the site carries the smallest size it ` +
        `was observed at (${perRole.join(', ')}). The rule holds creative to the brand's own scale rather ` +
        'than to one number applied to headlines and small print alike.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.8,
      scope: {},
      // Intentionally empty. Floors are per style and live in the ontology;
      // `minSizePt` here would be a single global override.
      check: { fn: 'typography.min_size', params: {} },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: sizedStyles.length,
        agreement: 1,
        note: SEED_NOTE,
        observed: sizedStyles.map((s) => ({ style: s.name, role: s.role, floorPx: round(s.fontSizePx, 1) })),
      } as RuleDefinition['support'],
    });

    const smallestPx = Math.min(...sizedStyles.map((s) => s.fontSizePx));
    // 9pt is 12px at 96dpi — the line below which "that is just their style"
    // stops being a defence. Proposed even when the site already clears it,
    // because it is the rule that catches the 9px footer nobody reviewed.
    const floorPt = 9;
    rules.push({
      key: 'accessibility.font-size-floor',
      version: 1,
      statement: `No text may be set below ${floorPt}pt (about ${Math.round((floorPt * 96) / 72)}px on screen).`,
      rationale:
        smallestPx < 12
          ? `The smallest type on the site measures ${smallestPx.toFixed(0)}px, below the legibility floor. ` +
            'The rule proposes the floor rather than codifying the smaller value the site currently uses.'
          : `The smallest type on the site measures ${smallestPx.toFixed(0)}px, already at or above the floor. ` +
            'The rule locks that in for creative the site does not cover.',
      dimension: 'accessibility',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      scope: {},
      check: { fn: 'accessibility.font_size_floor', params: { minSizePt: floorPt } },
      // Transfer, not inductive: a legibility floor is an external standard.
      // Labelling it inductive would claim the site taught us the number.
      provenance: 'transfer',
      status: 'proposed',
      support: {
        sampleSize: sizedStyles.length,
        agreement: 1,
        note:
          smallestPx < 12
            ? `The site currently violates this rule: its smallest type is ${smallestPx.toFixed(0)}px.`
            : 'An absolute floor, imported as a standard rather than inferred from the site.',
        observed: [{ smallestObservedPx: round(smallestPx, 1), proposedFloorPt: floorPt }],
      } as RuleDefinition['support'],
    });
  }

  const hasDisplay = input.typeStyles.some((s) => s.role === 'display');
  const hasBody = input.typeStyles.some((s) => s.role === 'body');
  if (hasDisplay && hasBody) {
    rules.push({
      key: 'typography.hierarchy',
      version: 1,
      statement: 'Headline, subhead and body must be visually distinct in size or weight.',
      rationale: 'The site maintains a clear type hierarchy; creative that flattens it reads as off-brand.',
      dimension: 'typography',
      tier: 'cv',
      severity: 'minor',
      weight: 0.6,
      scope: {},
      check: { fn: 'typography.hierarchy', params: { minStepRatio: 1.25 } },
      provenance: 'inductive',
      status: 'proposed',
      support: { sampleSize: input.pageCount, agreement: 1, note: SEED_NOTE } as RuleDefinition['support'],
    });
  }

  /* --------------------------------------------------------------- a11y */
  rules.push({
    key: 'accessibility.contrast',
    version: 1,
    statement: 'Text must meet WCAG 2.2 AA contrast: 4.5:1 for body, 3:1 for large text.',
    rationale:
      input.contrastFailures > 0
        ? `Proposed as a standard the brand does not currently meet: ${input.contrastFailures} text/background ` +
          'pairs on the site fail AA today.'
        : 'The site already meets AA throughout; the rule locks that in.',
    dimension: 'accessibility',
    tier: 'deterministic',
    // Transfer, not inductive: WCAG is an external standard we are importing,
    // and labelling it inductive would imply the site taught us the threshold.
    provenance: 'transfer',
    severity: 'major',
    weight: 1,
    scope: {},
    // `level`, not `minRatio`. A `minRatio` is a single ratio applied to every
    // run regardless of size, so passing 4.5 here would hold large text to the
    // body threshold and fail headlines that WCAG passes at 3:1 — a rule
    // stricter than its own statement, which is how a rule gets switched off.
    // With `level` the analyzer derives the per-run threshold from size and
    // weight, which is what the statement above describes.
    check: { fn: 'accessibility.contrast', params: { level: 'AA' } },
    status: 'proposed',
    support: {
      sampleSize: input.pageCount,
      agreement: 1,
      note: 'WCAG 2.2 AA. Imported as a standard, not inferred from the site.',
      observed: [{ currentFailures: input.contrastFailures }],
    } as RuleDefinition['support'],
  });

  /* --------------------------------------------------------------- logo */
  if (input.logoDetected) {
    rules.push({
      key: 'logo.presence',
      version: 1,
      statement: 'The brand logo must appear in brand-facing creative.',
      rationale: 'A logo was identified in the site header and is present across the crawled pages.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'blocker',
      weight: 1,
      scope: {},
      // `minScore`, not `minConfidence`. The analyzer's default is 0.0, so the
      // misnamed key meant any match at all counted as the logo being present.
      check: { fn: 'logo.presence', params: { minScore: 0.6 } },
      provenance: 'inductive',
      status: 'proposed',
      support: { sampleSize: input.pageCount, agreement: 1, note: SEED_NOTE } as RuleDefinition['support'],
    });

    rules.push({
      key: 'logo.clearspace',
      version: 1,
      statement: 'The logo must be surrounded by clear space of at least 0.5× its height on every side.',
      rationale:
        'A conservative default: clear space cannot be measured reliably from a web header, where the ' +
        'surrounding nav is intentionally close. Confirm against the brand book before activating.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'minor',
      weight: 0.5,
      scope: {},
      check: { fn: 'logo.clearspace', params: { clearSpaceMultiple: 0.5, basis: 'height' } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: input.pageCount,
        // Explicitly low: this is a default, not a measurement, and the number
        // says so rather than the rule pretending to evidence it does not have.
        agreement: 0.3,
        note: 'Default value, not measured. Discovery cannot infer clear space from a web page layout.',
      } as RuleDefinition['support'],
    });
  }

  return rules;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
