import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenancy';
import {
  checkTierEnum,
  logoVariantKindEnum,
  ruleDimensionEnum,
  ruleProvenanceEnum,
  ruleStatusEnum,
  severityEnum,
  tokenTypeEnum,
} from './enums';

/* ==========================================================================
 * ENTITY LAYER
 *
 *   Brand ─┬─ SubBrand ─┬─ Market/Locale
 *          │            └─ Channel ── AssetType
 *          └─ Campaign ── Audience
 *
 * Elements: LogoVariant | ColorToken | TypeStyle | LayoutTemplate |
 *           ImageStyleProfile | VoiceAttribute | Claim | Disclaimer | CTA
 * ========================================================================== */

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Self-reference models sub-brands without a second table. */
    parentBrandId: uuid('parent_brand_id'),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    description: text('description'),

    /** Free-text mission/positioning — fed to the judge as brand context. */
    positioning: text('positioning'),

    /** Currently published ruleset. Null until the first brand compile. */
    activeRulesetId: uuid('active_ruleset_id'),

    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    slugUq: uniqueIndex('brands_org_slug_uq').on(t.orgId, t.slug),
    byOrg: index('brands_org_idx').on(t.orgId),
    byParent: index('brands_parent_idx').on(t.parentBrandId),
  }),
);

/** Markets/locales a brand operates in — one axis of the scope lattice. */
export const markets = pgTable(
  'markets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 20 }).notNull(), // en-GB, de-DE, ...
    name: varchar('name', { length: 120 }).notNull(),
    /** e.g. { spelling: 'en-GB', currency: 'GBP', legalEntity: 'Acme Ltd' } */
    localeRules: jsonb('locale_rules').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('markets_brand_code_uq').on(t.brandId, t.code),
    byOrg: index('markets_org_idx').on(t.orgId),
  }),
);

/* ==========================================================================
 * DESIGN TOKENS  (W3C Design Tokens Community Group format)
 *
 * Using the DTCG shape means direct ingestion from Figma Variables, Style
 * Dictionary and Tailwind configs — real interop that Adobe does not offer.
 * ========================================================================== */
export const designTokens = pgTable(
  'design_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Dotted DTCG path, e.g. `color.brand.primary`. */
    path: varchar('path', { length: 300 }).notNull(),
    type: tokenTypeEnum('type').notNull(),
    /** DTCG `$value`. */
    value: jsonb('value').notNull(),
    description: text('description'),

    /* --- colour-specific, precomputed so checks never re-parse --- */
    hex: varchar('hex', { length: 9 }),
    labL: real('lab_l'),
    labA: real('lab_a'),
    labB: real('lab_b'),

    /** primary | secondary | accent | neutral | functional | forbidden */
    role: varchar('role', { length: 40 }),
    /** Tints/shades of this token that are legal (e.g. [20,40,60,80]). */
    allowedTints: integer('allowed_tints').array(),

    /** Surface-share rules, e.g. { minRatio: 0.6, maxRatio: null }. */
    usage: jsonb('usage').$type<Record<string, unknown>>().notNull().default({}),

    source: varchar('source', { length: 40 }).notNull().default('manual'), // manual|figma|style-dictionary|brandbook|induced
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('design_tokens_brand_path_uq').on(t.brandId, t.path),
    byOrgBrand: index('design_tokens_org_brand_idx').on(t.orgId, t.brandId),
    byType: index('design_tokens_type_idx').on(t.brandId, t.type),
  }),
);

/* ==========================================================================
 * LOGO VARIANTS
 * Each approved logo file, its canonical geometry, and its usage constraints.
 * Detection is open-set: crop → embed → kNN against this gallery, so adding a
 * customer never requires retraining a detector.
 * ========================================================================== */
export const logoVariants = pgTable(
  'logo_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    kind: logoVariantKindEnum('kind').notNull().default('primary'),

    storageKey: text('storage_key').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }),
    width: integer('width'),
    height: integer('height'),

    /** Canonical aspect ratio — the cheap distortion pre-filter. */
    aspectRatio: real('aspect_ratio'),
    /** Height of the logomark in px within this file; the "X" unit that
     *  every brand book expresses clear space in. */
    logomarkHeightPx: real('logomark_height_px'),

    /** Approved ink colours (hex) for recolouring detection. */
    palette: jsonb('palette').$type<string[]>().notNull().default([]),

    /** { clearSpaceMultiple: 1.0, minWidthPx: 120, minWidthPct: 0.08,
     *    minWidthMm: 25, allowedBackgrounds: 'light'|'dark'|'any',
     *    allowedZones: ['top-left','bottom-right'] } */
    constraints: jsonb('constraints').$type<Record<string, unknown>>().notNull().default({}),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBrand: index('logo_variants_brand_idx').on(t.orgId, t.brandId),
    byHash: index('logo_variants_hash_idx').on(t.contentHash),
  }),
);

/* ==========================================================================
 * TYPOGRAPHY
 * Font identification is reframed as closed-set verification: the tenant has
 * 3–10 approved faces, so we render candidates and compare, rather than
 * attempting open-set font ID.
 * ========================================================================== */
export const typeStyles = pgTable(
  'type_styles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(), // "H1", "Body", "Legal"
    role: varchar('role', { length: 60 }).notNull().default('body'),

    fontFamily: varchar('font_family', { length: 200 }).notNull(),
    /** Every string that must resolve to this face:
     *  "Helvetica Neue LT Pro 65 Medium", "HelveticaNeueLTPro-Md", … */
    fontAliases: text('font_aliases').array().notNull().default(sql`ARRAY[]::text[]`),
    fontWeight: integer('font_weight').notNull().default(400),
    isItalic: boolean('is_italic').notNull().default(false),

    minSizePx: real('min_size_px'),
    minSizePt: real('min_size_pt'),
    minSizePctOfCanvas: real('min_size_pct_of_canvas'),
    maxSizePx: real('max_size_px'),
    lineHeightRatio: real('line_height_ratio'),
    letterSpacingEm: real('letter_spacing_em'),

    /** { allCaps: false, forbidFauxBold: true, forbidFauxItalic: true } */
    casingRules: jsonb('casing_rules').$type<Record<string, unknown>>().notNull().default({}),
    /** Position in the type scale; used for hierarchy checks. */
    scaleRank: integer('scale_rank'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBrand: index('type_styles_brand_idx').on(t.orgId, t.brandId),
    uq: uniqueIndex('type_styles_brand_name_uq').on(t.brandId, t.name),
  }),
);

/** Fonts that indicate a broken template rather than a style choice. */
export const forbiddenFonts = pgTable(
  'forbidden_fonts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    fontFamily: varchar('font_family', { length: 200 }).notNull(),
    reason: text('reason'),
    severity: severityEnum('severity').notNull().default('major'),
  },
  (t) => ({ byBrand: index('forbidden_fonts_brand_idx').on(t.orgId, t.brandId) }),
);

/* ==========================================================================
 * VOICE & TONE
 * Decomposed into rubric axes with tenant-authored exemplars. "Confident, not
 * arrogant" only becomes checkable when it has a positive and negative example.
 * ========================================================================== */
export const voiceAttributes = pgTable(
  'voice_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(), // "Confident, not arrogant"
    weAre: text('we_are').notNull(),
    weAreNot: text('we_are_not').notNull(),
    positiveExamples: text('positive_examples').array().notNull().default(sql`ARRAY[]::text[]`),
    negativeExamples: text('negative_examples').array().notNull().default(sql`ARRAY[]::text[]`),
    weight: real('weight').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('voice_attributes_brand_idx').on(t.orgId, t.brandId) }),
);

/** Banned / required / preferred terminology. Matched with Aho–Corasick. */
export const lexiconTerms = pgTable(
  'lexicon_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    term: varchar('term', { length: 300 }).notNull(),
    kind: varchar('kind', { length: 30 }).notNull().default('banned'), // banned|required|preferred|trademark
    replacement: varchar('replacement', { length: 300 }),
    caseSensitive: boolean('case_sensitive').notNull().default(false),
    matchWholeWord: boolean('match_whole_word').notNull().default(true),
    allowFuzzy: boolean('allow_fuzzy').notNull().default(true),
    severity: severityEnum('severity').notNull().default('minor'),
    marketCodes: text('market_codes').array(),
    notes: text('notes'),
  },
  (t) => ({
    byBrand: index('lexicon_terms_brand_idx').on(t.orgId, t.brandId, t.kind),
  }),
);

/* ==========================================================================
 * CLAIMS REGISTER  — the highest-willingness-to-pay object in the product.
 * Pharma MLR, financial services, food/supplements, alcohol, gambling and
 * insurance all need exactly this: an approved claim, its substantiation,
 * its jurisdiction, and its expiry date.
 * ========================================================================== */
export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Paraphrases that count as the same claim. */
    variants: text('variants').array().notNull().default(sql`ARRAY[]::text[]`),
    category: varchar('category', { length: 80 }), // superlative|comparative|numeric|regulatory|endorsement
    substantiationRef: text('substantiation_ref'),
    substantiationUrl: text('substantiation_url'),
    jurisdictions: text('jurisdictions').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Disclaimer that must accompany this claim, if any. */
    requiredDisclaimerId: uuid('required_disclaimer_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBrand: index('claims_brand_idx').on(t.orgId, t.brandId),
    byExpiry: index('claims_expiry_idx').on(t.expiresAt),
  }),
);

/**
 * Disclaimers. Most tools check only that the text is present. We check four
 * things: present, ≥ min font size, ≥ min contrast, and adjacent to the claim
 * it qualifies.
 */
export const disclaimers = pgTable(
  'disclaimers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    text: text('text').notNull(),
    marketCodes: text('market_codes').array(),
    channels: text('channels').array(),
    minFontSizePt: real('min_font_size_pt').default(8),
    minContrastRatio: real('min_contrast_ratio').default(4.5),
    /** Max distance from the qualified claim, as a fraction of canvas height. */
    maxProximityPct: real('max_proximity_pct').default(0.25),
    isRequired: boolean('is_required').notNull().default(true),
    severity: severityEnum('severity').notNull().default('blocker'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('disclaimers_brand_idx').on(t.orgId, t.brandId) }),
);

/**
 * Image style profile — the "our photography is bright, candid, natural light"
 * rule, learned from the approved corpus instead of written down. Stores the
 * fitted distribution over measurable style features plus the embedding
 * centroid for manifold-distance scoring.
 */
export const imageStyleProfiles = pgTable(
  'image_style_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    /** { saturation: {mean, sd}, luminance: {...}, warmth: {...},
     *    contrast: {...}, hueSpread: {...} } */
    featureStats: jsonb('feature_stats').$type<Record<string, unknown>>().notNull().default({}),
    centroid: real('centroid').array(),
    /** p5 distance in the approved corpus — the natural rejection boundary. */
    distanceP5: real('distance_p5'),
    distanceP50: real('distance_p50'),
    sampleSize: integer('sample_size').notNull().default(0),
    allowedMediums: text('allowed_mediums').array(), // photo|illustration|3d|screenshot
    prohibitedSubjects: text('prohibited_subjects').array(),
    embeddingModel: varchar('embedding_model', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('image_style_profiles_brand_idx').on(t.orgId, t.brandId) }),
);

/* ==========================================================================
 * RULES — the core primitive. Typed, versioned, scoped, cited.
 * ========================================================================== */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),

    /** Stable across versions — precedents and calibration key on this. */
    key: varchar('key', { length: 160 }).notNull(),
    version: integer('version').notNull().default(1),

    statement: text('statement').notNull(),
    rationale: text('rationale'),
    dimension: ruleDimensionEnum('dimension').notNull(),
    tier: checkTierEnum('tier').notNull(),
    severity: severityEnum('severity').notNull().default('major'),
    /** Contribution to the dimension score. Blockers override the score. */
    weight: real('weight').notNull().default(1),

    /**
     * Scope lattice. Resolution is most-specific-wins with CSS-like
     * specificity: global → sub-brand → market → channel → campaign.
     * `['*']` means "any".
     */
    scope: jsonb('scope')
      .$type<{
        subBrands?: string[];
        markets?: string[];
        channels?: string[];
        assetTypes?: string[];
        campaigns?: string[];
      }>()
      .notNull()
      .default({}),
    specificity: integer('specificity').notNull().default(0),

    /** Which analyzer runs it, and with what parameters.
     *  { fn: 'logo.clearspace', params: { multiple: 1.0, unit: 'logomark_height' } } */
    check: jsonb('check')
      .$type<{ fn: string; params?: Record<string, unknown> }>()
      .notNull(),

    /** For VLM rules: the rubric leaf. Binary wherever the criterion allows —
     *  LLMs are poorly calibrated on continuous scales. */
    rubric: jsonb('rubric').$type<Record<string, unknown>>(),

    /**
     * Citation back to the brand book, page + normalized bbox.
     *
     * Fields are `| null` as well as optional because these objects arrive
     * verbatim from the Python engine's extraction pass, and Pydantic
     * serialises an unset Optional as an explicit null. Declaring them
     * `?: string` only would force a lossy scrub on every write.
     */
    provenance: ruleProvenanceEnum('provenance').notNull().default('manual'),
    citation: jsonb('citation').$type<{
      doc?: string | null;
      documentId?: string | null;
      page?: number | null;
      bbox?: [number, number, number, number] | null;
      extractedBy?: string | null;
      confirmedByUserId?: string | null;
    }>(),

    /** For induced rules: the statistical evidence that produced them. */
    /** Mirrors RuleSupport in @brandlens/contracts — keep the two in step. */
    support: jsonb('support').$type<{
      sampleSize?: number | null;
      percentile?: number | null;
      observedValue?: number | null;
      exampleAssetIds?: string[] | null;
      /** Share of the sample supporting the rule, 0..1. */
      agreement?: number | null;
      /** Caveat shown to whoever is deciding whether to activate this. */
      note?: string | null;
      observed?: Array<Record<string, unknown>> | null;
    }>(),

    /* --- Fork lineage ------------------------------------------------------
     * Set when this rule was forked from a shipped template. Keeping the
     * template's version too is what lets the console say "the baseline has
     * moved on since you forked this" — a fork with no lineage silently rots
     * while the standard it copied gets corrected underneath it.
     * -------------------------------------------------------------------- */
    forkedFromTemplateId: uuid('forked_from_template_id'),
    forkedFromVersion: integer('forked_from_version'),

    status: ruleStatusEnum('status').notNull().default('proposed'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),

    /** Per-tenant calibrated threshold learned from human overrides. */
    calibration: jsonb('calibration').$type<{
      thresholdOverride?: number;
      alpha?: number;
      beta?: number;
      agreementRate?: number;
      overrideRate?: number;
      sampleSize?: number;
      updatedAt?: string;
      /** beta < 0.3 ⇒ the judge does not track this tenant's humans.
       *  The rule is auto-routed to human review. */
      autoRouteToHuman?: boolean;
    }>(),

    /** DSPy/GEPA-optimised prompt, versioned per tenant per rule. */
    optimizedPrompt: text('optimized_prompt'),
    optimizedPromptHash: varchar('optimized_prompt_hash', { length: 80 }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    activatedByUserId: uuid('activated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyVersionUq: uniqueIndex('rules_brand_key_version_uq').on(t.brandId, t.key, t.version),
    byBrandStatus: index('rules_brand_status_idx').on(t.orgId, t.brandId, t.status),
    byDimension: index('rules_dimension_idx').on(t.brandId, t.dimension),
    byTier: index('rules_tier_idx').on(t.brandId, t.tier),
  }),
);

/* ==========================================================================
 * RULESETS — the "brand compile" step.
 *
 * Resolving the lattice for a given (brand, subbrand, market, channel,
 * assetType) is expensive and must be reproducible, so we precompute the
 * effective set and hash it. `ruleset_hash` then becomes the cache key, the
 * audit anchor and the reproducibility guarantee, all at once.
 * ========================================================================== */
export const rulesets = pgTable(
  'rulesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    hash: varchar('hash', { length: 80 }).notNull(),
    label: varchar('label', { length: 200 }),

    /** Frozen, fully-resolved snapshot of every rule at publish time. */
    compiled: jsonb('compiled').$type<Record<string, unknown>>().notNull(),
    ruleCount: integer('rule_count').notNull().default(0),

    /** Dimension weights used to aggregate the headline score. */
    scoringConfig: jsonb('scoring_config').$type<Record<string, unknown>>().notNull().default({}),

    publishedByUserId: uuid('published_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUq: uniqueIndex('rulesets_brand_hash_uq').on(t.brandId, t.hash),
    byBrandVersion: index('rulesets_brand_version_idx').on(t.orgId, t.brandId, t.version),
  }),
);

/* ==========================================================================
 * BRAND DOCUMENTS — the brand book and friends. Ingested, chunked, cited.
 * ========================================================================== */
export const brandDocuments = pgTable(
  'brand_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 300 }).notNull(),
    kind: varchar('kind', { length: 60 }).notNull().default('brandbook'), // brandbook|tone-guide|legal|design-system|spec
    storageKey: text('storage_key').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }),
    pageCount: integer('page_count'),
    status: varchar('status', { length: 40 }).notNull().default('uploaded'), // uploaded|parsing|parsed|extracting|extracted|failed
    extractionStats: jsonb('extraction_stats').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('brand_documents_brand_idx').on(t.orgId, t.brandId) }),
);

/** Layout-aware chunks with page + bbox, so every extracted rule can cite. */
export const brandDocumentChunks = pgTable(
  'brand_document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => brandDocuments.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    bbox: real('bbox').array(),
    /** Rasterised page crop, so the extractor and the UI can show the source. */
    imageKey: text('image_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index('brand_document_chunks_doc_idx').on(t.documentId, t.page, t.ordinal),
  }),
);

export const brandsRelations = relations(brands, ({ many, one }) => ({
  org: one(organizations, { fields: [brands.orgId], references: [organizations.id] }),
  tokens: many(designTokens),
  logos: many(logoVariants),
  typeStyles: many(typeStyles),
  voice: many(voiceAttributes),
  claims: many(claims),
  disclaimers: many(disclaimers),
  rules: many(rules),
  rulesets: many(rulesets),
  documents: many(brandDocuments),
  markets: many(markets),
}));

export const rulesRelations = relations(rules, ({ one }) => ({
  brand: one(brands, { fields: [rules.brandId], references: [brands.id] }),
}));
