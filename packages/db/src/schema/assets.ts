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
import { brands } from './ontology';
import { assetKindEnum, assetStatusEnum, sourceFidelityEnum } from './enums';

/**
 * A variant family groups a master asset with its resized derivatives.
 * Expensive semantic checks run ONCE on the master; per-variant we run only
 * geometry and channel-spec checks. For ad production this alone cuts VLM
 * spend by 10–20×.
 */
export const variantFamilies = pgTable(
  'variant_families',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 300 }).notNull(),
    masterAssetId: uuid('master_asset_id'),
    campaignId: uuid('campaign_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('variant_families_brand_idx').on(t.orgId, t.brandId) }),
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 300 }).notNull(),
    code: varchar('code', { length: 80 }),
    brief: text('brief'),
    audience: jsonb('audience').$type<Record<string, unknown>>().notNull().default({}),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Campaign-level exceptions to brand rules, e.g. an approved co-brand. */
    ruleExceptions: jsonb('rule_exceptions').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('campaigns_brand_idx').on(t.orgId, t.brandId) }),
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    variantFamilyId: uuid('variant_family_id').references(() => variantFamilies.id, { onDelete: 'set null' }),

    name: varchar('name', { length: 400 }).notNull(),
    kind: assetKindEnum('kind').notNull(),
    status: assetStatusEnum('status').notNull().default('uploading'),

    /** BLAKE3/SHA-256 of the bytes. Deduplication + cache key + audit anchor. */
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: varchar('mime_type', { length: 120 }),
    byteSize: integer('byte_size'),

    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    /** Colour management: reading the ICC profile is the most-missed step.
     *  Display-P3 assets analysed as sRGB read as oversaturated and produce
     *  mass false positives. */
    colorProfile: varchar('color_profile', { length: 80 }),
    dpi: real('dpi'),

    sourceFidelity: sourceFidelityEnum('source_fidelity').notNull().default('raster'),
    /** Parsed structure when the source is not flattened: per-span fonts,
     *  sizes, colours, bboxes, vector fills. Ground truth, not inference. */
    structuredSource: jsonb('structured_source').$type<Record<string, unknown>>(),

    /** Context that changes which rules apply. */
    market: varchar('market', { length: 20 }),
    channel: varchar('channel', { length: 60 }),
    assetType: varchar('asset_type', { length: 60 }),
    locale: varchar('locale', { length: 20 }),

    /** Copy submitted alongside the creative (headline, body, CTA, alt text). */
    copyFields: jsonb('copy_fields').$type<Record<string, string>>().notNull().default({}),

    /** C2PA / Content Credentials manifest, when present. */
    provenance: jsonb('provenance').$type<Record<string, unknown>>(),

    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Marks membership of the approved corpus used for rule induction. */
    isApprovedExemplar: boolean('is_approved_exemplar').notNull().default(false),

    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    byOrgBrand: index('assets_org_brand_idx').on(t.orgId, t.brandId, t.createdAt),
    byHash: index('assets_hash_idx').on(t.orgId, t.contentHash),
    byFamily: index('assets_family_idx').on(t.variantFamilyId),
    byExemplar: index('assets_exemplar_idx').on(t.brandId, t.isApprovedExemplar),
    byStatus: index('assets_status_idx').on(t.orgId, t.status),
  }),
);

/**
 * Derivatives are reproducible: thumbnails, page rasters, evidence crops,
 * tiles. Keyed by (content_hash, transform_hash) so they dedupe, and
 * lifecycle-expired aggressively.
 */
export const assetDerivatives = pgTable(
  'asset_derivatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 60 }).notNull(), // thumbnail|page|crop|tile|frame|overlay
    transformHash: varchar('transform_hash', { length: 80 }).notNull(),
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('asset_derivatives_uq').on(t.assetId, t.kind, t.transformHash),
    byAsset: index('asset_derivatives_asset_idx').on(t.assetId),
  }),
);

/**
 * Embeddings are pure functions of (bytes, model_id, preprocessing_version) —
 * never recomputed. `preprocessing_version` matters: a change to the
 * resize/crop/normalise code silently invalidates every vector, and without
 * the field you will not know it happened.
 *
 * Portability: `vec` (real[]) is always populated. When pgvector is present a
 * migration adds `vec_p vector(N)` plus an HNSW index and keeps it in sync via
 * trigger, so the same schema runs on a plain Postgres install.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** asset | logo | copy | precedent | rule_exemplar | style_reference */
    ownerType: varchar('owner_type', { length: 40 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    /** image | text */
    space: varchar('space', { length: 20 }).notNull(),
    modelId: varchar('model_id', { length: 120 }).notNull(),
    preprocessingVersion: varchar('preprocessing_version', { length: 40 }).notNull().default('v1'),
    dim: integer('dim').notNull(),
    vec: real('vec').array().notNull(),
    norm: real('norm'),
    contentHash: varchar('content_hash', { length: 80 }),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('embeddings_owner_model_uq').on(
      t.ownerType,
      t.ownerId,
      t.space,
      t.modelId,
      t.preprocessingVersion,
    ),
    byOrgSpace: index('embeddings_org_space_idx').on(t.orgId, t.space, t.ownerType),
    byContent: index('embeddings_content_idx').on(t.contentHash, t.modelId),
  }),
);

/** Cached measurement output per (asset, analyzer, version). Pure function. */
export const assetMeasurements = pgTable(
  'asset_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    analyzer: varchar('analyzer', { length: 80 }).notNull(),
    analyzerVersion: varchar('analyzer_version', { length: 40 }).notNull(),
    /** Palette clusters, OCR spans, detected boxes, contrast pairs, geometry. */
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    /** Engine-reported, sub-millisecond. See check_runs.duration_ms. */
    durationMs: real('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('asset_measurements_uq').on(t.assetId, t.analyzer, t.analyzerVersion),
    byAsset: index('asset_measurements_asset_idx').on(t.assetId),
  }),
);

export const assetsRelations = relations(assets, ({ one, many }) => ({
  brand: one(brands, { fields: [assets.brandId], references: [brands.id] }),
  campaign: one(campaigns, { fields: [assets.campaignId], references: [campaigns.id] }),
  family: one(variantFamilies, { fields: [assets.variantFamilyId], references: [variantFamilies.id] }),
  derivatives: many(assetDerivatives),
  measurements: many(assetMeasurements),
}));
