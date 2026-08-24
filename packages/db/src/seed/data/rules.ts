/* ==========================================================================
 * The rule set for Northwind Coffee Co.
 *
 * 45 rules across all nine dimensions and all four tiers. 33 are `active` and
 * feed the published ruleset; 12 are left `proposed` — a mix of `deductive`
 * extractions carrying page + bbox citations and `inductive` proposals
 * carrying their statistical support — so the rule-review screen has real
 * work waiting on first boot.
 *
 * It was 57 until an audit against the analyzer manifest. Twelve of those were
 * either duplicates of a rule already here — four channel-spec rules running
 * the identical single-pass validation, three claim rules walking the register
 * the same way — or checks no analyzer could perform, like disclaimer
 * proximity and German expansion headroom. Every one of them displayed a
 * threshold in the console and enforced something else, or nothing.
 *
 * Three things are load-bearing here and none is decoration:
 *
 *   `check.fn` must name an analyzer registered in
 *   apps/engine/brandlens_engine/registry.py. An unknown fn does not crash —
 *   the pipeline reports `insufficient_evidence` with the name in the
 *   observation — but it does mean a criterion that never evaluates.
 *
 *   `check.params` keys must be keys that analyzer actually reads. An
 *   unrecognised key is not an error either: the analyzer falls back to its
 *   default, so the rule shows a threshold nobody is held to. `validate.ts`
 *   asserts this against the generated manifest before the seed writes a row,
 *   and the statements here are written in the units the engine measures in —
 *   points not pixels, ratios not percentages, height not width — because a
 *   rule that reads correctly and computes something else is the failure this
 *   file is most prone to.
 *
 *   `status` starts at `proposed` for everything machine-derived. A rule the
 *   customer has not confirmed must never influence a verdict; that
 *   separation is the whole reason the audit trail is defensible when the
 *   rules were extracted by a model (see docs/adr/0008).
 * ========================================================================== */

import type { ScopeSelector } from '../lib/ids.js';

export type Dimension =
  | 'logo'
  | 'color'
  | 'typography'
  | 'layout'
  | 'imagery'
  | 'copy'
  | 'accessibility'
  | 'channel_spec'
  | 'legal';

export type Tier = 'deterministic' | 'cv' | 'vlm' | 'hybrid';
export type Severity = 'blocker' | 'major' | 'minor' | 'advisory';
export type Provenance = 'deductive' | 'inductive' | 'transfer' | 'manual';
export type Status = 'proposed' | 'active' | 'deprecated' | 'rejected';

export interface SeedRule {
  key: string;
  version?: number;
  /**
   * Which brand owns the rule. Sub-brand scoping is expressed by attaching
   * the rule to the sub-brand's own `brands` row rather than by the `scope`
   * lattice: the check pipeline resolves the lattice from the ASSET's
   * coordinates (market / channel / assetType / campaign), and an asset row
   * carries no sub-brand column, so a `scope.subBrands` constraint would
   * never match anything. Ownership is the mechanism that actually works.
   */
  brand?: 'northwind' | 'reserve';
  statement: string;
  rationale: string;
  dimension: Dimension;
  tier: Tier;
  severity: Severity;
  weight: number;
  scope?: ScopeSelector;
  check: { fn: string; params?: Record<string, unknown> };
  rubric?: Record<string, unknown>;
  provenance: Provenance;
  citation?: Record<string, unknown>;
  support?: Record<string, unknown>;
  status: Status;
  calibration?: Record<string, unknown>;
}

/** The brand book every deductive rule cites. */
const BOOK = 'Northwind Brand Guidelines v4.2 (2026)';

export const SEED_RULES: SeedRule[] = [
  /* =====================================================================
   * LOGO — 7 rules
   * ================================================================== */
  {
    key: 'logo.presence',
    statement: 'Every outbound asset must carry an approved Northwind logo variant.',
    rationale: 'An unbranded asset buys reach for nobody. This is the floor, not a style preference.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'blocker',
    weight: 2,
    // `minScore`, not `minSimilarity`. The analyzer's default is 0.0, so a
    // misnamed key means the weakest possible match satisfies a blocker.
    // No `requiredVariantIds`: any approved variant counts.
    check: { fn: 'logo.presence', params: { minScore: 0.82 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 8, bbox: [0.08, 0.12, 0.92, 0.34], extractedBy: 'brandbook-extractor@1.0' },
    status: 'active',
  },
  {
    key: 'logo.clearspace',
    statement:
      'Clear space around the logomark must be at least 1.35× the logomark height on all four sides. No other element may enter it.',
    rationale:
      'Clear space is what stops the mark reading as part of the layout. 1.35X was measured from the master lockup artwork, not chosen.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1.5,
    check: { fn: 'logo.clearspace', params: { clearSpaceMultiple: 1.35, basis: 'height' } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 11, bbox: [0.1, 0.2, 0.9, 0.62], extractedBy: 'brandbook-extractor@1.0' },
    status: 'active',
  },
  {
    key: 'logo.min-size.digital',
    statement: 'The logo must occupy at least 6% of the canvas height on any digital placement.',
    rationale:
      'Stated as a share of canvas height because that is what the engine measures — the detected mark’s ' +
      'height against the canvas. The brand book’s 120px figure is an absolute width and does not survive ' +
      'a change of canvas size; 6% is the same requirement expressed so it holds on every placement.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    scope: { channels: ['meta-feed', 'meta-story', 'meta-reel', 'tiktok-in-feed', 'linkedin-feed', 'display', 'amazon-a-plus'] },
    // `minHeightPct`, in PERCENT. The old `minWidthPct: 0.08` was wrong twice:
    // the analyzer measures height, and it compares against a percentage, so
    // 0.08 would have meant 0.08% of the canvas rather than 8%.
    check: { fn: 'logo.min_size', params: { minHeightPct: 6 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 12, bbox: [0.12, 0.14, 0.88, 0.4] },
    status: 'active',
  },
  {
    key: 'logo.min-size.print',
    statement: 'The logo must reproduce at least 12mm tall in print.',
    rationale:
      'Below this the roastery date stamp in the mark fills in on uncoated stock. Stated as height because ' +
      'the engine measures the detected mark’s height and converts to millimetres using the file’s DPI.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    scope: { channels: ['print-a4', 'print-a5'] },
    // DPI is not a parameter of this check — it comes from the file, and the
    // 300dpi requirement is enforced by the channel spec rule instead.
    check: { fn: 'logo.min_size', params: { minHeightMm: 12 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 12, bbox: [0.12, 0.44, 0.88, 0.66] },
    status: 'active',
  },
  {
    key: 'logo.no-distortion',
    statement: 'The logo must never be stretched, squashed, rotated or skewed. Scale proportionally only.',
    rationale:
      'A 2% aspect deviation is invisible to the person who made it and glaring beside the correct mark. Arithmetic catches it for free.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'blocker',
    weight: 2,
    // A ratio, not a percentage: 1.02 is "at most 2% off square".
    check: { fn: 'logo.distortion', params: { maxAspectDistortion: 1.02, maxRotationDeg: 0.5 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 14, bbox: [0.08, 0.1, 0.92, 0.55] },
    status: 'active',
  },
  {
    key: 'logo.approved-colorways',
    statement:
      'The logo may only appear in Espresso, Cream, solid black or solid white. Never in Copper, Pine, Brass or any photographic fill.',
    rationale: 'Recolouring the mark destroys the single asset every other brand element is anchored to.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1.5,
    check: {
      fn: 'logo.recolor',
      params: { allowedHexes: ['#2B1B12', '#F4EDE1', '#000000', '#FFFFFF'], maxDeltaE: 6 },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 15, bbox: [0.1, 0.18, 0.9, 0.72] },
    status: 'active',
  },
  {
    key: 'logo.placement.corner',
    statement:
      'On digital creative the logo sits in the top-left or bottom-right quadrant. Centre placement is reserved for packaging.',
    rationale:
      'Induced from the approved corpus: 47 of 52 approved assets place the mark in one of those two quadrants.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'minor',
    weight: 0.5,
    scope: { channels: ['meta-feed', 'meta-story', 'linkedin-feed', 'display'] },
    // Anchors, not zones. The analyzer snaps the mark to the nearest of nine
    // named anchors and checks membership; there is no positional tolerance
    // to configure because the snap already absorbs it.
    check: { fn: 'logo.placement', params: { allowedAnchors: ['top-left', 'bottom-right'] } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 90, observedValue: 0.904 },
    // Left proposed: an induced convention is a hypothesis about the brand,
    // not a rule the brand has agreed to.
    status: 'proposed',
  },

  /* =====================================================================
   * COLOR — 4 rules
   * ================================================================== */
  {
    key: 'color.palette-conformance',
    statement:
      'Every significant colour region must be within ΔE 5 of an approved token or one of its declared tints.',
    rationale:
      'ΔE 5 is roughly where a side-by-side difference becomes visible to an untrained eye — tight enough to catch a wrong swatch, loose enough to survive JPEG.',
    dimension: 'color',
    tier: 'cv',
    severity: 'major',
    weight: 1.5,
    check: {
      fn: 'color.palette_conformance',
      // `minShare` is a FRACTION, not a percentage: the old `minClusterSharePct: 3`
      // would have meant 300% had the key been read at all.
      params: { maxDeltaE: 5, minShare: 0.03, k: 8, excludePhotoRegions: true, ignoreNeutrals: true },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 22, bbox: [0.06, 0.1, 0.94, 0.5] },
    status: 'active',
  },
  {
    key: 'color.forbidden-competitor',
    statement: 'No surface may fall within ΔE 12 of a registered competitor equity colour.',
    rationale:
      'Two colours are marked `forbidden` in the token set. A creative that reads as a competitor at a glance is worse than an off-brand one.',
    dimension: 'color',
    tier: 'cv',
    severity: 'blocker',
    weight: 2,
    // The forbidden hexes themselves come from the tokens marked `forbidden`
    // in the ontology; `forbiddenHexes` here would override them.
    check: { fn: 'color.forbidden', params: { maxDeltaE: 12, minShare: 0.02 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    /*
     * One balance rule, not two share rules.
     *
     * `color.dominance_ratio` attributes measured area to the nearest token,
     * groups it by the token's ROLE, normalises, and compares the whole mix
     * against a declared split. It cannot express "espresso + cream ≥ 55%" or
     * "copper ≤ 18%" — those name individual tokens and set one-sided bounds,
     * and it does neither. Two rules pointed at it computed the identical mix
     * and compared it against two different targets, so at most one of them
     * could ever have been right.
     */
    key: 'color.palette-balance',
    statement:
      'The brand palette must read roughly 60% primary, 30% secondary, 10% accent by painted area, ' +
      'excluding photography.',
    rationale:
      'The distinctiveness asset is the ground, not the mark: Espresso and Cream carry the surface and ' +
      'Copper accents it. Induced from the approved corpus, with a wide band because the split shifts ' +
      'legitimately between a packshot and a promotion.',
    dimension: 'color',
    tier: 'cv',
    severity: 'minor',
    weight: 1,
    check: {
      fn: 'color.dominance_ratio',
      params: {
        roleRatios: { primary: 0.6, secondary: 0.3, accent: 0.1 },
        tolerancePct: 15,
        maxDeltaE: 8,
        excludePhotoRegions: true,
      },
    },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 10, observedValue: 0.58 },
    status: 'active',
  },
  {
    key: 'color.reserve-inversion',
    statement:
      'Northwind Reserve creative uses the Obsidian ground with Cream ink and Brass accents. Copper must not appear at all.',
    rationale: 'The sub-brand is defined by the inversion. Mixing the two accent colours collapses the distinction.',
    dimension: 'color',
    tier: 'cv',
    severity: 'major',
    weight: 1.25,
    brand: 'reserve',
    check: {
      fn: 'color.forbidden',
      params: { forbiddenHexes: ['#C2703D'], maxDeltaE: 8, minShare: 0.02 },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 61, bbox: [0.08, 0.12, 0.92, 0.46] },
    status: 'active',
  },

  /* =====================================================================
   * TYPOGRAPHY — 4 rules
   * ================================================================== */
  {
    key: 'typography.approved-families',
    statement: 'All type must be set in Sole Serif Display or Inter. No other family may appear.',
    rationale:
      'Closed-set verification: three approved faces means we render candidates and compare, rather than attempting open-set font identification.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'major',
    weight: 1.5,
    // The approved families live in the ontology's type styles; this check
    // resolves every rendered run against them. The parameters are the two
    // knobs it has: how close a name must be to count as a match, and how
    // much text a run needs before it is worth judging.
    check: {
      fn: 'typography.approved_family',
      params: { fuzzyThreshold: 88, minChars: 3 },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 30, bbox: [0.08, 0.1, 0.92, 0.42] },
    status: 'active',
  },
  {
    key: 'typography.no-fallback-fonts',
    statement:
      'The real cut must be used: no system fallback family, no unembedded font in print artwork, and no ' +
      'synthesised bold or italic.',
    rationale:
      'Three symptoms of the same failure — the intended font was not available when the file was rendered. ' +
      'Times New Roman, Calibri and Papyrus are specific renderer fallbacks; faux bold is what a renderer ' +
      'draws when the real weight is missing. None is a taste objection.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    // Takes no parameters: the three signals are intrinsic to the check and
    // the approved families come from the ontology.
    check: { fn: 'typography.fallback_font', params: {} },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 31, bbox: [0.1, 0.5, 0.9, 0.72] },
    status: 'active',
  },
  {
    /*
     * One rule for the whole scale, not one per style.
     *
     * `typography.min_size` resolves each rendered run to its approved type
     * style and applies THAT style's floor — Body 15px, Caption 13px, Legal
     * 11px, all declared in the ontology. Its only parameter, `minSizePt`, is
     * a single global floor that replaces every per-style floor at once, so a
     * "body is 15px" rule written that way would have failed every line of
     * legal copy on the asset. There is no `styleName` parameter; a per-style
     * rule cannot be expressed through params and does not need to be.
     */
    key: 'typography.min-size',
    statement: 'Type must not be set below the minimum size declared for its style.',
    rationale:
      'Each approved style carries its own floor because they are read at different distances: body copy ' +
      'at arm’s length on a phone, legal copy under scrutiny or not at all. The absolute floor beneath all ' +
      'of them is a separate accessibility rule.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    check: { fn: 'typography.min_size', params: {} },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 33, bbox: [0.1, 0.2, 0.9, 0.5] },
    status: 'active',
  },
  {
    key: 'typography.hierarchy',
    statement: 'Consecutive steps in the type scale must differ by at least 1.25×.',
    rationale:
      'A flattened scale is the single most common symptom of a template used as a canvas. The check ' +
      'compares the sizes of adjacent ranked styles as they were actually rendered; it counts no headings, ' +
      'because nothing in the asset says which run was meant to be the H1.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.75,
    check: { fn: 'typography.hierarchy', params: { minStepRatio: 1.25 } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 95, observedValue: 1 },
    status: 'proposed',
  },

  /* =====================================================================
   * LAYOUT — 5 rules
   * ================================================================== */
  {
    key: 'layout.safe-zone',
    statement: 'No logo, headline, CTA or legal copy may fall inside the platform safe zone.',
    rationale:
      'Safe zones are published per placement and change two to four times a year. Declarative specs validate them at zero model cost and 100% precision.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'blocker',
    weight: 2,
    // `zones` carries explicit per-placement rectangles when the channel spec
    // supplies them; `insetPct` is the fallback that reserves a uniform band
    // around all four edges. There is no element filter — anything that
    // intrudes on a reserved region is an intrusion, whatever it is.
    check: { fn: 'layout.safe_zone', params: { insetPct: 5, intrusionToleranceFrac: 0.02 } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },
  {
    key: 'layout.outer-margin',
    statement: 'Outer margins must be at least 4.5% of the canvas on every edge.',
    rationale: 'Content that touches the edge reads as a crop error and gets clipped by rounded-corner containers.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'minor',
    weight: 0.75,
    // A PERCENTAGE, not a fraction: the analyzer divides by 100. The old
    // `minMarginPct: 0.045` would have asked for a 0.045% margin — about half
    // a pixel on a 1080 canvas — while the statement promised 4.5%.
    check: { fn: 'layout.margins', params: { minMarginPct: 4.5 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 40, bbox: [0.08, 0.15, 0.92, 0.45] },
    status: 'active',
  },
  {
    key: 'layout.grid-alignment',
    statement: 'Element edges must align to the 12-column layout grid.',
    rationale:
      'Off-grid elements are the visual signature of hand-nudged work. Stated as columns because that is ' +
      'what the check measures — residual distance from each element edge to the nearest column line. It ' +
      'has no notion of an 8px baseline unit, and with no column count configured it does nothing at all.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'advisory',
    weight: 0.25,
    // `columns` defaults to 0, and at 0 the analyzer returns not_applicable —
    // so the previous `gridPx` spelling did not merely mis-measure, it never
    // measured anything.
    check: { fn: 'layout.grid_alignment', params: { columns: 12, gutterPct: 2, marginPct: 5, tolerancePct: 1, maxOffGridRatio: 0.25 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 41, bbox: [0.1, 0.1, 0.9, 0.35] },
    status: 'active',
  },
  {
    key: 'layout.no-element-overlap',
    statement: 'Text must not overlap the logo, and no two text blocks may overlap each other.',
    rationale: 'Overlap is nearly always an overflow bug — usually a market whose copy expands past the box.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    // IoU, not percentage overlap, and the comparison is across kinds rather
    // than named pairs: every element of a listed kind is compared with every
    // other. `image` covers the logo, which is detected as an image element.
    check: { fn: 'layout.element_overlap', params: { maxIou: 0.01, kinds: ['text', 'image'] } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'layout.text-density',
    statement: 'Text should occupy no more than 5 of the 25 cells of the canvas grid on paid social.',
    rationale:
      'Meta withdrew the hard 20% rule in 2021 but still suppresses delivery on text-heavy creative. Advisory, because it is a delivery risk, not a brand breach.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'advisory',
    weight: 0,
    scope: { channels: ['meta-feed', 'meta-story', 'meta-reel'] },
    // The check counts occupied cells in a 5x5 grid rather than measuring
    // area, which is how the platform's own tool worked. 5 of 25 cells is the
    // 20% the rule has always meant.
    check: { fn: 'layout.text_density', params: { cells: 5, maxOccupiedCells: 5 } },
    provenance: 'transfer',
    citation: { doc: 'Meta Advertising Standards — text in images' },
    status: 'active',
  },

  /* =====================================================================
   * IMAGERY — 4 rules
   * ================================================================== */
  {
    key: 'imagery.style-conformance',
    statement:
      'Photography must sit within the learned Northwind style manifold: natural light, warm cast, medium contrast, shallow depth of field.',
    rationale:
      '"Our photography is warm and candid" is unwritable as a rule. Fitted from the approved corpus, it becomes a distance with a rejection boundary at the corpus p5.',
    dimension: 'imagery',
    tier: 'cv',
    severity: 'minor',
    weight: 1,
    // The profile itself is the brand's image style profile in the ontology;
    // the parameter is the rejection boundary, given as the distance measured
    // at the corpus 5th percentile rather than as the percentile itself.
    check: { fn: 'imagery.style_conformance', params: { maxDistance: 0.41 } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 5, observedValue: 0.41 },
    status: 'active',
  },
  {
    key: 'imagery.medium',
    statement: 'Photography and flat illustration only. No 3D renders, no stock-photo compositing, no AI artefacts.',
    rationale: 'The category is saturated with generic 3D coffee renders. Being photographic is a distinctiveness asset.',
    dimension: 'imagery',
    tier: 'cv',
    severity: 'minor',
    weight: 0.75,
    // An allowlist only: anything not listed is prohibited, so a separate
    // `prohibited` array would be a second way to say the same thing and a
    // second thing to keep in step.
    check: { fn: 'imagery.medium', params: { allowedMediums: ['photo', 'illustration'], minConfidence: 0.45 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 47, bbox: [0.08, 0.2, 0.92, 0.55] },
    status: 'active',
  },
  {
    key: 'imagery.prohibited-subjects',
    statement:
      'No imagery may depict alcohol, smoking, driving while drinking, or a child holding a coffee cup.',
    rationale:
      'Every one of these has produced a complaint in the category. This is the clearest case for the vision judge — it is genuinely semantic.',
    dimension: 'imagery',
    tier: 'vlm',
    severity: 'blocker',
    weight: 2,
    check: {
      fn: 'imagery.prohibited_subject',
      params: { prohibitedSubjects: ['alcohol', 'smoking', 'driving while drinking', 'child holding a hot drink'] },
    },
    rubric: {
      kind: 'binary',
      question:
        'Does this image depict any of: alcohol, smoking or vaping, a person drinking while driving, or a child holding a hot drink?',
      passWhen: 'None of the listed subjects is depicted.',
      failWhen: 'Any listed subject is clearly depicted.',
      usePrecedents: true,
      cropTo: 'full',
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 49, bbox: [0.1, 0.1, 0.9, 0.6] },
    status: 'active',
  },
  {
    key: 'imagery.no-reuse',
    statement: 'A hero image must not be perceptually identical to one already running in the comparison set.',
    rationale:
      'Perceptual hashing, so a re-export at another size is still the same photo. The 90-day window and ' +
      'the market boundary are chosen by whoever assembles the comparison set — the check compares against ' +
      'what it is given and has no notion of dates.',
    dimension: 'imagery',
    tier: 'cv',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'imagery.reuse', params: { maxHammingDistance: 6 } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 80, observedValue: 4 },
    status: 'proposed',
  },

  /* =====================================================================
   * COPY — 7 rules
   * ================================================================== */
  {
    key: 'copy.banned-terms',
    statement: 'No banned lexicon term may appear in any copy field.',
    rationale:
      'Aho–Corasick over the tenant lexicon: one linear pass regardless of term count, and 100% precision on exact matches.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'major',
    weight: 1.5,
    // No parameters: the terms come from the tenant lexicon in the ontology,
    // which is where this brand keeps them. A `terms` array here would EXTEND
    // the lexicon rather than replace it — useful for a shipped pack that adds
    // a regulator's vocabulary on top, and wrong here, where the lexicon is
    // already the single list.
    check: { fn: 'copy.banned_terms', params: {} },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'copy.required-terms',
    statement: 'The brand name "Northwind" must appear at least once in body copy, not only in the logo.',
    rationale: 'Unaided recall needs the name in the copy. A mark alone does not carry it.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.75,
    check: { fn: 'copy.required_terms', params: {} },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 55, bbox: [0.1, 0.15, 0.9, 0.4] },
    status: 'active',
  },
  {
    key: 'copy.locale-spelling',
    statement: 'Copy must use the spelling convention of its declared market.',
    rationale:
      '"Harbor Blend" in the UK and "Harbour Blend" in the US are both wrong, and both are invisible to the person who wrote the master.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.75,
    // No `locale`: unset means "take the asset's declared locale", which is
    // exactly what the statement says. Pinning one here would apply a single
    // market's spelling to every asset the rule touches.
    check: { fn: 'copy.locale_spelling', params: {} },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'copy.readability',
    statement: 'Consumer copy must score at least 55 on Flesch Reading Ease (roughly UK Year 9).',
    rationale: 'Below that the copy is measurably harder to read than the category average, for no gain.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'advisory',
    weight: 0.25,
    // The metric is chosen by which threshold is set, not by a `metric` name.
    // `minWords` guards the other end: below about 20 words a readability
    // formula is measuring noise.
    check: { fn: 'copy.readability', params: { minFleschReadingEase: 55, minWords: 20 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'copy.cta-allowlist',
    statement: 'The call to action must come from the approved list for the channel.',
    rationale: 'CTA wording is measured and optimised centrally. Ad-hoc CTAs make that measurement meaningless.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.5,
    check: {
      fn: 'copy.cta_allowlist',
      params: {
        allowed: ['Shop now', 'Order now', 'Find your roast', 'Subscribe', 'Learn more', 'Jetzt bestellen', 'Mehr erfahren'],
        caseSensitive: false,
      },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 57, bbox: [0.12, 0.3, 0.88, 0.62] },
    status: 'active',
  },
  {
    key: 'copy.voice-tone',
    statement: 'Copy must satisfy all four Northwind voice axes.',
    rationale:
      'Each axis carries a we-are / we-are-not pair and three exemplars per side, so the judge answers a bounded rubric rather than "does this sound on-brand".',
    dimension: 'copy',
    tier: 'vlm',
    severity: 'minor',
    weight: 1,
    // No parameters: the judge reads the brand's voice attributes from the
    // ontology, each with its we-are / we-are-not pair and its weight.
    check: { fn: 'vlm.voice_tone', params: {} },
    rubric: {
      kind: 'binary',
      question:
        'For each voice axis, does this copy sit on the "we are" side rather than the "we are not" side? Use the tenant exemplars as the standard.',
      passWhen: 'Every axis is satisfied, or the copy is neutral with respect to it.',
      failWhen: 'Any axis is clearly violated.',
      usePrecedents: true,
      cropTo: 'text',
    },
    provenance: 'manual',
    status: 'active',
    calibration: {
      alpha: -1.42,
      beta: 0.71,
      agreementRate: 0.84,
      overrideRate: 0.16,
      sampleSize: 61,
      autoRouteToHuman: false,
      updatedAt: '2026-08-02T09:14:00Z',
    },
  },
  {
    key: 'copy.no-superlatives-unbacked',
    statement: 'Superlative claims ("best", "finest", "smoothest") require a registered, in-date claim.',
    rationale:
      'The ASA and the FTC both treat an unsubstantiated superlative as a substantiation failure, not a matter of tone.',
    dimension: 'copy',
    tier: 'hybrid',
    severity: 'major',
    weight: 1.25,
    /*
     * The hybrid pattern, spelled out: code finds the superlatives, the model
     * decides only whether one is backed. `measuredBy` names the analyzer that
     * runs first and `measureParams` is the params object IT receives — the
     * outer rule's own params never reach it. A clean measured pass short-
     * circuits before any VLM call, which is why `adjudicatePasses` stays off.
     */
    check: {
      fn: 'vlm.rule_adjudication',
      params: {
        measuredBy: 'copy.banned_terms',
        measureParams: { terms: ['best', 'finest', 'smoothest', 'the No.1', 'unrivalled'] },
        adjudicatePasses: false,
      },
    },
    rubric: {
      kind: 'binary',
      question: 'Does this copy make a superlative or comparative claim that is not matched by a registered claim?',
      passWhen: 'No superlative, or every superlative maps to an in-date registered claim for this market.',
      failWhen: 'A superlative or comparative claim has no matching registered claim.',
      usePrecedents: true,
      cropTo: 'text',
    },
    provenance: 'transfer',
    citation: { doc: 'CAP Code s.3.7 (substantiation); FTC Act s.5' },
    status: 'proposed',
  },

  /* =====================================================================
   * ACCESSIBILITY — 4 rules
   * ================================================================== */
  {
    key: 'accessibility.text-contrast',
    statement: 'All text must meet WCAG 2.2 AA: 4.5:1 for body, 3:1 for text 18pt/24px and larger.',
    rationale:
      'Deterministic and free. Contrast is arithmetic over the measured foreground and background, so precision is 100% given correct extraction.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'major',
    weight: 1.5,
    // `level` alone. The per-size thresholds are WCAG's, not ours: the check
    // derives 4.5 or 3.0 from each run's measured size and weight. Restating
    // them as parameters could only ever disagree with the standard.
    check: { fn: 'accessibility.contrast', params: { level: 'AA' } },
    provenance: 'transfer',
    citation: { doc: 'WCAG 2.2 SC 1.4.3 (Contrast Minimum)' },
    status: 'active',
  },
  {
    /*
     * Not scoped to legal copy, because it cannot be. The check has no
     * `styleName` parameter — `minRatio` sets one ratio for every run whatever
     * its size, which IS the "no large-text exemption" policy, applied to the
     * whole asset. That is a stricter rule than the one this slot used to
     * claim, so it ships proposed rather than active: somebody has to agree to
     * hold headlines to the body threshold before it starts failing work.
     */
    key: 'accessibility.no-large-text-exemption',
    statement: 'All text must meet 4.5:1 contrast regardless of size.',
    rationale:
      'The large-text exemption is the loophole that produces unreadable disclaimers, and nothing in an ' +
      'asset marks which run is legal copy. Holding every run to the body threshold closes it, at the cost ' +
      'of failing large type that WCAG would pass at 3:1.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'major',
    weight: 1.5,
    check: { fn: 'accessibility.contrast', params: { minRatio: 4.5 } },
    provenance: 'manual',
    status: 'proposed',
  },
  {
    key: 'accessibility.font-size-floor',
    statement: 'No rendered text may fall below 8.25pt — 11px on a 96dpi screen.',
    rationale: 'A hard floor beneath every per-style minimum, so a mislabelled style cannot smuggle 7px copy through.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    // Points, not pixels. The engine measures type in points and converts
    // using the asset's DPI, so a floor expressed in px is a floor that moves
    // when the canvas does.
    check: { fn: 'accessibility.font_size_floor', params: { minSizePt: 8.25 } },
    provenance: 'transfer',
    citation: { doc: 'WCAG 2.2 SC 1.4.4 (Resize Text), applied as an absolute floor' },
    status: 'active',
  },
  {
    key: 'accessibility.alt-text',
    statement: 'Every asset must be submitted with alt text of at least 20 characters that is not the filename.',
    rationale: 'Alt text is a submission field. Requiring it at check time is the only point where anyone will supply it.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.5,
    // Filename-like alt text is rejected intrinsically — "adequacy" is what
    // this check measures, not presence — so there is no switch for it.
    check: { fn: 'accessibility.alt_text', params: { minChars: 20, maxChars: 250 } },
    provenance: 'transfer',
    citation: { doc: 'WCAG 2.2 SC 1.1.1 (Non-text Content)' },
    status: 'proposed',
  },

  /* =====================================================================
   * CHANNEL SPEC — 1 rule
   * ================================================================== */
  {
    /*
     * One rule, not four.
     *
     * `channel_spec.conformance` validates the whole placement spec in a single
     * pass — dimensions, aspect ratio, file size, format, DPI — reading it from
     * the channel spec registry for the asset's channel. The `checks` array the
     * four previous rules carried was read by nothing, so each of them ran the
     * same complete validation and reported the same verdict under a different
     * name: four criteria, one measurement, four chances to look like four
     * independent confirmations.
     *
     * A `spec` parameter can override the registry for a placement the registry
     * does not cover. Left unset here, which is what makes this rule portable
     * across every channel the brand publishes to.
     */
    key: 'channel.conformance',
    statement:
      'Dimensions, aspect ratio, format, file size and print resolution must match the declared placement spec.',
    rationale:
      'The platform rejects these on upload anyway, so catching them here saves a full production round ' +
      'trip. All of it is arithmetic on the file header — no model, no ambiguity.',
    dimension: 'channel_spec',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'channel_spec.conformance', params: {} },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },

  /* =====================================================================
   * LEGAL — 3 rules
   * ================================================================== */
  {
    /*
     * One rule, not three.
     *
     * `copy.claim_substantiation` walks the register once and applies all three
     * conditions to every match: is the claim registered, is it in date, is the
     * asset's market listed in its jurisdictions. Splitting it into three rules
     * did not split the work — each of the three ran the identical check and
     * reported the identical verdict, so a single expired claim produced three
     * blocker findings that looked like three separate failures.
     */
    key: 'legal.claims-substantiated',
    statement:
      'Every factual claim in the copy must match a claim in the register that is in date and approved for ' +
      'this market.',
    rationale:
      'The register is the object regulated customers actually buy. An unregistered claim is an unapproved ' +
      'claim; a lapsed one is an unapproved claim that used to be fine; and a claim substantiated for the ' +
      'UK is not substantiated in the US. All three are the same failure at different points in the life of ' +
      'the evidence.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    // A 0–100 similarity score, not a 0–1 fraction. The previous `0.88` would
    // have matched asset copy to any registered claim at all.
    check: { fn: 'copy.claim_substantiation', params: { fuzzyThreshold: 88 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.disclaimer-present',
    statement: 'Where a claim requires a disclaimer, that disclaimer must be present and materially complete.',
    rationale:
      'Presence and wording only. A previous companion rule promised to check that disclaimers were also ' +
      'large enough, legible and adjacent to the claim — no analyzer measures any of those, so it passed ' +
      'assets it claimed to catch. Size and contrast are enforced by the accessibility rules, which measure ' +
      'them; proximity is not enforced at all, and saying so is better than implying otherwise.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'copy.disclaimer_present', params: { fuzzyThreshold: 85 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.de-health-claims',
    statement:
      'German-market copy must not carry any health or nutrition claim that is not on the EU authorised list.',
    rationale:
      'Regulation (EC) 1924/2006 is a strict allowlist. This is the highest-consequence market rule in the set and needs a human confirmation before it can fail anyone.',
    dimension: 'legal',
    tier: 'hybrid',
    severity: 'blocker',
    weight: 2,
    scope: { markets: ['de-DE'] },
    /*
     * The measured half is a vocabulary sweep, the judged half is the
     * authorisation decision. Regulation 1924/2006 is an allowlist and no
     * analyzer implements it, so the honest split is: code finds the candidate
     * health-claim language, and the model decides whether what it found is an
     * authorised claim or an unauthorised one. Without a measured half this
     * check asks the judge whether "a documented exception applies" to a
     * measurement that does not exist.
     */
    check: {
      fn: 'vlm.rule_adjudication',
      params: {
        measuredBy: 'copy.banned_terms',
        measureParams: {
          terms: ['fördert', 'unterstützt das Immunsystem', 'steigert die Konzentration', 'entgiftet', 'stärkt'],
        },
        adjudicatePasses: false,
      },
    },
    rubric: {
      kind: 'binary',
      question:
        'Does this copy state or imply a health or nutrition benefit (energy, metabolism, wellbeing, concentration) that is not on the EU authorised claims list?',
      passWhen: 'No health or nutrition claim is made, or every claim made is authorised.',
      failWhen: 'Any unauthorised health or nutrition benefit is stated or implied.',
      usePrecedents: true,
      cropTo: 'text',
    },
    provenance: 'transfer',
    citation: { doc: 'Regulation (EC) No 1924/2006, Annex — authorised health claims' },
    status: 'proposed',
  },

  /* =====================================================================
   * VLM — holistic and mood. Deliberately last: `vlm.overall_judgment`
   * runs at the end of the pipeline so it can see the cheap verdicts.
   * ================================================================== */
  {
    key: 'vlm.mood-alignment',
    statement: 'The overall mood must read as warm, unhurried and grounded — not clinical, frantic or luxurious.',
    rationale:
      'Mood is genuinely semantic and genuinely matters. It is scoped to a small ordinal rubric so the judge is not asked to invent a scale.',
    dimension: 'imagery',
    tier: 'vlm',
    severity: 'minor',
    weight: 0.75,
    // One `mood` string, read straight into the prompt. Two arrays would have
    // to be reassembled into a sentence anyway, and the sentence is the thing
    // the judge actually reads.
    check: { fn: 'vlm.mood', params: { mood: 'warm, unhurried and grounded — not clinical, frantic or luxurious' } },
    rubric: {
      kind: 'ordinal',
      question: 'How well does the overall mood of this creative match: warm, unhurried, grounded?',
      levels: [
        { value: 0, label: 'Contradicts', anchor: 'Reads as clinical, frantic or luxury-coded.' },
        { value: 1, label: 'Neutral', anchor: 'Neither matches nor contradicts; no clear mood.' },
        { value: 2, label: 'Matches', anchor: 'Clearly reads warm and unhurried, consistent with the brand.' },
      ],
      passWhen: 'Level 1 or 2.',
      failWhen: 'Level 0.',
      usePrecedents: true,
      cropTo: 'full',
    },
    provenance: 'manual',
    status: 'proposed',
    calibration: {
      alpha: -0.31,
      beta: 0.18,
      agreementRate: 0.52,
      overrideRate: 0.48,
      sampleSize: 24,
      // beta below 0.3: the judge's confidence carries essentially no signal
      // about what these reviewers will accept, so every instance is routed
      // to a human until it improves.
      autoRouteToHuman: true,
      updatedAt: '2026-08-05T11:02:00Z',
    },
  },
  {
    key: 'vlm.overall-judgment',
    statement:
      'Taken as a whole, would a Northwind brand manager approve this asset without changes?',
    rationale:
      'The catch-all that runs last, after every cheap verdict is banked, so the judge sees the deterministic findings as context. Its verdict never moves the score — it can only raise a finding.',
    dimension: 'imagery',
    tier: 'vlm',
    severity: 'advisory',
    weight: 0,
    // Upstream findings are always handed over — that is the entire reason
    // this check runs last. There is nothing to switch on.
    check: { fn: 'vlm.overall_judgment', params: {} },
    rubric: {
      kind: 'binary',
      question:
        'Considering the brand context and the findings already raised, would a Northwind brand manager approve this asset as-is?',
      passWhen: 'Yes, or the only issues are advisory.',
      failWhen: 'No — there is a problem that the specific rules did not catch.',
      usePrecedents: true,
      cropTo: 'full',
    },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'vlm.subject-appropriateness',
    statement: 'The subject matter must be appropriate for the market and the audience.',
    rationale: 'Catches culturally specific problems that no enumerated subject list anticipates.',
    dimension: 'imagery',
    tier: 'vlm',
    severity: 'major',
    weight: 1,
    scope: { markets: ['de-DE'] },
    // The market comes from the asset, and the prohibited subjects from the
    // brand's image style profile. `sensitivities` is the one thing a rule can
    // add that neither of those carries.
    check: {
      fn: 'vlm.subject_appropriateness',
      params: { sensitivities: ['German advertising norms around health, alcohol and family imagery'] },
    },
    rubric: {
      kind: 'binary',
      question: 'Is anything depicted here inappropriate or likely to cause offence in the German market?',
      passWhen: 'Nothing inappropriate is depicted.',
      failWhen: 'Something is clearly inappropriate for this market.',
      usePrecedents: true,
      cropTo: 'full',
    },
    provenance: 'manual',
    status: 'proposed',
  },

  /* =====================================================================
   * Remaining proposals — the rule-review queue on first boot.
   * ================================================================== */
  {
    key: 'logo.no-occlusion',
    statement: 'Nothing may overlap the logo, including gradients, scrims and image edges.',
    rationale: 'Extracted from the brand book’s misuse spread; needs a human to confirm the tolerance.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    // The shipped defaults, left explicit: the rationale says the tolerance
    // needs a human, and 2% is what it will be reviewed against.
    check: { fn: 'logo.occlusion', params: { maxCoverageFrac: 0.02, maxIou: 0.02 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 16, bbox: [0.08, 0.24, 0.92, 0.68], extractedBy: 'brandbook-extractor@1.0' },
    status: 'proposed',
  },
  {
    key: 'color.tint-ramp-only',
    statement: 'Only the declared tints of a brand colour may be used. Arbitrary opacity is not a tint.',
    rationale:
      'Extracted from the colour spread. Proposed rather than active because the corpus contains 6 approved assets that would fail it, and those need adjudicating first.',
    dimension: 'color',
    tier: 'cv',
    severity: 'minor',
    weight: 0.5,
    // `allowTints: false` is what "only the declared tints" means to this
    // analyzer: stop auto-accepting anything that is merely a lighter or
    // darker version of a token, and require a declared swatch.
    check: { fn: 'color.palette_conformance', params: { allowTints: false, maxDeltaE: 3 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 23, bbox: [0.06, 0.42, 0.94, 0.86], extractedBy: 'brandbook-extractor@1.0' },
    status: 'proposed',
  },
  {
    /*
     * This slot used to hold a tracking rule (-0.02em on Display). No analyzer
     * measures letter-spacing, so it could never have produced a verdict; it
     * was pointed at the casing check, which ignored every parameter it was
     * given. Replaced with the convention the same corpus actually supports
     * and the engine can measure.
     */
    key: 'typography.sentence-case',
    statement: 'Headlines are set in sentence case. All-caps is reserved for the wordmark.',
    rationale:
      'Induced from the approved corpus: 39 of 41 headlines are sentence case. Advisory until confirmed, ' +
      'because a deliberate all-caps campaign line is a decision, not a defect.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'typography.casing', params: { casing: 'sentence', maxAllCapsRatio: 0.15, minChars: 8 } },
    provenance: 'inductive',
    support: { sampleSize: 41, percentile: 95, observedValue: 0.951 },
    status: 'proposed',
  },
];

/* --------------------------------------------------------------------------
 * Scoring configuration published with the ruleset.
 *
 * Dimension weights, not criterion weights: aggregating per dimension first
 * stops a dimension with fifty typographic leaves from drowning out one with
 * three legal ones. Legal and logo are weighted highest because that is what
 * actually gets a campaign pulled.
 * ------------------------------------------------------------------------ */
export const SEED_SCORING_CONFIG = {
  dimensionWeights: {
    legal: 2.0,
    logo: 1.5,
    accessibility: 1.3,
    channel_spec: 1.2,
    color: 1.0,
    typography: 1.0,
    copy: 1.0,
    layout: 0.8,
    imagery: 0.6,
  },
  passThreshold: 85,
  conditionalThreshold: 70,
};
