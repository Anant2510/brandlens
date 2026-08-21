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

  const dominant = corroborated.find((c) => c.role === 'primary');
  if (dominant && dominant.coverage >= 0.02) {
    rules.push({
      key: 'color.primary-presence',
      version: 1,
      statement: `The primary brand colour ${dominant.hex} should be present in brand-facing creative.`,
      rationale: `Observed on ${dominant.pageCount} of ${input.pageCount} pages, covering ${(dominant.coverage * 100).toFixed(1)}% of painted area.`,
      dimension: 'color',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.6,
      scope: {},
      check: { fn: 'color.dominance_ratio', params: { hex: dominant.hex, minShare: 0.01, maxDeltaE: 5 } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: input.pageCount,
        agreement: round(dominant.pageCount / input.pageCount, 3),
        note: SEED_NOTE,
        observed: [{ hex: dominant.hex, coverage: dominant.coverage }],
      } as RuleDefinition['support'],
    });
  }

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
      check: { fn: 'typography.approved_family', params: { families: approved, allowFallbacks: true } },
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
   * Body and legal type get SEPARATE floors.
   *
   * Legal copy is conventionally set smaller than body, so folding the two
   * together does one of two bad things: it drags the body floor down to the
   * size of the disclaimer, or — if legal is excluded, as it was until the
   * end-to-end test caught it — it never examines the one place where
   * illegibly small type actually appears. Small print is where a legibility
   * rule earns its keep.
   */
  for (const band of [
    { key: 'typography.min-size', label: 'Body copy', roles: ['body', 'caption'] },
    { key: 'typography.min-size-legal', label: 'Legal and disclaimer copy', roles: ['legal'] },
  ]) {
    const sizes = input.typeStyles.filter((s) => band.roles.includes(s.role)).map((s) => s.fontSizePx);
    if (sizes.length === 0) continue;

    const floor = Math.min(...sizes);
    // The floor is what the site does; 12px is the accessibility line below
    // which "that is just their style" stops being a defence.
    const proposed = Math.max(12, Math.round(floor));

    rules.push({
      key: band.key,
      version: 1,
      statement: `${band.label} must be at least ${proposed}px.`,
      rationale:
        floor < 12
          ? `The site's own smallest ${band.label.toLowerCase()} is ${floor.toFixed(0)}px, below the 12px ` +
            'legibility floor. The rule proposes 12px rather than codifying the smaller value.'
          : `The smallest ${band.label.toLowerCase()} observed on the site is ${floor.toFixed(0)}px.`,
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.8,
      scope: {},
      check: { fn: 'typography.min_size', params: { minPx: proposed, appliesTo: band.roles } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: sizes.length,
        agreement: round(sizes.filter((s) => s >= proposed).length / sizes.length, 3),
        note: floor < 12 ? `The site currently violates this rule: its smallest is ${floor.toFixed(0)}px.` : SEED_NOTE,
        observed: [{ observedFloorPx: round(floor, 1), proposedPx: proposed }],
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
      check: { fn: 'typography.hierarchy', params: { minRatio: 1.25 } },
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
    check: { fn: 'accessibility.contrast', params: { minRatio: 4.5, largeTextMinRatio: 3, largeTextPx: 24 } },
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
      check: { fn: 'logo.presence', params: { minConfidence: 0.6 } },
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
      check: { fn: 'logo.clearspace', params: { multiple: 0.5, basis: 'height' } },
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
