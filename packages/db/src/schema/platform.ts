import { sql } from 'drizzle-orm';
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
import { assets } from './assets';
import { briefStatusEnum, outboxStatusEnum, predictionStatusEnum, webhookStatusEnum } from './enums';

/* ==========================================================================
 * CHANNEL SPEC REGISTRY
 *
 * Boring, tedious, constantly drifting — and therefore a real moat. Every
 * platform changes its safe zones 2–4× a year and nobody maintains them well.
 * Declarative, versioned, validated with zero model cost and 100% precision.
 * ========================================================================== */
export const channelSpecs = pgTable(
  'channel_specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null = global registry row shipped with BrandLens; set = tenant override. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 60 }).notNull(), // meta|tiktok|google|amazon|linkedin|dooh|print|iab
    placement: varchar('placement', { length: 120 }).notNull(), // feed|story|reel|in-stream|display
    assetType: varchar('asset_type', { length: 40 }).notNull(), // image|video|html5
    version: varchar('version', { length: 40 }).notNull().default('2026.1'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),

    /** { aspectRatios:[{w,h,tolerance}], minWidth, minHeight, maxBytes,
     *    formats:[], durationMs:{min,max}, fps:{min,max}, bitrateKbps:{min},
     *    audio:{codec,sampleRate}, safeZones:{top,right,bottom,left},
     *    textLimits:{headline,primary,description},
     *    textDensityAdvisoryPct } */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    docsUrl: text('docs_url'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('channel_specs_uq').on(t.platform, t.placement, t.assetType, t.version, t.orgId),
    byPlatform: index('channel_specs_platform_idx').on(t.platform, t.placement),
  }),
);

/* ==========================================================================
 * WEBHOOKS + TRANSACTIONAL OUTBOX
 * Side effects commit atomically with the state change and are dispatched by
 * a separate relay, so we never emit an event for a transaction that rolled
 * back — and never lose one that committed.
 * ========================================================================== */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: varchar('description', { length: 300 }),
    events: text('events').array().notNull().default(sql`ARRAY[]::text[]`),
    secret: text('secret').notNull(),
    status: webhookStatusEnum('status').notNull().default('active'),
    failureCount: integer('failure_count').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byOrg: index('webhook_endpoints_org_idx').on(t.orgId, t.status) }),
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    aggregateType: varchar('aggregate_type', { length: 60 }).notNull(),
    aggregateId: uuid('aggregate_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Deduplicates redelivery of the same logical event. */
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pending: index('outbox_pending_idx').on(t.status, t.nextAttemptAt),
    byOrg: index('outbox_org_idx').on(t.orgId, t.createdAt),
    idem: uniqueIndex('outbox_idempotency_uq').on(t.idempotencyKey),
  }),
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    outboxEventId: uuid('outbox_event_id').references(() => outboxEvents.id, { onDelete: 'set null' }),
    attempt: integer('attempt').notNull().default(1),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byEndpoint: index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt) }),
);

/* ==========================================================================
 * SKILL 2 — INSTRUCT TO ASSEMBLE
 * Brief in; a plan out: which approved assets to use, how to adapt them per
 * channel, and the generation instructions that keep variants on-brand.
 * ========================================================================== */
export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id'),
    title: varchar('title', { length: 300 }).notNull(),
    objective: text('objective'),
    audience: jsonb('audience').$type<Record<string, unknown>>().notNull().default({}),
    keyMessage: text('key_message'),
    /** Requested outputs: [{ platform, placement, assetType, count, market }] */
    targets: jsonb('targets').$type<Record<string, unknown>[]>().notNull().default([]),
    mandatories: text('mandatories').array(),
    status: briefStatusEnum('status').notNull().default('draft'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('briefs_brand_idx').on(t.orgId, t.brandId, t.createdAt) }),
);

export const assemblyPlans = pgTable(
  'assembly_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    briefId: uuid('brief_id')
      .notNull()
      .references(() => briefs.id, { onDelete: 'cascade' }),
    rulesetHash: varchar('ruleset_hash', { length: 80 }).notNull(),
    /** [{ target, sourceAssetIds[], crop, layout, copy:{headline,body,cta},
     *     tokens:{bg,fg}, generationInstructions, predictedRisks[] }] */
    items: jsonb('items').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Rules the plan is designed to satisfy — the plan is auditable too. */
    constraintsApplied: jsonb('constraints_applied').$type<Record<string, unknown>>().notNull().default({}),
    rationale: text('rationale'),
    costUsd: real('cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrief: index('assembly_plans_brief_idx').on(t.briefId) }),
);

/* ==========================================================================
 * SKILL 3 — PREDICT
 * Synthetic audience panels score an asset before launch. Reported as a
 * distribution with an explicit confidence interval, never a bare number.
 * ========================================================================== */
export const audiencePanels = pgTable(
  'audience_panels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    /** [{ id, label, demographics, psychographics, mediaHabits, objections }] */
    personas: jsonb('personas').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Historical performance used to ground the simulation, when available. */
    groundingStats: jsonb('grounding_stats').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBrand: index('audience_panels_brand_idx').on(t.orgId, t.brandId) }),
);

export const predictions = pgTable(
  'predictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    panelId: uuid('panel_id').references(() => audiencePanels.id, { onDelete: 'set null' }),
    status: predictionStatusEnum('status').notNull().default('queued'),

    /** Relative, not absolute — VLM judges rank far better than they score,
     *  so we rank a candidate against the tenant's own past assets. */
    percentileVsCorpus: real('percentile_vs_corpus'),
    /** { attention, clarity, brandFit, persuasion, distinctiveness } */
    dimensionScores: jsonb('dimension_scores').$type<Record<string, number>>().notNull().default({}),
    intervalLow: real('interval_low'),
    intervalHigh: real('interval_high'),
    /** Per-persona reactions with verbatim objections. */
    panelResponses: jsonb('panel_responses').$type<Record<string, unknown>[]>().notNull().default([]),
    comparisonAssetIds: uuid('comparison_asset_ids').array(),
    recommendations: jsonb('recommendations').$type<Record<string, unknown>[]>().notNull().default([]),
    costUsd: real('cost_usd').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({ byAsset: index('predictions_asset_idx').on(t.assetId, t.createdAt) }),
);

/** Content-addressed LLM/analysis result cache. Target > 60% hit rate. */
export const resultCache = pgTable(
  'result_cache',
  {
    cacheKey: varchar('cache_key', { length: 100 }).primaryKey(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 60 }).notNull(),
    value: jsonb('value').notNull(),
    hits: integer('hits').notNull().default(0),
    costSavedUsd: real('cost_saved_usd').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  },
  (t) => ({
    byKind: index('result_cache_kind_idx').on(t.kind, t.createdAt),
    byExpiry: index('result_cache_expiry_idx').on(t.expiresAt),
  }),
);

/** Runtime flags surfaced on the health endpoint (pgvector on/off, etc.). */
export const systemState = pgTable('system_state', {
  key: varchar('key', { length: 120 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const isBoolean = boolean; // re-export guard for schema consumers
