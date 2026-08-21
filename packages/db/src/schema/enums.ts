import { pgEnum } from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ *
 * Identity & access
 * ------------------------------------------------------------------ */
export const orgPlanEnum = pgEnum('org_plan', ['free', 'team', 'business', 'enterprise']);
export const memberRoleEnum = pgEnum('member_role', [
  'owner', // billing + destructive actions
  'admin', // full config
  'brand_manager', // owns the ontology; activates rules
  'reviewer', // decides findings; their decisions become gold labels
  'creator', // submits assets, sees own results
  'viewer', // read-only
  'service', // machine identity behind an API key
]);

/* ------------------------------------------------------------------ *
 * Brand ontology
 * ------------------------------------------------------------------ */

/** Where a rule came from. Drives how much we trust it and how we display it. */
export const ruleProvenanceEnum = pgEnum('rule_provenance', [
  'deductive', // extracted from the brand book
  'inductive', // induced by measuring the approved corpus
  'transfer', // imported from an external standard (WCAG, IAB, platform spec)
  'manual', // hand-authored by a human
]);

export const ruleStatusEnum = pgEnum('rule_status', [
  'proposed', // awaiting human confirmation — NEVER auto-activated
  'active',
  'deprecated',
  'rejected',
]);

/**
 * Severity ladder. `blocker` forces the asset to fail regardless of score;
 * `advisory` never fails an asset and is hidden behind a fold in the UI
 * (false positives on advisories are what destroy reviewer trust).
 */
export const severityEnum = pgEnum('severity', ['blocker', 'major', 'minor', 'advisory']);

/** Which execution tier implements a rule. See docs/architecture.md §4. */
export const checkTierEnum = pgEnum('check_tier', [
  'deterministic', // T0 — parse + arithmetic. ~$0, ~100% precision.
  'cv', // T1 — classical CV / embeddings. ~$0.001.
  'vlm', // T2 — vision judge. $0.005–0.05, 70–90%.
  'hybrid', // T1 measures, T2 adjudicates the measurement
]);

export const ruleDimensionEnum = pgEnum('rule_dimension', [
  'logo',
  'color',
  'typography',
  'layout',
  'imagery',
  'copy',
  'accessibility',
  'channel_spec',
  'legal',
]);

export const tokenTypeEnum = pgEnum('token_type', [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'duration',
  'number',
  'shadow',
  'typography',
  'other',
]);

export const logoVariantKindEnum = pgEnum('logo_variant_kind', [
  'primary',
  'horizontal_lockup',
  'stacked_lockup',
  'monochrome_black',
  'monochrome_white',
  'knockout',
  'icon_only',
  'wordmark_only',
  'cobrand_lockup',
]);

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */
export const assetKindEnum = pgEnum('asset_kind', [
  'image',
  'video',
  'pdf',
  'html',
  'figma',
  'pptx',
  'psd',
  'copy', // text-only submission
]);

export const assetStatusEnum = pgEnum('asset_status', [
  'uploading',
  'ingested',
  'analyzing',
  'analyzed',
  'failed',
  'quarantined',
]);

/** How we got the asset's structure. Structured beats pixels — always. */
export const sourceFidelityEnum = pgEnum('source_fidelity', [
  'structured', // PDF/Figma/PPTX/HTML — exact fonts, colors, boxes. Ground truth.
  'raster', // flattened JPEG/PNG/MP4 — everything is inference
  'mixed',
]);

/* ------------------------------------------------------------------ *
 * Checks, findings, decisions
 * ------------------------------------------------------------------ */
export const checkRunStatusEnum = pgEnum('check_run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'degraded', // finished on deterministic tiers only, e.g. budget guard tripped
]);

export const verdictEnum = pgEnum('verdict', [
  'pass',
  'fail',
  'not_applicable',
  'insufficient_evidence', // without this the model fabricates verdicts
  'abstained', // below confidence threshold — routed to a human
]);

export const findingStatusEnum = pgEnum('finding_status', [
  'open',
  'confirmed', // a human agreed with the machine
  'overridden', // a human disagreed — the highest-value training signal we own
  'waived', // accepted this once, with a rationale
  'fixed',
]);

export const reviewActionEnum = pgEnum('review_action', [
  'confirm',
  'override_pass',
  'override_fail',
  'waive',
  'escalate',
  'comment',
]);

export const reviewStateEnum = pgEnum('review_state', [
  'pending',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
]);

/* ------------------------------------------------------------------ *
 * Assemble / Predict
 * ------------------------------------------------------------------ */
export const briefStatusEnum = pgEnum('brief_status', ['draft', 'planned', 'assembling', 'ready', 'failed']);
export const predictionStatusEnum = pgEnum('prediction_status', ['queued', 'running', 'completed', 'failed']);

/* ------------------------------------------------------------------ *
 * Discovery — URL in, brand ontology out
 * ------------------------------------------------------------------ */
export const discoveryStatusEnum = pgEnum('discovery_status', [
  'queued',
  'running',
  'completed',
  'partial', // some stages succeeded; see stage_errors
  'failed',
  'cancelled',
]);

/**
 * Stages run in this order and the column stores the one currently executing,
 * so a stalled run says WHERE it stalled. A single `running` status would make
 * "stuck for six minutes" indistinguishable between a slow crawl and a hung
 * vision call.
 */
export const discoveryStageEnum = pgEnum('discovery_stage', [
  'pending',
  'harvesting', // headless browser walks the site
  'extracting', // computed styles + copy -> candidate ontology
  'inducing', // candidate ontology -> proposed rules -> compiled ruleset
  'checking', // the 40 analyzers run over the harvested pages
  'reporting', // aggregate into the consolidated report
  'done',
]);

/* ------------------------------------------------------------------ *
 * Platform
 * ------------------------------------------------------------------ */
export const webhookStatusEnum = pgEnum('webhook_status', ['active', 'paused', 'disabled']);
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'dispatched', 'failed', 'dead']);
export const jobPoolEnum = pgEnum('job_pool', ['cpu_media', 'llm_io', 'default']);
