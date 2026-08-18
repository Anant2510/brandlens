/* ==========================================================================
 * The rule set for Northwind Coffee Co.
 *
 * 57 rules across all nine dimensions and all four tiers. 42 are `active` and
 * feed the published ruleset; 15 are left `proposed` — a mix of `deductive`
 * extractions carrying page + bbox citations and `inductive` proposals
 * carrying their statistical support — so the rule-review screen has real
 * work waiting on first boot.
 *
 * Two things are load-bearing here and neither is decoration:
 *
 *   `check.fn` must name an analyzer registered in
 *   apps/engine/brandlens_engine/registry.py. An unknown fn does not crash —
 *   the pipeline reports `insufficient_evidence` with the name in the
 *   observation — but it does mean a criterion that never evaluates.
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
    check: { fn: 'logo.presence', params: { minSimilarity: 0.82, allowAnyVariant: true } },
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
    check: { fn: 'logo.clearspace', params: { multiple: 1.35, unit: 'logomark_height', tolerancePx: 2 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 11, bbox: [0.1, 0.2, 0.9, 0.62], extractedBy: 'brandbook-extractor@1.0' },
    status: 'active',
  },
  {
    key: 'logo.min-size.digital',
    statement: 'The logo must render at least 120px wide on any digital canvas.',
    rationale: 'Below 120px the wordmark counters close up at typical mobile pixel densities.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    scope: { channels: ['meta-feed', 'meta-story', 'meta-reel', 'tiktok-in-feed', 'linkedin-feed', 'display', 'amazon-a-plus'] },
    check: { fn: 'logo.min_size', params: { minWidthPx: 120, minWidthPct: 0.08 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 12, bbox: [0.12, 0.14, 0.88, 0.4] },
    status: 'active',
  },
  {
    key: 'logo.min-size.print',
    statement: 'The logo must reproduce at least 25mm wide in print.',
    rationale: 'Below 25mm the roastery date stamp in the mark fills in on uncoated stock.',
    dimension: 'logo',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    scope: { channels: ['print-a4', 'print-a5'] },
    check: { fn: 'logo.min_size', params: { minWidthMm: 25, requireDpi: 300 } },
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
    check: { fn: 'logo.distortion', params: { maxAspectDeviationPct: 2, maxRotationDeg: 0.5 } },
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
      params: { allowedHex: ['#2B1B12', '#F4EDE1', '#000000', '#FFFFFF'], deltaEThreshold: 6 },
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
    check: { fn: 'logo.placement', params: { allowedZones: ['top-left', 'bottom-right'], tolerancePct: 0.06 } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 90, observedValue: 0.904 },
    // Left proposed: an induced convention is a hypothesis about the brand,
    // not a rule the brand has agreed to.
    status: 'proposed',
  },

  /* =====================================================================
   * COLOR — 5 rules
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
      params: { deltaEThreshold: 5, minClusterSharePct: 3, clusterCount: 8, ignoreImagery: true },
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
    check: { fn: 'color.forbidden', params: { deltaEThreshold: 12, minClusterSharePct: 2 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'color.espresso-cream-dominance',
    statement:
      'Espresso and Cream together must account for at least 55% of the non-photographic surface on brand-led creative.',
    rationale:
      'The distinctiveness asset is the ground, not the mark. Induced from the approved corpus at the 10th percentile.',
    dimension: 'color',
    tier: 'cv',
    severity: 'minor',
    weight: 1,
    check: {
      fn: 'color.dominance_ratio',
      params: { tokenPaths: ['color.brand.espresso', 'color.brand.cream'], minRatio: 0.55, excludeImagery: true },
    },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 10, observedValue: 0.58 },
    status: 'active',
  },
  {
    key: 'color.copper-accent-cap',
    statement: 'Copper must not exceed 18% of the total surface. It is an accent, not a ground.',
    rationale: 'Copper at scale reads as a warning colour and clashes with the functional palette.',
    dimension: 'color',
    tier: 'cv',
    severity: 'minor',
    weight: 0.75,
    check: { fn: 'color.dominance_ratio', params: { tokenPaths: ['color.brand.copper'], maxRatio: 0.18 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 24, bbox: [0.1, 0.55, 0.9, 0.78] },
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
      params: { forbiddenHex: ['#C2703D'], deltaEThreshold: 8, reason: 'Copper is not part of the Reserve palette' },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 61, bbox: [0.08, 0.12, 0.92, 0.46] },
    status: 'active',
  },

  /* =====================================================================
   * TYPOGRAPHY — 6 rules
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
    check: {
      fn: 'typography.approved_family',
      params: { allowFallbackStack: true, minCoveragePct: 95 },
    },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 30, bbox: [0.08, 0.1, 0.92, 0.42] },
    status: 'active',
  },
  {
    key: 'typography.no-fallback-fonts',
    statement:
      'Times New Roman, Calibri, Comic Sans MS and Papyrus must never appear. They indicate a substituted or rebuilt file.',
    rationale:
      'These are not taste objections. Each is a specific renderer fallback, so their presence is evidence of a broken production pipeline.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'typography.fallback_font', params: { severityByFamily: true } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 31, bbox: [0.1, 0.5, 0.9, 0.72] },
    status: 'active',
  },
  {
    key: 'typography.body-min-size',
    statement: 'Body copy must be at least 15px, or 1.4% of the canvas short edge, whichever is larger.',
    rationale: 'Below that, body copy fails at arm’s length on a phone, which is where most of it is read.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    check: { fn: 'typography.min_size', params: { styleName: 'Body', minSizePx: 15, minSizePctOfCanvas: 0.014 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 33, bbox: [0.1, 0.2, 0.9, 0.5] },
    status: 'active',
  },
  {
    key: 'typography.legal-min-size',
    statement: 'Legal and disclaimer copy must be at least 11px on screen and 8pt in print.',
    rationale:
      'A disclaimer nobody can read is a disclaimer that was not made. Regulators treat legibility as part of presence.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'typography.min_size', params: { styleName: 'Legal', minSizePx: 11, minSizePt: 8 } },
    provenance: 'transfer',
    citation: { doc: 'CAP Code s.3.10; FTC .com Disclosures (2013), clear and conspicuous' },
    status: 'active',
  },
  {
    key: 'typography.no-faux-styles',
    statement: 'Faux bold and faux italic are forbidden. Use the real weight and the real italic cut.',
    rationale: 'Synthesised weights distort the letterforms and are trivially detectable in structured sources.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.5,
    check: { fn: 'typography.casing', params: { forbidFauxBold: true, forbidFauxItalic: true } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 34, bbox: [0.12, 0.6, 0.88, 0.8] },
    status: 'active',
  },
  {
    key: 'typography.hierarchy',
    statement:
      'A layout must contain at most one Display or H1 element, and no body text may be larger than the smallest heading.',
    rationale:
      'Two competing headlines is the single most common symptom of a template used as a canvas rather than a template.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'minor',
    weight: 0.75,
    check: { fn: 'typography.hierarchy', params: { maxPrimaryHeadings: 1, enforceScaleOrder: true } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 95, observedValue: 1 },
    status: 'proposed',
  },

  /* =====================================================================
   * LAYOUT — 6 rules
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
    check: { fn: 'layout.safe_zone', params: { elements: ['logo', 'headline', 'cta', 'legal'], tolerancePx: 4 } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },
  {
    key: 'layout.outer-margin',
    statement: 'Outer margins must be at least 48px, or 4.5% of the short edge on canvases below 1080px.',
    rationale: 'Content that touches the edge reads as a crop error and gets clipped by rounded-corner containers.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'minor',
    weight: 0.75,
    check: { fn: 'layout.margins', params: { minMarginPx: 48, minMarginPct: 0.045 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 40, bbox: [0.08, 0.15, 0.92, 0.45] },
    status: 'active',
  },
  {
    key: 'layout.grid-alignment',
    statement: 'Every element origin must sit on the 8px grid.',
    rationale: 'The base spacing unit is a token. Off-grid elements are the visual signature of hand-nudged work.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'layout.grid_alignment', params: { gridPx: 8, tolerancePx: 2 } },
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
    check: { fn: 'layout.element_overlap', params: { maxOverlapPct: 1, pairs: [['text', 'logo'], ['text', 'text']] } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'layout.text-density',
    statement: 'Text should cover no more than 20% of the canvas on paid social.',
    rationale:
      'Meta withdrew the hard 20% rule in 2021 but still suppresses delivery on text-heavy creative. Advisory, because it is a delivery risk, not a brand breach.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'advisory',
    weight: 0,
    scope: { channels: ['meta-feed', 'meta-story', 'meta-reel'] },
    check: { fn: 'layout.text_density', params: { maxTextAreaPct: 20 } },
    provenance: 'transfer',
    citation: { doc: 'Meta Advertising Standards — text in images' },
    status: 'active',
  },
  {
    key: 'layout.de-expansion-headroom',
    statement:
      'German layouts must leave 35% horizontal headroom in every text box relative to the English master.',
    rationale:
      'German compounds run about a third longer. Without headroom the localised variant overflows and the overlap rule fires downstream instead of the real cause.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'major',
    weight: 1,
    scope: { markets: ['de-DE'] },
    check: { fn: 'layout.element_overlap', params: { requireHeadroomPct: 35, comparedTo: 'master' } },
    provenance: 'inductive',
    support: { sampleSize: 18, percentile: 75, observedValue: 1.34 },
    status: 'proposed',
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
    check: { fn: 'imagery.style_conformance', params: { profileName: 'Northwind photography', maxDistancePercentile: 5 } },
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
    check: { fn: 'imagery.medium', params: { allowed: ['photo', 'illustration'], prohibited: ['3d', 'screenshot'] } },
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
      params: { subjects: ['alcohol', 'smoking', 'driving while drinking', 'child holding a hot drink'] },
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
    key: 'imagery.no-reuse-within-90d',
    statement: 'The same hero image must not appear in two campaigns within 90 days in the same market.',
    rationale: 'Induced from the corpus: perceptual-hash collisions across campaigns correlate with wear-out complaints.',
    dimension: 'imagery',
    tier: 'cv',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'imagery.reuse', params: { windowDays: 90, phashDistanceThreshold: 6, scope: 'market' } },
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
    check: { fn: 'copy.banned_terms', params: { useLexicon: true, severityFromTerm: true, fuzzyThreshold: 0.92 } },
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
    check: { fn: 'copy.required_terms', params: { useLexicon: true, kinds: ['required'] } },
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
    check: { fn: 'copy.locale_spelling', params: { useMarketRules: true } },
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
    check: { fn: 'copy.readability', params: { metric: 'flesch_reading_ease', minScore: 55, fields: ['headline', 'body'] } },
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
      params: { allowed: ['Shop now', 'Order now', 'Find your roast', 'Subscribe', 'Learn more', 'Jetzt bestellen', 'Mehr erfahren'] },
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
    check: { fn: 'vlm.voice_tone', params: { axes: 'all', requireAllAxes: false, minAxisScore: 0.6 } },
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
    check: { fn: 'vlm.rule_adjudication', params: { detector: 'superlative', requireClaimMatch: true } },
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
    check: { fn: 'accessibility.contrast', params: { level: 'AA', normalRatio: 4.5, largeRatio: 3.0, largeTextPx: 24 } },
    provenance: 'transfer',
    citation: { doc: 'WCAG 2.2 SC 1.4.3 (Contrast Minimum)' },
    status: 'active',
  },
  {
    key: 'accessibility.legal-contrast',
    statement: 'Legal and disclaimer copy must meet 4.5:1 regardless of its size.',
    rationale:
      'The large-text exemption is exactly the loophole that produces unreadable disclaimers. It does not apply to legal copy here.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'accessibility.contrast', params: { styleName: 'Legal', minRatio: 4.5, ignoreLargeTextExemption: true } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'accessibility.font-size-floor',
    statement: 'No rendered text may fall below 11px on screen.',
    rationale: 'A hard floor beneath every per-style minimum, so a mislabelled style cannot smuggle 7px copy through.',
    dimension: 'accessibility',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    check: { fn: 'accessibility.font_size_floor', params: { minPx: 11 } },
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
    check: { fn: 'accessibility.alt_text', params: { minLength: 20, rejectFilenameLike: true } },
    provenance: 'transfer',
    citation: { doc: 'WCAG 2.2 SC 1.1.1 (Non-text Content)' },
    status: 'proposed',
  },

  /* =====================================================================
   * CHANNEL SPEC — 4 rules
   * ================================================================== */
  {
    key: 'channel.dimensions',
    statement: 'Asset dimensions and aspect ratio must match the declared placement spec.',
    rationale: 'Rejected on upload by the platform anyway. Catching it here saves a full production round trip.',
    dimension: 'channel_spec',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'channel_spec.conformance', params: { checks: ['aspectRatio', 'minDimensions', 'exactSizes'] } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },
  {
    key: 'channel.file-size',
    statement: 'File size must be within the placement’s maximum.',
    rationale: 'Same argument as dimensions, and even cheaper to check.',
    dimension: 'channel_spec',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    check: { fn: 'channel_spec.conformance', params: { checks: ['maxBytes', 'formats'] } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },
  {
    key: 'channel.video-encoding',
    statement: 'Video duration, frame rate, bitrate and audio must satisfy the placement spec.',
    rationale: 'Probed from the container metadata. No model, no ambiguity.',
    dimension: 'channel_spec',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    scope: { assetTypes: ['video'] },
    check: { fn: 'channel_spec.conformance', params: { checks: ['durationMs', 'fps', 'bitrateKbps', 'audio', 'videoCodec'] } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'active',
  },
  {
    key: 'channel.print-prepress',
    statement: 'Print artwork must be 300dpi, CMYK, with 3mm bleed and total ink coverage at or below 300%.',
    rationale: 'Each of these has cost a reprint. All four are arithmetic on the file header.',
    dimension: 'channel_spec',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 1.5,
    scope: { channels: ['print-a4', 'print-a5'] },
    check: { fn: 'channel_spec.conformance', params: { checks: ['minDpi', 'colorSpace', 'bleedMm', 'totalInkCoverageMaxPct'] } },
    provenance: 'transfer',
    citation: { doc: 'BrandLens channel spec registry 2026.1' },
    status: 'proposed',
  },

  /* =====================================================================
   * LEGAL — 6 rules
   * ================================================================== */
  {
    key: 'legal.claim-registered',
    statement: 'Every factual claim in the copy must match a claim in the register.',
    rationale:
      'The register is the object regulated customers actually buy. An unregistered claim is an unapproved claim.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'copy.claim_substantiation', params: { requireRegistered: true, fuzzyThreshold: 0.88 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.claim-in-date',
    statement: 'A claim must not be used after its approval expires.',
    rationale:
      'Claims lapse when the evidence behind them does. This is a date comparison, and it is the check nobody performs by hand.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'copy.claim_substantiation', params: { checkExpiry: true, graceDays: 0 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.claim-jurisdiction',
    statement: 'A claim may only be used in a market listed in its jurisdictions.',
    rationale:
      'The recyclability claim is substantiated for the UK and Germany and for nowhere else. Using it in the US is a specific, provable breach.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'copy.claim_substantiation', params: { checkJurisdiction: true } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.disclaimer-present',
    statement: 'Where a claim requires a disclaimer, that disclaimer must be present.',
    rationale: 'Presence is the first of four conditions, and the only one most tools check.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: { fn: 'copy.disclaimer_present', params: { matchThreshold: 0.85 } },
    provenance: 'manual',
    status: 'active',
  },
  {
    key: 'legal.disclaimer-legible',
    statement:
      'A required disclaimer must be at least 8pt, meet 4.5:1 contrast, and sit within 25% of the canvas height of the claim it qualifies.',
    rationale:
      'Present, large enough, readable, and adjacent. A disclaimer that fails any one of the four has not been made.',
    dimension: 'legal',
    tier: 'deterministic',
    severity: 'blocker',
    weight: 2,
    check: {
      fn: 'copy.disclaimer_present',
      params: { checkFontSize: true, checkContrast: true, checkProximity: true, maxProximityPct: 0.25 },
    },
    provenance: 'transfer',
    citation: { doc: 'FTC .com Disclosures (2013) — clear and conspicuous; CAP Code s.3.9' },
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
    check: { fn: 'vlm.rule_adjudication', params: { detector: 'health_claim', authorisedList: 'eu-1924-2006' } },
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
    check: { fn: 'vlm.mood', params: { target: ['warm', 'unhurried', 'grounded'], avoid: ['clinical', 'frantic', 'luxurious'] } },
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
    check: { fn: 'vlm.overall_judgment', params: { includeUpstreamFindings: true } },
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
    check: { fn: 'vlm.subject_appropriateness', params: { market: 'de-DE' } },
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
    check: { fn: 'logo.occlusion', params: { maxOcclusionPct: 0 } },
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
    check: { fn: 'color.palette_conformance', params: { tintsOnly: true, deltaEThreshold: 3 } },
    provenance: 'deductive',
    citation: { doc: BOOK, page: 23, bbox: [0.06, 0.42, 0.94, 0.86], extractedBy: 'brandbook-extractor@1.0' },
    status: 'proposed',
  },
  {
    key: 'typography.tracking-display',
    statement: 'Display type must be tracked at -0.02em. No optical adjustment beyond ±0.005em.',
    rationale: 'Induced from the approved corpus; the interquartile range is tight enough to be a real convention.',
    dimension: 'typography',
    tier: 'deterministic',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'typography.casing', params: { styleName: 'Display', letterSpacingEm: -0.02, tolerance: 0.005 } },
    provenance: 'inductive',
    support: { sampleSize: 41, percentile: 50, observedValue: -0.0201 },
    status: 'proposed',
  },
  {
    key: 'layout.cta-bottom-third',
    statement: 'The primary CTA sits in the bottom third of the canvas.',
    rationale: 'Induced: 38 of 52 approved assets place it there. Below the threshold we would normally activate at.',
    dimension: 'layout',
    tier: 'cv',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'layout.grid_alignment', params: { element: 'cta', region: 'bottom-third' } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 73, observedValue: 0.731 },
    status: 'proposed',
  },
  {
    key: 'copy.headline-length',
    statement: 'Headlines must be nine words or fewer.',
    rationale: 'Induced from the approved corpus at the 90th percentile. Needs confirmation that it is a rule, not a habit.',
    dimension: 'copy',
    tier: 'deterministic',
    severity: 'advisory',
    weight: 0.25,
    check: { fn: 'copy.readability', params: { field: 'headline', maxWords: 9 } },
    provenance: 'inductive',
    support: { sampleSize: 52, percentile: 90, observedValue: 9 },
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
