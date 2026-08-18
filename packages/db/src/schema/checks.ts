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
import { brands, rules, rulesets } from './ontology';
import { assets } from './assets';
import {
  checkRunStatusEnum,
  checkTierEnum,
  findingStatusEnum,
  reviewActionEnum,
  reviewStateEnum,
  severityEnum,
  verdictEnum,
} from './enums';

/* ==========================================================================
 * CHECK RUNS
 *
 * job_key = hash(asset_content_hash, ruleset_hash, pipeline_version,
 *                model_version, prompt_hash)
 *
 * One design choice buys idempotency, caching, precise invalidation on
 * ruleset change, and bit-reproducibility for audit — all at once.
 * ========================================================================== */
export const checkRuns = pgTable(
  'check_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    rulesetId: uuid('ruleset_id').references(() => rulesets.id, { onDelete: 'set null' }),

    jobKey: varchar('job_key', { length: 80 }).notNull(),
    rulesetHash: varchar('ruleset_hash', { length: 80 }).notNull(),
    pipelineVersion: varchar('pipeline_version', { length: 40 }).notNull(),

    status: checkRunStatusEnum('status').notNull().default('queued'),

    /* --- Scoring ---------------------------------------------------------
     * The headline score is DETERMINISTIC AGGREGATION over atomic binary
     * criteria, weighted, with blockers overriding. It is never a raw number
     * from a vision model: VLM judges rank well but cannot score reliably.
     * ------------------------------------------------------------------- */
    score: real('score'),
    scoreBand: varchar('score_band', { length: 20 }), // pass|conditional|fail
    hasBlocker: boolean('has_blocker').notNull().default(false),
    /** Per-dimension analytic scores: logo, color, typography, layout, … */
    dimensionScores: jsonb('dimension_scores').$type<Record<string, number>>().notNull().default({}),

    criteriaTotal: integer('criteria_total').notNull().default(0),
    criteriaEvaluated: integer('criteria_evaluated').notNull().default(0),
    criteriaPassed: integer('criteria_passed').notNull().default(0),
    criteriaFailed: integer('criteria_failed').notNull().default(0),
    criteriaAbstained: integer('criteria_abstained').notNull().default(0),

    /** Headline value metric: share auto-decided without a human. */
    coverageRate: real('coverage_rate'),

    /** Reuse accounting — proves the cache is working. */
    cacheHits: integer('cache_hits').notNull().default(0),
    cacheMisses: integer('cache_misses').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** Wall-clock milliseconds. `real`, not `integer`: deterministic checks
     *  routinely complete in well under 1ms and rounding them all to 0 would
     *  destroy the per-tier latency signal we use to tune the pipeline. */
    durationMs: real('duration_ms'),

    /** Set when a budget guard trips: deterministic findings still ship. */
    degradedReason: text('degraded_reason'),

    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    triggeredBy: varchar('triggered_by', { length: 40 }).notNull().default('api'), // api|ui|webhook|schedule|mcp
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobKeyUq: uniqueIndex('check_runs_job_key_uq').on(t.orgId, t.jobKey),
    byAsset: index('check_runs_asset_idx').on(t.assetId, t.createdAt),
    byOrgStatus: index('check_runs_org_status_idx').on(t.orgId, t.status, t.createdAt),
    byBrand: index('check_runs_brand_idx').on(t.orgId, t.brandId, t.createdAt),
  }),
);

/* ==========================================================================
 * DECISION TRACES — immutable, content-addressed.
 *
 * This table IS the product. "Why did this fail?" renders the rule text, the
 * citation to page 14 of the brand book, the measured value against the
 * threshold, the cropped visual evidence, and precedent assets decided the
 * same way. That artifact is what makes the tool usable in regulated review.
 * ========================================================================== */
export const decisionTraces = pgTable(
  'decision_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    checkRunId: uuid('check_run_id')
      .notNull()
      .references(() => checkRuns.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),

    /** hash(asset_content_hash, ruleset_hash, rule_version, model_version,
     *       prompt_hash) — the cache key and the reproducibility guarantee. */
    traceKey: varchar('trace_key', { length: 80 }).notNull(),
    assetContentHash: varchar('asset_content_hash', { length: 80 }).notNull(),
    rulesetHash: varchar('ruleset_hash', { length: 80 }).notNull(),

    ruleId: uuid('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    ruleKey: varchar('rule_key', { length: 160 }).notNull(),
    ruleVersion: integer('rule_version').notNull(),
    dimension: varchar('dimension', { length: 40 }).notNull(),

    tier: checkTierEnum('tier').notNull(),
    verdict: verdictEnum('verdict').notNull(),
    severity: severityEnum('severity').notNull(),
    confidence: real('confidence'),

    /** Null for deterministic tiers. Members are nullable for the same reason
     *  as `evidence`: this is the engine's own payload, stored verbatim. */
    model: jsonb('model').$type<{
      provider?: string | null;
      id?: string | null;
      version?: string | null;
      promptHash?: string | null;
      temperature?: number | null;
      selfConsistencyK?: number | null;
      voteEntropy?: number | null;
    }>(),

    /**
     * The measured numbers. Code measures; the model only judges.
     *
     * Nullable members mirror the engine's Pydantic serialisation — an unset
     * Optional arrives as an explicit null, and this object is persisted
     * verbatim so the trace stays a faithful record of what the engine said.
     */
    evidence: jsonb('evidence')
      .$type<{
        measured?: Record<string, unknown> | null;
        threshold?: Record<string, unknown> | null;
        bbox?: [number, number, number, number] | null;
        cropKey?: string | null;
        quotedText?: string | null;
        observation?: string | null;
      }>()
      .notNull()
      .default({}),

    /** Similar past decisions used as few-shot context — balanced pass/fail
     *  so the label prior does not leak and turn the judge into a yes-machine. */
    precedentAssetIds: uuid('precedent_asset_ids').array(),
    citation: jsonb('citation').$type<Record<string, unknown>>(),
    suggestedFix: text('suggested_fix'),

    cached: boolean('cached').notNull().default(false),
    costUsd: real('cost_usd').notNull().default(0),
    /** See `check_runs.duration_ms` — sub-millisecond resolution is load-bearing
     *  for T0/T1, where a whole-millisecond integer would read as zero. */
    latencyMs: real('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    traceKeyIdx: index('decision_traces_key_idx').on(t.orgId, t.traceKey),
    byRun: index('decision_traces_run_idx').on(t.checkRunId),
    byRule: index('decision_traces_rule_idx').on(t.orgId, t.ruleKey, t.verdict),
    byAsset: index('decision_traces_asset_idx').on(t.assetId),
  }),
);

/** A finding is a failed/abstained trace surfaced to humans, with lifecycle. */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    checkRunId: uuid('check_run_id')
      .notNull()
      .references(() => checkRuns.id, { onDelete: 'cascade' }),
    traceId: uuid('trace_id')
      .notNull()
      .references(() => decisionTraces.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),

    ruleKey: varchar('rule_key', { length: 160 }).notNull(),
    dimension: varchar('dimension', { length: 40 }).notNull(),
    severity: severityEnum('severity').notNull(),
    title: varchar('title', { length: 400 }).notNull(),
    detail: text('detail'),
    status: findingStatusEnum('status').notNull().default('open'),

    /** Precision gate: only findings above the display threshold are shown by
     *  default. A reviewer who sees three bogus flags stops reading forever. */
    displayConfidence: real('display_confidence'),
    isHighConfidence: boolean('is_high_confidence').notNull().default(true),

    bbox: real('bbox').array(),
    cropKey: text('crop_key'),

    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index('findings_run_idx').on(t.checkRunId, t.severity),
    byOrgStatus: index('findings_org_status_idx').on(t.orgId, t.status, t.createdAt),
    byRule: index('findings_rule_idx').on(t.orgId, t.ruleKey),
  }),
);

/* ==========================================================================
 * HUMAN DECISIONS — the gold-label stream.
 * Every override is a training signal; the override rate per rule is the
 * single best product-health metric we have.
 * ========================================================================== */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    checkRunId: uuid('check_run_id').references(() => checkRuns.id, { onDelete: 'set null' }),
    state: reviewStateEnum('state').notNull().default('pending'),
    /** creative | legal | brand | marketing_ops — a multi-stage MLR-style gate. */
    stage: varchar('stage', { length: 60 }).notNull().default('brand'),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgState: index('reviews_org_state_idx').on(t.orgId, t.state, t.createdAt),
    byAssignee: index('reviews_assignee_idx').on(t.assignedToUserId, t.state),
  }),
);

export const reviewDecisions = pgTable(
  'review_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'cascade' }),
    traceId: uuid('trace_id').references(() => decisionTraces.id, { onDelete: 'cascade' }),
    findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),

    ruleKey: varchar('rule_key', { length: 160 }),
    ruleVersion: integer('rule_version'),
    action: reviewActionEnum('action').notNull(),
    /** The natural-language feedback that GEPA-style prompt optimisation
     *  consumes directly, and that later renders as precedent context. */
    rationale: text('rationale'),
    annotationBbox: real('annotation_bbox').array(),

    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Marks double/triple-annotated calibration items. Clean multi-annotator
     *  data produced 4.5× narrower judge intervals than single-annotator data,
     *  which makes this the highest-ROI labelling spend available. */
    isCalibrationLabel: boolean('is_calibration_label').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgRule: index('review_decisions_org_rule_idx').on(t.orgId, t.ruleKey, t.action),
    byTrace: index('review_decisions_trace_idx').on(t.traceId),
    byAsset: index('review_decisions_asset_idx').on(t.assetId),
    byReviewer: index('review_decisions_reviewer_idx').on(t.reviewerUserId, t.createdAt),
  }),
);

/**
 * Precedent index. At judge time we retrieve k nearest decided precedents
 * scoped to the specific rule and inject them as in-context examples with
 * their verdicts and reviewer rationales. This produces "it learned our
 * brand" behaviour with zero training.
 */
export const precedents = pgTable(
  'precedents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ruleKey: varchar('rule_key', { length: 160 }).notNull(),
    ruleVersion: integer('rule_version').notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    traceId: uuid('trace_id').references(() => decisionTraces.id, { onDelete: 'set null' }),
    /** The human verdict, not the machine's. */
    verdict: verdictEnum('verdict').notNull(),
    rationale: text('rationale'),
    measured: jsonb('measured').$type<Record<string, unknown>>(),
    cropKey: text('crop_key'),
    embeddingId: uuid('embedding_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRule: index('precedents_rule_idx').on(t.orgId, t.brandId, t.ruleKey, t.verdict),
    uq: uniqueIndex('precedents_rule_asset_uq').on(t.brandId, t.ruleKey, t.ruleVersion, t.assetId),
  }),
);

/**
 * Per-rule calibration snapshots. beta is the operational kill switch:
 * beta < 0.3 means the judge has essentially no correlation with this
 * tenant's humans, so the rule is routed 100% to human review.
 */
export const ruleCalibrations = pgTable(
  'rule_calibrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ruleKey: varchar('rule_key', { length: 160 }).notNull(),
    ruleVersion: integer('rule_version').notNull(),
    method: varchar('method', { length: 40 }).notNull().default('logistic'), // logistic|isotonic|bayesian-linear
    alpha: real('alpha'),
    beta: real('beta'),
    thresholdBefore: real('threshold_before'),
    thresholdAfter: real('threshold_after'),
    agreementRate: real('agreement_rate'),
    precision: real('precision'),
    recall: real('recall'),
    cohensKappa: real('cohens_kappa'),
    ece: real('ece'),
    sampleSize: integer('sample_size').notNull().default(0),
    coverageAtTarget: real('coverage_at_target'),
    autoRouteToHuman: boolean('auto_route_to_human').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRule: index('rule_calibrations_rule_idx').on(t.orgId, t.brandId, t.ruleKey, t.createdAt),
  }),
);

export const checkRunsRelations = relations(checkRuns, ({ one, many }) => ({
  asset: one(assets, { fields: [checkRuns.assetId], references: [assets.id] }),
  brand: one(brands, { fields: [checkRuns.brandId], references: [brands.id] }),
  ruleset: one(rulesets, { fields: [checkRuns.rulesetId], references: [rulesets.id] }),
  traces: many(decisionTraces),
  findings: many(findings),
}));

export const decisionTracesRelations = relations(decisionTraces, ({ one }) => ({
  run: one(checkRuns, { fields: [decisionTraces.checkRunId], references: [checkRuns.id] }),
  rule: one(rules, { fields: [decisionTraces.ruleId], references: [rules.id] }),
}));
