import type { Dimension, Severity, Tier } from './rules.js';
import { REGULATED_RULE_PACKS } from './rule-packs-regulated.js';

/* ==========================================================================
 * THE BASELINE CATALOGUE — what BrandLens checks before anybody writes a rule.
 *
 * A brand created five minutes ago has no rules, so checking it returns
 * nothing, and asking a customer to author forty rules before the product does
 * anything is how onboarding dies. These packs are the answer: standards that
 * are true for any brand, inherited live, overridable one rule at a time.
 *
 * THREE THINGS DECIDED THE SHAPE OF THIS FILE.
 *
 * 1. Most analyzers read their expected values from the ONTOLOGY, not from the
 *    rule. `logo.presence` compares against the brand's logo variants;
 *    `copy.banned_terms` reads the tenant lexicon. Only 15 of the 40 analyzers
 *    need nothing — and a rule whose ontology dependency is empty returns
 *    `not_applicable`, never `fail`.
 *
 *    That is the whole design constraint. A pack built on ontology-free checks
 *    produces verdicts on day one. A pack built on the rest is inert until the
 *    brand fills something in — which is fine, and useful, so long as nobody
 *    mistakes a green screen full of `not_applicable` for a passing brand.
 *    Every template below records `needs` for exactly this reason, and the
 *    console can then say "12 rules are waiting on your logo files" instead of
 *    showing twelve silent passes.
 *
 * 2. Nothing here cries wolf. Every analyzer degrades to `not_applicable` or
 *    `insufficient_evidence` when its inputs are missing — verified, not
 *    assumed — so shipping these active cannot fail a brand for data it has
 *    not supplied yet. The exceptions are marked `proposed`: a CTA allowlist
 *    nobody has written, a mood target nobody has agreed. Those are judgements
 *    the brand has to make, and a default would be us making it for them.
 *
 * 3. Every `check.params` key is one the analyzer actually reads, asserted
 *    against the generated manifest by rule-packs.spec.ts. An unrecognised key
 *    is not an error at check time — the analyzer takes its default — so a
 *    baseline rule with a typo would ship a threshold to every tenant and
 *    enforce a different one. That happened to 56 of the 57 rules in the
 *    Northwind seed before this guard existed.
 * ========================================================================== */

export interface SeedRuleTemplate {
  key: string;
  statement: string;
  rationale: string;
  dimension: Dimension;
  tier: Tier;
  severity: Severity;
  weight: number;
  check: { fn: string; params?: Record<string, unknown> };
  rubric?: Record<string, unknown>;
  citation?: Record<string, unknown>;
  /** `proposed` where the threshold is the brand's judgement to make. */
  defaultStatus?: 'active' | 'proposed';
  /** Plain-language note beside the rule in the console. */
  guidance: string;
  /**
   * Ontology this rule needs before it can produce a verdict. Empty means it
   * works on a brand nobody has configured. This is asserted against the
   * analyzer manifest, so it cannot drift from what the engine actually reads.
   */
  needs?: string[];
  /**
   * Ontology the analyzer READS but this template supplies itself in params.
   *
   * Several analyzers fall back to the ontology only when the rule is silent:
   * `vlm.subject_appropriateness` uses `params.prohibitedSubjects` if given and
   * the brand's image style profile otherwise. The manifest records that the
   * code touches the profile, because it does — but a template that passes its
   * own list is not waiting on one, and telling a customer it is would send
   * them to configure something that would change nothing.
   *
   * `needs` plus this must equal what the manifest says the analyzer reads, so
   * the substitution is a claim somebody made deliberately rather than an
   * omission. Only list an attribute here when the params genuinely replace it.
   */
  satisfiedByParams?: string[];
  scope?: Record<string, unknown>;
}

export interface SeedRulePack {
  key: string;
  name: string;
  description: string;
  category: 'baseline' | 'regulated' | 'heuristic';
  enabledByDefault: boolean;
  jurisdictions?: string[];
  authority?: string;
  docsUrl?: string;
  templates: SeedRuleTemplate[];
}

/* ==========================================================================
 * 1 — ACCESSIBILITY
 *
 * The only pack that is entirely ontology-free, and therefore the only one
 * that produces a full verdict on a brand with nothing configured. It is also
 * the one nobody argues with: no brand's guidelines say text should be hard
 * to read. Everything here is an external standard, so provenance on the
 * compiled rules is `transfer` and each carries its WCAG success criterion.
 * ========================================================================== */
const ACCESSIBILITY: SeedRulePack = {
  key: 'accessibility-wcag-aa',
  name: 'Accessibility — WCAG 2.2 AA',
  description:
    'Contrast, legibility and alternative text at the level most organisations are already committed to, ' +
    'and many are legally required to meet. Works on a brand with nothing else configured.',
  category: 'baseline',
  enabledByDefault: true,
  authority: 'W3C — Web Content Accessibility Guidelines 2.2',
  docsUrl: 'https://www.w3.org/TR/WCAG22/',
  templates: [
    {
      key: 'accessibility.contrast-aa',
      statement: 'Text must meet WCAG 2.2 AA contrast: 4.5:1 for body text, 3:1 for large text.',
      rationale:
        'Contrast is arithmetic over a measured foreground and background, so this is exact rather than ' +
        'estimated. The threshold for each run is derived from its own size and weight — which is why the ' +
        'rule sets a level rather than a ratio: one ratio applied to every run would fail large type that ' +
        'the standard passes.',
      dimension: 'accessibility',
      tier: 'deterministic',
      severity: 'major',
      weight: 1.5,
      check: { fn: 'accessibility.contrast', params: { level: 'AA' } },
      citation: { doc: 'WCAG 2.2', criterion: '1.4.3 Contrast (Minimum)', level: 'AA' },
      guidance:
        'The worst text run on the asset decides the verdict. If a run fails, the finding names the two ' +
        'colours and the ratio they achieve, so the fix is a specific colour change rather than a review.',
    },
    {
      key: 'accessibility.font-size-floor',
      statement: 'No text may be set below 9pt — about 12px on a 96dpi screen.',
      rationale:
        'An absolute floor beneath whatever the brand’s own type scale says, so a mislabelled style cannot ' +
        'smuggle 6pt copy through. It is the rule that catches small print, which is where illegibility ' +
        'does its real damage.',
      dimension: 'accessibility',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      check: { fn: 'accessibility.font_size_floor', params: { minSizePt: 9 } },
      citation: { doc: 'WCAG 2.2', criterion: '1.4.4 Resize Text', note: 'applied as an absolute floor' },
      guidance:
        'Points, not pixels: the engine measures type in points and converts using the asset’s DPI, so this ' +
        'floor holds whether the asset is a 1080px social post or an A4 print file.',
    },
    {
      key: 'accessibility.alt-text',
      statement: 'Every image asset must carry alternative text of at least 12 characters that is not its filename.',
      rationale:
        'Alt text is a submission field rather than a property of the creative, and requiring it at check ' +
        'time is the only point in the process where anyone will supply it. "image" satisfies a presence ' +
        'check and helps nobody, so adequacy is what gets measured.',
      dimension: 'accessibility',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.5,
      check: { fn: 'accessibility.alt_text', params: { minChars: 12, maxChars: 250 } },
      citation: { doc: 'WCAG 2.2', criterion: '1.1.1 Non-text Content', level: 'A' },
      // The only rule in this pack that fails rather than abstains on a brand
      // that has supplied nothing, because missing alt text IS the finding.
      // Failing every asset on day one over a field the upload flow may not
      // even collect yet would teach people to switch the pack off.
      defaultStatus: 'proposed',
      guidance:
        'Activate this once alt text is part of how assets reach you. Until then it would fail every ' +
        'submission for a field nobody was asked to fill in.',
    },
  ],
};

/* ==========================================================================
 * 2 — LAYOUT CRAFT
 *
 * Also ontology-free: these are properties of the artwork, not of the brand.
 * A margin is a margin. Weighted low and mostly minor, because craft problems
 * are real but rarely the reason a campaign gets pulled — and a pack that
 * blocks releases over an off-grid element gets switched off within a week.
 * ========================================================================== */
const LAYOUT: SeedRulePack = {
  key: 'craft-layout',
  name: 'Layout craft',
  description:
    'Margins, overlap and safe zones — the defects that read as a production error rather than a brand ' +
    'decision. Measured from the artwork, so no brand configuration is required.',
  category: 'baseline',
  enabledByDefault: true,
  templates: [
    {
      key: 'layout.outer-margin',
      statement: 'Content must keep at least 4% of the canvas clear on every edge.',
      rationale:
        'Content that touches the edge reads as a crop error, and gets clipped outright by rounded-corner ' +
        'containers and platform chrome. 4% is deliberately loose: it catches artwork that bleeds off, not ' +
        'artwork that is merely tight.',
      dimension: 'layout',
      tier: 'cv',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'layout.margins', params: { minMarginPct: 4 } },
      guidance:
        'A percentage of the canvas, not a pixel count, so it holds across every size the same artwork is ' +
        'exported at. Raise it if your placements crop aggressively.',
    },
    {
      key: 'layout.no-element-overlap',
      statement: 'Text must not overlap other text or imagery elements.',
      rationale:
        'Overlap is almost never a design choice — it is an overflow bug, usually a market whose copy ran ' +
        'longer than the box. Catching it here names the real cause instead of leaving a reviewer to guess ' +
        'from a screenshot.',
      dimension: 'layout',
      tier: 'cv',
      severity: 'major',
      weight: 1,
      check: { fn: 'layout.element_overlap', params: { maxIou: 0.05, kinds: ['text', 'image'] } },
      guidance:
        'Measured as intersection-over-union between element boxes, so a descender crossing a rule line ' +
        'does not fire. A genuine collision does.',
    },
    {
      key: 'layout.safe-zone',
      statement: 'Nothing important may sit within 5% of the canvas edge on placements with platform chrome.',
      rationale:
        'Safe zones are where the channel puts its own furniture — a caption bar, a lower third, a print ' +
        'bleed. Content there is not ugly, it is invisible or trimmed off.',
      dimension: 'layout',
      tier: 'cv',
      severity: 'major',
      weight: 1,
      check: { fn: 'layout.safe_zone', params: { insetPct: 5, intrusionToleranceFrac: 0.02 } },
      // The check prefers the published zones for whatever placement the asset
      // declares — TikTok's caption bar is 310px up from the bottom of a
      // 1920px canvas while its action rail is 120px in from the right, and no
      // uniform band expresses that. `insetPct` is the fallback for an asset
      // whose placement is not in the registry, and it is a stand-in, which is
      // why the rule arrives proposed rather than active.
      defaultStatus: 'proposed',
      guidance:
        'Assets tagged with a platform and placement are checked against that placement’s published safe ' +
        'zones. The 5% band applies only to assets that are not, and it is a placeholder — activate this ' +
        'once you have seen it run against your own work.',
    },
    {
      key: 'layout.text-density',
      statement: 'Text should occupy no more than 8 of the 25 cells of the canvas grid.',
      rationale:
        'The platform that invented the 20%-text rule withdrew it in 2021, and it applies to one ad format, ' +
        'so this is advisory and carries zero weight: it can never block a release. It is reported because ' +
        'clients still ask for the number, and delivery is still suppressed on text-heavy creative.',
      dimension: 'layout',
      tier: 'cv',
      severity: 'advisory',
      weight: 0,
      check: { fn: 'layout.text_density', params: { cells: 5, maxOccupiedCells: 8 } },
      guidance:
        'Advisory by construction — weight 0 means it appears in the report and cannot move the score.',
    },
    {
      key: 'layout.grid-alignment',
      statement: 'Element edges should align to a 12-column grid.',
      rationale:
        'Off-grid elements are the visual signature of hand-nudged work. Advisory rather than enforced, ' +
        'because plenty of good layouts break the grid deliberately.',
      dimension: 'layout',
      tier: 'cv',
      severity: 'advisory',
      weight: 0.25,
      check: {
        fn: 'layout.grid_alignment',
        params: { columns: 12, gutterPct: 2, marginPct: 5, tolerancePct: 1, maxOffGridRatio: 0.3 },
      },
      // Proposed: 12 columns is the most common convention but it IS a
      // convention. A brand on an 8- or 16-column system would see this fail
      // on correct work, and a rule that is wrong about the grid is worse
      // than no grid rule.
      defaultStatus: 'proposed',
      guidance: 'Set `columns` to your own grid before activating. 12 is a common default, not a standard.',
    },
  ],
};

/* ==========================================================================
 * 3 — LOGO CRAFT
 *
 * Everything here needs `logo_variants`, so on a brand that has uploaded no
 * logo files every rule abstains. That is the correct behaviour and it is why
 * the pack can ship enabled: it costs nothing until there is something to
 * check, and the moment a logo is uploaded seven checks start working.
 *
 * Thresholds are the ones a designer would recognise as generous. The point of
 * a baseline is to catch the stretched logo nobody noticed, not to argue about
 * clear space.
 * ========================================================================== */
const LOGO: SeedRulePack = {
  key: 'craft-logo',
  name: 'Logo craft',
  description:
    'Distortion, occlusion, recolouring and minimum size — the misuse a brand book spends its first ten ' +
    'pages forbidding. Starts working the moment a logo variant is uploaded.',
  category: 'baseline',
  enabledByDefault: true,
  templates: [
    {
      key: 'logo.no-distortion',
      statement: 'The logo must never be stretched, squashed, rotated or skewed. Scale proportionally only.',
      rationale:
        'A 2% aspect deviation is invisible to whoever made it and glaring beside the correct mark. This is ' +
        'arithmetic on the detected region, so it costs nothing and is never a matter of opinion.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'logo.distortion',
        params: { maxAspectDistortion: 1.02, maxRotationDeg: 1.5, maxShear: 0.02 },
      },
      needs: ['logo_variants'],
      guidance:
        '`maxAspectDistortion` is a ratio: 1.02 allows 2% off square. Rotation is permitted up to 1.5° ' +
        'because scan and photograph sources are never perfectly square.',
    },
    {
      key: 'logo.no-occlusion',
      statement: 'Nothing may overlap the logo — not gradients, not scrims, not the edge of the canvas.',
      rationale:
        'A partially covered mark reads as a rendering failure. The tolerance is 2% rather than zero ' +
        'because anti-aliasing at the mark’s edge is not occlusion.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'major',
      weight: 1.5,
      check: { fn: 'logo.occlusion', params: { maxCoverageFrac: 0.02, maxIou: 0.02 } },
      needs: ['logo_variants'],
      guidance: 'Raise the tolerance if your lockups deliberately sit over imagery.',
    },
    {
      key: 'logo.presence',
      statement: 'Brand-facing creative must carry an approved logo variant.',
      rationale:
        'An unbranded asset buys reach for nobody. This is the floor, not a style preference — but it is ' +
        'scoped to nothing by default, and plenty of legitimate assets carry no mark, so it ships proposed ' +
        'until somebody scopes it to the channels where it is genuinely required.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'logo.presence', params: { minScore: 0.7 } },
      needs: ['logo_variants'],
      // The analyzer's default minScore is 0.0 — any match at all. 0.7 is a
      // real threshold; the point of stating it is that leaving it unset would
      // make a blocker-severity rule pass on the weakest possible detection.
      defaultStatus: 'proposed',
      guidance:
        'Scope this to the channels where a mark is contractually required before activating. As a global ' +
        'rule it fails every asset that legitimately has no logo on it.',
    },
    {
      key: 'logo.clearspace',
      statement: 'The logo must be surrounded by clear space of at least 0.5× its height on every side.',
      rationale:
        'Clear space is what stops the mark reading as part of the layout. Half its height is the most ' +
        'permissive value any brand book uses, chosen so the baseline catches crowding rather than ' +
        'disagreeing with the brand’s own figure.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'minor',
      weight: 0.5,
      check: { fn: 'logo.clearspace', params: { clearSpaceMultiple: 0.5, basis: 'height' } },
      needs: ['logo_variants'],
      guidance:
        'Your brand book almost certainly specifies a larger multiple. Fork this rule and set it — the ' +
        'variant’s own `clearSpaceMultiple` constraint takes precedence if you set it there instead.',
    },
    {
      key: 'logo.min-size',
      statement: 'The logo must occupy at least 4% of the canvas height.',
      rationale:
        'Below roughly this the counters of a wordmark close up at typical mobile pixel densities. Stated ' +
        'as a share of canvas height because an absolute pixel figure stops meaning anything the moment ' +
        'the same artwork is exported at another size.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'logo.min_size', params: { minHeightPct: 4 } },
      needs: ['logo_variants'],
      guidance:
        'The engine measures the detected mark’s HEIGHT. If your guidelines specify a minimum width, ' +
        'convert it using your lockup’s aspect ratio rather than assuming the two are interchangeable.',
    },
    {
      key: 'logo.no-recolour',
      statement: 'The logo may only appear in the brand’s approved colours or in solid black or white.',
      rationale:
        'Recolouring the mark destroys the one asset every other brand element is anchored to. The check ' +
        'clusters the non-transparent pixels of the detected region, so a knockout on a coloured field ' +
        'does not read as a recoloured mark.',
      dimension: 'logo',
      tier: 'cv',
      severity: 'major',
      weight: 1.5,
      check: { fn: 'logo.recolor', params: { maxDeltaE: 5, ignoreNeutrals: true, minClusterShare: 0.08 } },
      needs: ['color_tokens', 'logo_variants'],
      guidance:
        'The permitted colours come from your design tokens. `ignoreNeutrals` keeps black and white ' +
        'versions passing without listing them.',
    },
  ],
};

/* ==========================================================================
 * 4 — TYPOGRAPHY CRAFT
 *
 * Two of these are ontology-free in spirit but not in fact: every typography
 * analyzer resolves rendered runs against `type_styles`, so the pack starts
 * working when the brand declares its type scale — which discovery does
 * automatically from a website crawl.
 * ========================================================================== */
const TYPOGRAPHY: SeedRulePack = {
  key: 'craft-typography',
  name: 'Typography craft',
  description:
    'The brand’s own type scale, enforced: approved families, per-style size floors, a hierarchy that ' +
    'still reads, and no substituted or synthesised fonts.',
  category: 'baseline',
  enabledByDefault: true,
  templates: [
    {
      key: 'typography.real-cuts-only',
      statement:
        'The real font must be used: no system fallback family, no unembedded font in print artwork, and ' +
        'no synthesised bold or italic.',
      rationale:
        'Three symptoms of one failure — the intended font was not available when the file was rendered. ' +
        'Times New Roman and Calibri are specific renderer fallbacks; faux bold is what a renderer draws ' +
        'when the real weight is missing. None of the three is a matter of taste.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'typography.fallback_font', params: {} },
      needs: ['type_styles'],
      guidance:
        'This is usually the highest-value typography rule in the set, because it catches a broken ' +
        'production pipeline rather than a styling preference.',
    },
    {
      key: 'typography.approved-family',
      statement: 'Type must be set in one of the brand’s approved families.',
      rationale:
        'Closed-set verification against the declared type styles: the check resolves each rendered run ' +
        'against the approved families rather than attempting open-set font identification, which is why ' +
        'it is reliable enough to enforce.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'major',
      weight: 1.5,
      check: { fn: 'typography.approved_family', params: { fuzzyThreshold: 88, minChars: 3 } },
      needs: ['forbidden_fonts', 'type_styles'],
      guidance:
        'The approved list is your type styles — this rule takes no list of its own, so there is nothing ' +
        'here to keep in step with the ontology.',
    },
    {
      key: 'typography.min-size',
      statement: 'Type must not be set below the minimum size declared for its style.',
      rationale:
        'Each style carries its own floor because each is read at a different distance: body copy at arm’s ' +
        'length on a phone, legal copy under scrutiny or not at all. One number applied to headlines and ' +
        'small print alike is either too strict for one or useless for the other.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      check: { fn: 'typography.min_size', params: {} },
      needs: ['type_styles'],
      guidance:
        'Set `minSizePx` on each type style in the ontology. Setting `minSizePt` on this rule instead ' +
        'replaces every per-style floor with one global number, which is rarely what anyone wants.',
    },
    {
      key: 'typography.hierarchy',
      statement: 'Consecutive steps in the type scale must differ by at least 1.15×.',
      rationale:
        'A flattened scale is the most common symptom of a template used as a canvas. 1.15 is the loosest ' +
        'ratio at which two sizes still read as deliberately different.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.5,
      check: { fn: 'typography.hierarchy', params: { minStepRatio: 1.15 } },
      needs: ['type_styles'],
      guidance:
        'Compares adjacent ranked styles as rendered. It counts no headings — nothing in an asset says ' +
        'which run was meant to be the H1.',
    },
    {
      key: 'typography.casing',
      statement: 'Type must follow the casing declared for its style.',
      rationale:
        'Casing rules are per style and live in the ontology; this rule enforces whatever is declared ' +
        'there. The all-caps ceiling is separate and applies whether or not a style declares anything.',
      dimension: 'typography',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.5,
      check: { fn: 'typography.casing', params: { maxAllCapsRatio: 0.35, minChars: 8 } },
      needs: ['type_styles'],
      // Proposed: an all-caps ceiling is a stylistic position, and a brand
      // whose display face is all-caps by design would fail its own correct work.
      defaultStatus: 'proposed',
      guidance:
        'Activate once your type styles declare their casing. The 35% all-caps ceiling is a starting ' +
        'point — raise it if your display style is set in caps by design.',
    },
  ],
};

/* ==========================================================================
 * 5 — CHANNEL CONFORMANCE
 *
 * One rule, because the analyzer validates an entire placement spec in a
 * single pass: dimensions, aspect ratio, format, file size, print resolution.
 * Splitting it into five rules would report one measurement as five
 * independent confirmations — which is exactly what the Northwind seed did
 * until this audit.
 *
 * The spec comes from the shipped channel registry, which is platform data
 * every tenant can read, so this works on day one for any asset whose channel
 * is known.
 * ========================================================================== */
const CHANNEL: SeedRulePack = {
  key: 'channel-conformance',
  name: 'Channel specifications',
  description:
    'Dimensions, aspect ratio, format, file size and print resolution against the published spec for the ' +
    'placement. The platform rejects these on upload anyway — catching them here saves the round trip.',
  category: 'baseline',
  enabledByDefault: true,
  authority: 'BrandLens channel spec registry',
  templates: [
    {
      key: 'channel.conformance',
      statement: 'The asset must match the published specification for the placement it is destined for.',
      rationale:
        'Arithmetic on the file header — no model, no ambiguity, and a rejection at this point costs ' +
        'minutes instead of a full production round trip.',
      dimension: 'channel_spec',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'channel_spec.conformance', params: {} },
      guidance:
        'Leave the spec unset so the rule reads the registry for whatever channel each asset declares. ' +
        'Setting `spec` here pins one placement and makes the rule wrong for every other. What this rule ' +
        'does need is a platform and placement on the asset: without them no spec resolves and it reports ' +
        'not applicable rather than passing.',
    },
  ],
};

/* ==========================================================================
 * 6 — COPY HYGIENE
 *
 * Readability and locale are ontology-free; the lexicon rules wait for a
 * lexicon. Nothing here is a house-style opinion — a readability floor is not
 * an instruction to write simply, it is a floor beneath which copy is
 * measurably harder to read than the category average for no gain.
 * ========================================================================== */
const COPY: SeedRulePack = {
  key: 'copy-hygiene',
  name: 'Copy hygiene',
  description:
    'Readability, market spelling, approved calls to action and the tenant lexicon. The checks that catch ' +
    'copy problems nobody would defend if they saw them.',
  category: 'baseline',
  enabledByDefault: true,
  templates: [
    {
      key: 'copy.readability',
      statement: 'Consumer copy should read no harder than US grade 12.',
      rationale:
        'A ceiling rather than a target: it catches the paragraph that turned into a legal clause, not ' +
        'prose with long words in it. Below about 20 words a readability formula measures noise, so short ' +
        'copy is skipped rather than scored.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'advisory',
      weight: 0.25,
      check: { fn: 'copy.readability', params: { maxFleschKincaidGrade: 12, minWords: 20 } },
      guidance:
        'Advisory on purpose. If your category genuinely reads at postgraduate level, raise the ceiling ' +
        'rather than switching the rule off — the number in the report is still worth having.',
    },
    {
      key: 'copy.locale-spelling',
      statement: 'Copy must use the spelling convention of the market it is destined for.',
      rationale:
        '"Harbor" in the UK and "Harbour" in the US are both wrong, and both are invisible to whoever ' +
        'wrote the master. This is the classic localisation defect: cheap to detect, embarrassing to ship.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'copy.locale_spelling', params: {} },
      guidance:
        'Takes the locale from the asset rather than from the rule, so one rule covers every market. ' +
        'Currently applies to English locales only; other languages abstain.',
    },
    {
      key: 'copy.banned-terms',
      statement: 'No term marked banned in the brand lexicon may appear in any copy field.',
      rationale:
        'One linear pass over the tenant lexicon regardless of term count, and exact on matches. The list ' +
        'lives in the ontology, so the rule needs no maintenance as the lexicon grows.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'major',
      weight: 1.5,
      check: { fn: 'copy.banned_terms', params: {} },
      needs: ['lexicon'],
      guidance:
        'Abstains until the lexicon has banned terms in it. A `terms` list on the rule EXTENDS the lexicon ' +
        'rather than replacing it, and hits from it are tagged so you can tell the two apart.',
    },
    {
      key: 'copy.required-terms',
      statement: 'Terms marked required in the brand lexicon must appear in brand-facing copy.',
      rationale:
        'Usually the brand name itself: unaided recall needs the name in the copy, and a mark alone does ' +
        'not carry it.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'copy.required_terms', params: {} },
      needs: ['lexicon'],
      guidance: 'Abstains until the lexicon has required terms in it.',
    },
    {
      key: 'copy.cta-allowlist',
      statement: 'The call to action must come from the approved list.',
      rationale:
        'CTA wording is measured and optimised centrally in most organisations, and ad-hoc CTAs make that ' +
        'measurement meaningless. Exact match after normalisation, not fuzzy — "Learn More!" is not ' +
        '"Learn more", and in this one case that distinction is the point.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.5,
      check: { fn: 'copy.cta_allowlist', params: { caseSensitive: false } },
      // Proposed and empty: there is no universal set of approved CTAs, and an
      // allowlist we invented would fail every asset. The analyzer abstains
      // when the list is empty, so this is safe either way — but shipping it
      // active would be shipping an empty rule as though it were a standard.
      defaultStatus: 'proposed',
      guidance:
        'Fork this and add your own `allowed` list before activating. With no list the check abstains, ' +
        'which is honest but does nothing.',
    },
  ],
};

/* ==========================================================================
 * 7 — LEGAL HYGIENE
 *
 * The claims register is the object regulated customers actually buy, and
 * these two rules are what make it load-bearing rather than a spreadsheet.
 *
 * Both abstain on an empty register — verified, because an active
 * substantiation rule that failed every asset mentioning anything would be the
 * fastest possible way to get the pack disabled.
 * ========================================================================== */
const LEGAL: SeedRulePack = {
  key: 'legal-hygiene',
  name: 'Claims and disclaimers',
  description:
    'Every factual claim traced to the register, in date, and approved for the market it runs in — plus ' +
    'the disclaimers those claims require.',
  category: 'baseline',
  enabledByDefault: true,
  templates: [
    {
      key: 'legal.claims-substantiated',
      statement:
        'Every factual claim in the copy must match a registered claim that is in date and approved for ' +
        'this market.',
      rationale:
        'Three failures with one cause: an unregistered claim is unapproved, a lapsed one is a claim whose ' +
        'evidence expired, and a claim substantiated for one market is not substantiated in another. The ' +
        'register is walked once and all three are applied to every match.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'copy.claim_substantiation', params: { fuzzyThreshold: 88 } },
      needs: ['claims', 'disclaimers'],
      citation: { doc: 'CAP Code s.3.7 (substantiation); FTC Act s.5' },
      guidance:
        '`fuzzyThreshold` is a 0–100 similarity score: how close asset copy must be to the registered ' +
        'wording to count as the same claim. Lower it if your copy paraphrases claims heavily.',
    },
    {
      key: 'legal.disclaimer-present',
      statement:
        'Where a claim requires a disclaimer, that disclaimer must appear in full wherever the claim does.',
      rationale:
        'Presence and wording. Legibility is enforced separately by the accessibility pack, which measures ' +
        'it — a disclaimer rule that claimed to check size and contrast without measuring them would pass ' +
        'the 5pt grey small print it promised to catch.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'copy.disclaimer_present', params: { fuzzyThreshold: 85 } },
      needs: ['claims', 'disclaimers'],
      citation: { doc: 'FTC .com Disclosures (2013) — clear and conspicuous; CAP Code s.3.9' },
      guidance:
        'Truncating the small print is the failure this catches. Proximity to the claim is not measured by ' +
        'any check yet, so do not read a pass here as "the disclaimer is where it should be".',
    },
  ],
};

/* ==========================================================================
 * 8 — BRAND CONSISTENCY (heuristic)
 *
 * The judgement half. Everything above measures something with a defensible
 * threshold; these compare against a learned or declared model of the brand,
 * and the honest thing to say about them is that they are opinions with
 * evidence attached.
 *
 * The pack is enabled by default because the measured members of it —
 * palette conformance, forbidden colours — are as solid as anything in the
 * craft packs. The VLM members ship proposed: they cost money per call, they
 * need a rubric the brand agrees with, and an unreviewed model verdict
 * carrying weight in a score is exactly what the calibration machinery exists
 * to prevent.
 * ========================================================================== */
const CONSISTENCY: SeedRulePack = {
  key: 'brand-consistency',
  name: 'Brand consistency',
  description:
    'Palette conformance, competitor colours, imagery style and voice — the checks that ask whether an ' +
    'asset looks and sounds like this brand rather than whether it is well made.',
  category: 'heuristic',
  enabledByDefault: true,
  templates: [
    {
      key: 'color.palette-conformance',
      statement: 'Significant colour regions must fall within ΔE00 5 of an approved token or one of its tints.',
      rationale:
        'ΔE00 5 is roughly where a side-by-side difference becomes visible to an untrained eye — tight ' +
        'enough to catch a wrong swatch, loose enough to survive JPEG compression and a screenshot.',
      dimension: 'color',
      tier: 'cv',
      severity: 'major',
      weight: 1.5,
      check: {
        fn: 'color.palette_conformance',
        params: { maxDeltaE: 5, minShare: 0.03, ignoreNeutrals: true, allowTints: true, maxOffendingShare: 0.05 },
      },
      needs: ['color_tokens'],
      guidance:
        'Photography is excluded by default — a photograph is not a palette decision. `maxOffendingShare` ' +
        'allows 5% of the surface to be off-palette before the asset fails.',
    },
    {
      key: 'color.forbidden',
      statement: 'No significant surface may read as a colour the brand has marked forbidden.',
      rationale:
        'Usually a competitor’s equity colour. A creative that reads as somebody else at a glance is worse ' +
        'than one that reads as nobody.',
      dimension: 'color',
      tier: 'cv',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'color.forbidden', params: { maxDeltaE: 8, minShare: 0.02 } },
      needs: ['forbidden_colors'],
      guidance:
        'Abstains until at least one token is marked forbidden. ΔE00 8 is deliberately looser than the ' +
        'palette rule: reading AS a competitor colour is a wider target than matching one.',
    },
    {
      key: 'imagery.style-conformance',
      statement: 'Photography must sit within the brand’s learned image style.',
      rationale:
        '"Our photography is warm and candid" is unwritable as a rule. Fitted from an approved corpus it ' +
        'becomes a distance with a boundary, which is a rule — and one whose failures can be shown as ' +
        'nearest neighbours rather than asserted.',
      dimension: 'imagery',
      tier: 'cv',
      severity: 'minor',
      weight: 1,
      check: { fn: 'imagery.style_conformance', params: {} },
      needs: ['image_style_profile'],
      guidance:
        'The boundary comes from the fitted profile. Abstains until a profile has been fitted from your ' +
        'approved assets.',
    },
    {
      key: 'imagery.medium',
      statement: 'Imagery must use one of the brand’s permitted mediums.',
      rationale:
        'Categories saturate: when every competitor ships the same generic 3D render, being photographic ' +
        'is a distinctiveness asset rather than a preference.',
      dimension: 'imagery',
      tier: 'cv',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'imagery.medium', params: { minConfidence: 0.45 } },
      needs: ['image_style_profile'],
      guidance: 'The permitted mediums come from the image style profile. Abstains until one exists.',
    },
    {
      key: 'copy.voice-tone',
      statement: 'Copy must sit on the "we are" side of every brand voice attribute.',
      rationale:
        'Tone is genuinely a judgement, and pretending otherwise would put a fake number on a real ' +
        'opinion. Each attribute carries a we-are / we-are-not pair, so the judge answers a bounded ' +
        'question rather than "does this sound on-brand".',
      dimension: 'copy',
      tier: 'vlm',
      severity: 'minor',
      weight: 1,
      check: { fn: 'vlm.voice_tone', params: {} },
      needs: ['voice_attributes'],
      rubric: {
        kind: 'binary',
        question:
          'For each voice attribute, does this copy sit on the "we are" side rather than the "we are not" ' +
          'side? Use the brand’s own exemplars as the standard.',
        passWhen: 'Every attribute is satisfied, or the copy is neutral with respect to it.',
        failWhen: 'Any attribute is clearly violated.',
        usePrecedents: true,
        cropTo: 'text',
      },
      // Proposed: this costs a model call per asset, and until a few human
      // decisions have accrued the calibration cannot tell whether the judge
      // agrees with this brand's reviewers. Weighting an uncalibrated verdict
      // into a score is what the calibration machinery exists to prevent.
      defaultStatus: 'proposed',
      guidance:
        'Activate once you have voice attributes defined and are comfortable spending a model call per ' +
        'asset. The first decisions your reviewers make on it become its calibration.',
    },
    {
      key: 'imagery.subject-appropriateness',
      statement: 'Subject matter must be appropriate for the market and audience it runs in.',
      rationale:
        'Catches the culturally specific problem that no enumerated subject list anticipates — which is ' +
        'the case where a judge genuinely beats a rule, and one of the few.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'major',
      weight: 1,
      check: { fn: 'vlm.subject_appropriateness', params: {} },
      needs: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question: 'Is anything depicted here inappropriate or likely to cause offence in this market?',
        passWhen: 'Nothing inappropriate is depicted.',
        failWhen: 'Something is clearly inappropriate for this market.',
        usePrecedents: true,
        cropTo: 'full',
      },
      defaultStatus: 'proposed',
      guidance:
        'Add `sensitivities` for the markets you publish in — the specific things your legal or local ' +
        'teams already know to avoid. Without them the judge is working from general knowledge.',
    },
    {
      key: 'brand.overall-judgment',
      statement: 'Taken as a whole, would a brand manager approve this asset without changes?',
      rationale:
        'The catch-all, running last so the judge sees every cheap verdict already banked. Its verdict ' +
        'never moves the score — weight is zero and it can only raise a finding — because a holistic ' +
        'opinion is a safety net for what the rules missed, not a rule.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'advisory',
      weight: 0,
      check: { fn: 'vlm.overall_judgment', params: {} },
      rubric: {
        kind: 'binary',
        question:
          'Considering the brand context and the findings already raised, would a brand manager approve ' +
          'this asset as-is?',
        passWhen: 'Yes, or the only issues are advisory.',
        failWhen: 'No — there is a problem the specific rules did not catch.',
        usePrecedents: true,
        cropTo: 'full',
      },
      defaultStatus: 'proposed',
      guidance:
        'Costs a model call per asset and cannot affect the score. Worth activating once the specific ' +
        'rules are settled and you want to know what they are still missing.',
    },
  ],
};

/**
 * The baseline and heuristic packs, plus the opt-in regulated ones.
 *
 * Regulated packs live in their own file because they are a different kind of
 * object: jurisdictional, off by default, and every template carries a
 * citation to a rulebook somebody can be held to. Mixing them in here would
 * make it too easy to add one that quietly ships enabled.
 */
/* ==========================================================================
 * 9 — CAMPAIGN COMPOSITION (heuristic, opt-in)
 *
 * The pack that exists because `vlm.rubric` does.
 *
 * Every rule here is a sentence somebody wrote about their own creative —
 * "the headline must be about the experience we are selling", "the people in
 * the hero must not be pushed to an edge". None of them is expressible as a
 * threshold, and before the generic rubric judge none of them was expressible
 * at all without shipping a new analyzer. They are the shape a brand's real
 * feedback takes, which is the whole reason this analyzer was worth building.
 *
 * Off by default, and every rule proposed: the questions below are examples of
 * the FORM, not standards anybody signed. A brand rewrites the question in its
 * own words and activates the ones it means. Shipping them active would be
 * asserting an opinion about somebody else's campaign.
 * ========================================================================== */
const COMPOSITION: SeedRulePack = {
  key: 'campaign-composition',
  name: 'Campaign composition',
  description:
    'Whether a piece of creative actually does the job the brief set — subject placement, headline relevance, ' +
    'whether the message survives a glance. Judged against a rubric you write, not a threshold we chose.',
  category: 'heuristic',
  enabledByDefault: false,
  templates: [
    {
      key: 'composition.subject-central',
      statement: 'The people experiencing the activity must be centrally positioned within the banner.',
      rationale:
        'A subject shoved to an edge reads as a crop error rather than a composition, and it is the first ' +
        'thing that breaks when one master is re-cut for six placements. The judge is given each detected ' +
        'element’s centre and its distance from the canvas centre, so this is a question about measured ' +
        'geometry rather than an impression of the picture.',
      dimension: 'layout',
      tier: 'vlm',
      severity: 'major',
      weight: 1,
      check: { fn: 'vlm.rubric', params: {} },
      rubric: {
        kind: 'ordinal',
        question:
          'Where does the human subject sit in this banner? Use the measured element positions: ' +
          '`offsetFromCenter` is 0 at the centre of the canvas and about 0.71 at a corner.',
        levels: [
          { value: 0, label: 'Cropped', anchor: 'The subject is cut by the frame edge or mostly outside it.' },
          { value: 1, label: 'Pushed out', anchor: 'The subject is whole but crowded against one edge.' },
          { value: 2, label: 'Off-centre', anchor: 'Deliberately offset, still comfortably inside the frame.' },
          { value: 3, label: 'Centred', anchor: 'The subject holds the middle of the composition.' },
        ],
        passWhen: 'The subject scores 2 or above — off-centre by choice is fine, pushed out is not.',
        failWhen: 'The subject scores 1 or below, or is cut by the frame.',
        usePrecedents: true,
        cropTo: 'full',
      },
      defaultStatus: 'proposed',
      guidance:
        'Rewrite the question for what your creative actually shows — "the product", "the presenter", "the ' +
        'vehicle" — before activating. The measured positions reach the judge either way.',
    },
    {
      key: 'composition.headline-on-brief',
      statement: 'The headline must be centred on the experience the campaign is selling.',
      rationale:
        'A headline that is merely evocative rather than about the thing being sold is the most common note ' +
        'a creative director gives, and the one no keyword check can express. It is also the one that costs ' +
        'the most to catch late, because the copy is usually locked by then.',
      dimension: 'copy',
      tier: 'vlm',
      severity: 'major',
      weight: 1,
      // `crop_to: text` means no image tokens burn on a question about words,
      // and the copy is handed over by default.
      check: { fn: 'vlm.rubric', params: {} },
      rubric: {
        kind: 'binary',
        question:
          'Is this headline about the experience the campaign is selling, or is it atmospheric wording that ' +
          'could sit on any campaign in the category?',
        passWhen: 'The headline names or clearly evokes the specific experience being advertised.',
        failWhen: 'The headline is generic mood-setting that would fit an unrelated campaign unchanged.',
        usePrecedents: true,
        cropTo: 'text',
      },
      defaultStatus: 'proposed',
      guidance:
        'Name the experience in the question — "the snowboarding experience", "the test drive" — before ' +
        'activating. Left generic, the judge has to guess what the campaign is about, and it will.',
    },
    {
      key: 'composition.survives-a-glance',
      statement: 'The primary message must be legible and complete at thumbnail size.',
      rationale:
        'Most placements are seen at a fraction of the size they were designed at, scrolling. This is the ' +
        'question a designer answers by squinting at the artboard, and it has no threshold — but the judge ' +
        'is given the canvas and every text element’s area, so "too small to read at this size" is grounded.',
      dimension: 'layout',
      tier: 'vlm',
      severity: 'minor',
      weight: 0.75,
      check: { fn: 'vlm.rubric', params: {} },
      rubric: {
        kind: 'binary',
        question:
          'At the size this will actually be seen — a thumbnail in a feed — does the primary message still ' +
          'land? Consider the measured area each text element occupies, not only whether it is present.',
        passWhen: 'The main message reads at a glance without zooming.',
        failWhen: 'The message depends on text too small or too crowded to read at thumbnail size.',
        usePrecedents: true,
        cropTo: 'full',
      },
      defaultStatus: 'proposed',
      guidance:
        'The accessibility pack already enforces an absolute size floor. This asks the different question of ' +
        'whether the message survives the context, which no floor can answer.',
    },
  ],
};

export const SEED_RULE_PACKS: SeedRulePack[] = [
  ACCESSIBILITY,
  LAYOUT,
  LOGO,
  TYPOGRAPHY,
  CHANNEL,
  COPY,
  LEGAL,
  CONSISTENCY,
  COMPOSITION,
  ...REGULATED_RULE_PACKS,
];
