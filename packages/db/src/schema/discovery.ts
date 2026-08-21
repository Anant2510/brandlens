import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './tenancy';
import { brands, rulesets } from './ontology';
import { assets } from './assets';
import { discoveryStageEnum, discoveryStatusEnum } from './enums';

/* ==========================================================================
 * DISCOVERY — "give me a URL, get a brand"
 *
 * The inverse of the rest of the product. Everywhere else a human supplies
 * the ontology and BrandLens grades assets against it. Here BrandLens reads a
 * public website and PROPOSES the ontology, then immediately turns its own
 * proposal back on the site to show where the brand contradicts itself.
 *
 * The design rule that keeps this from becoming a second product: a harvested
 * page IS an asset. Each page render is registered in `assets` with
 * kind='html' and sourceFidelity='structured' — computed styles are exact
 * font/colour/box data, not inference from pixels — so the existing check
 * pipeline, decision traces, findings, review queue, precedents and analytics
 * all work on discovered pages without a line of special-casing.
 *
 * Consequently these two tables carry only what is genuinely new: the crawl
 * itself and its per-page provenance. Rules, rulesets, checks and findings
 * live in the tables they always lived in.
 * ========================================================================== */

export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Null until the extract stage names the brand and creates it. */
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'cascade' }),
    /** The ruleset compiled from what we found. Null until the induce stage. */
    rulesetId: uuid('ruleset_id').references(() => rulesets.id, { onDelete: 'set null' }),

    /* --- Input ------------------------------------------------------------
     * `seedUrl` is exactly what the user typed; `originUrl` is the normalised
     * scheme+host we actually crawl and the same-origin test compares against.
     * Keeping both means an audit can answer "what did they ask for" and
     * "what did we fetch" separately, which matters when a redirect moved us.
     * -------------------------------------------------------------------- */
    seedUrl: text('seed_url').notNull(),
    originUrl: text('origin_url').notNull(),

    /** maxPages, maxDepth, viewports, includeSubdomains, respectRobots… */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * hash(originUrl, options, pipelineVersion, modelVersion). Re-submitting
     * the same site with the same settings returns the finished run instead of
     * re-crawling someone else's servers — the same content-addressing rule the
     * check pipeline uses, applied to a far ruder side effect.
     */
    discoveryKey: varchar('discovery_key', { length: 80 }).notNull(),
    pipelineVersion: varchar('pipeline_version', { length: 40 }).notNull(),

    status: discoveryStatusEnum('status').notNull().default('queued'),
    stage: discoveryStageEnum('stage').notNull().default('pending'),
    /** 0..1 within the current stage, for a progress bar that does not lie. */
    stageProgress: real('stage_progress').notNull().default(0),

    /* --- What the crawl found -------------------------------------------- */
    pagesDiscovered: integer('pages_discovered').notNull().default(0),
    pagesHarvested: integer('pages_harvested').notNull().default(0),
    pagesFailed: integer('pages_failed').notNull().default(0),

    /* --- What the extraction proposed ------------------------------------ */
    tokensProposed: integer('tokens_proposed').notNull().default(0),
    rulesProposed: integer('rules_proposed').notNull().default(0),

    /* --- What checking its own site revealed ------------------------------
     * The headline of the report. `consistencyScore` is a deterministic
     * aggregation over the same criteria the check pipeline uses — never a
     * number a model emitted.
     * -------------------------------------------------------------------- */
    consistencyScore: real('consistency_score'),
    findingsTotal: integer('findings_total').notNull().default(0),
    blockersTotal: integer('blockers_total').notNull().default(0),

    /**
     * The rendered report: identity, voice, claims, ruleset summary,
     * per-page results. Denormalised on purpose — the report is a snapshot of
     * what was true at run time, and rules move afterwards.
     */
    report: jsonb('report').$type<Record<string, unknown>>(),

    costUsd: real('cost_usd').notNull().default(0),
    durationMs: real('duration_ms'),

    /**
     * Per-stage failures that did not kill the run. A site that blocks the
     * crawler on three pages out of eight should still produce a report and
     * say so, rather than throwing away five good pages.
     */
    stageErrors: jsonb('stage_errors').$type<Array<{ stage: string; message: string; url?: string | null }>>()
      .notNull()
      .default([]),
    error: text('error'),

    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    triggeredBy: varchar('triggered_by', { length: 40 }).notNull().default('ui'), // ui|api|mcp|schedule

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Scoped to the org, not global: two tenants discovering the same public
    // site must not share a run, or one would read the other's report.
    keyUq: uniqueIndex('discovery_runs_org_key_uq').on(t.orgId, t.discoveryKey),
    byOrg: index('discovery_runs_org_idx').on(t.orgId, t.createdAt),
    byBrand: index('discovery_runs_brand_idx').on(t.brandId),
    byStatus: index('discovery_runs_status_idx').on(t.orgId, t.status),
  }),
);

/**
 * One row per page the crawler actually rendered.
 *
 * `assetId` points at the registered screenshot, which is what makes the
 * existing analyzers, evidence crops and findings work unchanged.
 */
export const discoveredPages = pgTable(
  'discovered_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    discoveryRunId: uuid('discovery_run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),
    /** Crawl distance from the seed. 0 is the page the user gave us. */
    depth: integer('depth').notNull().default(0),
    /** home|about|product|pricing|careers|legal|blog|other — drives which
     *  extractions are worth running (claims matter on product, not careers). */
    role: varchar('role', { length: 40 }).notNull().default('other'),

    title: text('title'),
    httpStatus: integer('http_status'),
    /** desktop|mobile — the same URL is harvested at both widths. */
    viewport: varchar('viewport', { length: 20 }).notNull().default('desktop'),

    /** The full-page screenshot, registered as an ordinary asset. */
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),

    /**
     * Computed styles, text runs with their selectors, image and logo
     * candidates. This is the STRUCTURED source — exact values straight from
     * the browser's layout engine rather than anything inferred from pixels —
     * and it is what makes discovery-derived rules defensible.
     */
    extractKey: text('extract_key'),
    extractSummary: jsonb('extract_summary').$type<Record<string, unknown>>().notNull().default({}),

    renderMs: real('render_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    urlUq: uniqueIndex('discovered_pages_run_url_viewport_uq').on(t.discoveryRunId, t.url, t.viewport),
    byRun: index('discovered_pages_run_idx').on(t.discoveryRunId, t.depth),
    byAsset: index('discovered_pages_asset_idx').on(t.assetId),
  }),
);

export const discoveryRunsRelations = relations(discoveryRuns, ({ one, many }) => ({
  brand: one(brands, { fields: [discoveryRuns.brandId], references: [brands.id] }),
  ruleset: one(rulesets, { fields: [discoveryRuns.rulesetId], references: [rulesets.id] }),
  pages: many(discoveredPages),
}));

export const discoveredPagesRelations = relations(discoveredPages, ({ one }) => ({
  run: one(discoveryRuns, { fields: [discoveredPages.discoveryRunId], references: [discoveryRuns.id] }),
  asset: one(assets, { fields: [discoveredPages.assetId], references: [assets.id] }),
}));
