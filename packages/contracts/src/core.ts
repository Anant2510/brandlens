import { z } from 'zod';

/* ==========================================================================
 * Shared vocabulary.
 * This file is the single source of truth for the API surface, the engine
 * protocol and the web client. Changing a check contract here changes it
 * everywhere, which is the point.
 * ========================================================================== */

export const Severity = z.enum(['blocker', 'major', 'minor', 'advisory']);
export type Severity = z.infer<typeof Severity>;

export const CheckTier = z.enum(['deterministic', 'cv', 'vlm', 'hybrid']);
export type CheckTier = z.infer<typeof CheckTier>;

export const RuleDimension = z.enum([
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
export type RuleDimension = z.infer<typeof RuleDimension>;

/**
 * `not_applicable` and `insufficient_evidence` are mandatory members. Without
 * them a judge is forced to invent a verdict, which is a major source of the
 * false positives that destroy reviewer trust.
 */
export const Verdict = z.enum(['pass', 'fail', 'not_applicable', 'insufficient_evidence', 'abstained']);
export type Verdict = z.infer<typeof Verdict>;

export const RuleStatus = z.enum(['proposed', 'active', 'deprecated', 'rejected']);
export const RuleProvenance = z.enum(['deductive', 'inductive', 'transfer', 'manual']);

/** Normalized to [0,1] against the canvas, origin top-left. */
export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof BBox>;

export const ScopeSelector = z.object({
  subBrands: z.array(z.string()).optional(),
  markets: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  assetTypes: z.array(z.string()).optional(),
  campaigns: z.array(z.string()).optional(),
});
export type ScopeSelector = z.infer<typeof ScopeSelector>;

/* --------------------------------------------------------------------------
 * Rules
 * ------------------------------------------------------------------------ */
export const RuleCheckSpec = z.object({
  /** Analyzer identifier, e.g. `logo.clearspace`, `color.palette_conformance`. */
  fn: z.string(),
  params: z.record(z.unknown()).default({}),
});

export const RubricSpec = z.object({
  /** Atomic binary leaves wherever the criterion allows — LLMs are poorly
   *  calibrated on continuous scales, and brand rules are mostly binary. */
  kind: z.enum(['binary', 'ordinal', 'nominal']).default('binary'),
  question: z.string(),
  /** Every ordinal level must carry a fully labelled anchor. Unlabelled or
   *  asymmetric anchors bias responses. */
  levels: z.array(z.object({ value: z.number(), label: z.string(), anchor: z.string() })).nullish(),
  passWhen: z.string().nullish(),
  failWhen: z.string().nullish(),
  /** Whether to attach the tenant's own decided precedents as few-shot. */
  usePrecedents: z.boolean().default(true),
  /** Crop hint so we send the smallest image that answers the question. */
  cropTo: z.enum(['full', 'logo', 'text', 'region']).default('full'),
});

export const RuleCitation = z.object({
  doc: z.string().nullish(),
  documentId: z.string().uuid().nullish(),
  page: z.number().int().nullish(),
  bbox: BBox.nullish(),
  extractedBy: z.string().nullish(),
  confirmedByUserId: z.string().uuid().nullish(),
});

/**
 * The evidence behind a machine-proposed rule.
 *
 * A reviewer approving a rule they did not write needs to see what it was
 * inferred from, and `sampleSize` alone cannot carry that. `agreement` says
 * how much of the sample actually supported the rule — 6 of 8 pages is a
 * convention, 8 of 8 is a standard, 2 of 8 is a coincidence someone should
 * reject. `note` exists so a weak inference can admit it is weak rather than
 * inheriting the authority of the measured ones sitting next to it.
 */
export const RuleSupport = z.object({
  sampleSize: z.number().int().nullish(),
  percentile: z.number().nullish(),
  observedValue: z.number().nullish(),
  exampleAssetIds: z.array(z.string().uuid()).nullish(),
  /** Share of the sample that supported the rule, 0..1. */
  agreement: z.number().nullish(),
  /** Plain-language caveat shown to the reviewer alongside the rule. */
  note: z.string().nullish(),
  /** The raw measurements, so a reviewer can check the arithmetic. */
  observed: z.array(z.record(z.unknown())).nullish(),
});

export const RuleDefinition = z.object({
  id: z.string().uuid().nullish(),
  key: z.string().min(1),
  version: z.number().int().default(1),
  statement: z.string().min(1),
  rationale: z.string().nullish(),
  dimension: RuleDimension,
  tier: CheckTier,
  severity: Severity.default('major'),
  weight: z.number().default(1),
  scope: ScopeSelector.default({}),
  check: RuleCheckSpec,
  rubric: RubricSpec.nullish(),
  provenance: RuleProvenance.default('manual'),
  citation: RuleCitation.nullish(),
  support: RuleSupport.nullish(),
  status: RuleStatus.default('proposed'),
});
export type RuleDefinition = z.infer<typeof RuleDefinition>;

/* --------------------------------------------------------------------------
 * Findings & traces
 * ------------------------------------------------------------------------ */
/**
 * Evidence is produced by the Python engine, so every optional field is
 * `.nullish()` rather than `.optional()`.
 *
 * This is not pedantry. Pydantic serialises an unset `Optional[str]` as an
 * explicit `null`; zod's `.optional()` means "key absent" and rejects null.
 * Using `.optional()` on this boundary makes a perfectly good analysis result
 * fail validation because one field happened to be unset, and the failure
 * surfaces as a 500 from the API rather than as the schema mismatch it is.
 * Rule for this codebase: wherever the engine is the producer, optional means
 * nullish.
 */
export const Evidence = z.object({
  /** What we measured. Code measures; the model only judges. */
  measured: z.record(z.unknown()).nullish(),
  threshold: z.record(z.unknown()).nullish(),
  bbox: BBox.nullish(),
  cropKey: z.string().nullish(),
  quotedText: z.string().nullish(),
  observation: z.string().nullish(),
});
export type Evidence = z.infer<typeof Evidence>;

export const DecisionTraceDTO = z.object({
  id: z.string().uuid(),
  traceKey: z.string(),
  ruleKey: z.string(),
  ruleVersion: z.number().int(),
  dimension: RuleDimension,
  tier: CheckTier,
  verdict: Verdict,
  severity: Severity,
  confidence: z.number().nullable(),
  evidence: Evidence,
  // Nullish throughout: this object is stored verbatim from the engine and
  // read straight back out, so it carries the engine's nulls with it.
  model: z
    .object({
      provider: z.string().nullish(),
      id: z.string().nullish(),
      version: z.string().nullish(),
      promptHash: z.string().nullish(),
      temperature: z.number().nullish(),
      selfConsistencyK: z.number().nullish(),
      voteEntropy: z.number().nullish(),
    })
    .nullish(),
  citation: z.record(z.unknown()).nullable().optional(),
  precedentAssetIds: z.array(z.string().uuid()).nullable().optional(),
  suggestedFix: z.string().nullable().optional(),
  cached: z.boolean(),
  costUsd: z.number(),
  latencyMs: z.number().nullable().optional(),
  createdAt: z.string(),
});
export type DecisionTraceDTO = z.infer<typeof DecisionTraceDTO>;

export const FindingDTO = z.object({
  id: z.string().uuid(),
  traceId: z.string().uuid(),
  ruleKey: z.string(),
  dimension: RuleDimension,
  severity: Severity,
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(['open', 'confirmed', 'overridden', 'waived', 'fixed']),
  bbox: z.array(z.number()).nullable().optional(),
  cropKey: z.string().nullable().optional(),
  displayConfidence: z.number().nullable().optional(),
  isHighConfidence: z.boolean(),
  createdAt: z.string(),
});
export type FindingDTO = z.infer<typeof FindingDTO>;

/* --------------------------------------------------------------------------
 * Scoring
 *
 * The headline number is deterministic aggregation over atomic criteria.
 * A raw VLM score is never surfaced: judges rank well but score badly.
 * ------------------------------------------------------------------------ */
export const ScoreBand = z.enum(['pass', 'conditional', 'fail']);

export const CheckRunSummary = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  brandId: z.string().uuid(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'degraded']),
  score: z.number().nullable(),
  scoreBand: ScoreBand.nullable(),
  hasBlocker: z.boolean(),
  dimensionScores: z.record(z.number()),
  criteriaTotal: z.number().int(),
  criteriaEvaluated: z.number().int(),
  criteriaPassed: z.number().int(),
  criteriaFailed: z.number().int(),
  criteriaAbstained: z.number().int(),
  coverageRate: z.number().nullable(),
  rulesetHash: z.string(),
  costUsd: z.number(),
  cacheHits: z.number().int(),
  cacheMisses: z.number().int(),
  durationMs: z.number().nullable(),
  degradedReason: z.string().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type CheckRunSummary = z.infer<typeof CheckRunSummary>;

export const CheckRunDetail = CheckRunSummary.extend({
  traces: z.array(DecisionTraceDTO),
  findings: z.array(FindingDTO),
  asset: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      kind: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      previewUrl: z.string().nullable(),
    })
    .optional(),
});
export type CheckRunDetail = z.infer<typeof CheckRunDetail>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    hasMore: z.boolean(),
  });

export const ApiError = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.string())]),
  correlationId: z.string().optional(),
});
