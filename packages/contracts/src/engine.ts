import { z } from 'zod';
import { BBox, CheckTier, Evidence, RuleDefinition, RuleDimension, Severity, Verdict } from './core.js';

/* ==========================================================================
 * API ⇄ Analysis-engine protocol.
 *
 * The TypeScript control plane owns orchestration, tenancy, persistence and
 * the audit trail. The Python engine owns measurement and judgment. This is
 * the only surface between them, and it is deliberately stateless: every
 * request carries everything the engine needs, so the engine can be scaled,
 * restarted or moved onto a GPU box without coordination.
 * ========================================================================== */

export const EngineAssetRef = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video', 'pdf', 'html', 'figma', 'pptx', 'psd', 'copy']),
  /** Local path (single-VM deployment) or a presigned URL. */
  uri: z.string(),
  mimeType: z.string().optional(),
  contentHash: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  dpi: z.number().optional(),
  colorProfile: z.string().optional(),
  /** Parsed structure when available. Structured beats pixels every time. */
  structuredSource: z.record(z.unknown()).optional(),
  copyFields: z.record(z.string()).default({}),
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
  locale: z.string().optional(),
});
export type EngineAssetRef = z.infer<typeof EngineAssetRef>;

/** The tenant's ontology, flattened into exactly what the analyzers need. */
export const EngineBrandContext = z.object({
  brandId: z.string(),
  name: z.string(),
  positioning: z.string().optional(),
  colorTokens: z.array(
    z.object({
      path: z.string(),
      hex: z.string(),
      lab: z.tuple([z.number(), z.number(), z.number()]).optional(),
      role: z.string().optional(),
      allowedTints: z.array(z.number()).optional(),
      usage: z.record(z.unknown()).default({}),
    }),
  ),
  forbiddenColors: z.array(z.object({ hex: z.string(), reason: z.string().optional() })).default([]),
  logoVariants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      uri: z.string(),
      aspectRatio: z.number().nullable().optional(),
      logomarkHeightPx: z.number().nullable().optional(),
      palette: z.array(z.string()).default([]),
      constraints: z.record(z.unknown()).default({}),
    }),
  ),
  typeStyles: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      fontFamily: z.string(),
      fontAliases: z.array(z.string()).default([]),
      /**
       * Null when the ontology never measured it. The engine must not enforce
       * a weight it was never shown — `typography.py` already skips the weight
       * comparison when this is absent, which is the correct behaviour and the
       * reason absence has to be expressible here at all.
       */
      fontWeight: z.number().nullable(),
      minSizePx: z.number().nullable().optional(),
      minSizePt: z.number().nullable().optional(),
      minSizePctOfCanvas: z.number().nullable().optional(),
      lineHeightRatio: z.number().nullable().optional(),
      scaleRank: z.number().nullable().optional(),
      casingRules: z.record(z.unknown()).default({}),
    }),
  ),
  forbiddenFonts: z.array(z.object({ fontFamily: z.string(), reason: z.string().optional() })).default([]),
  voiceAttributes: z.array(
    z.object({
      name: z.string(),
      weAre: z.string(),
      weAreNot: z.string(),
      positiveExamples: z.array(z.string()).default([]),
      negativeExamples: z.array(z.string()).default([]),
      weight: z.number().default(1),
    }),
  ),
  lexicon: z.array(
    z.object({
      term: z.string(),
      kind: z.enum(['banned', 'required', 'preferred', 'trademark']),
      replacement: z.string().nullable().optional(),
      caseSensitive: z.boolean().default(false),
      matchWholeWord: z.boolean().default(true),
      allowFuzzy: z.boolean().default(true),
      severity: Severity.default('minor'),
      marketCodes: z.array(z.string()).nullable().optional(),
    }),
  ),
  claims: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      variants: z.array(z.string()).default([]),
      category: z.string().nullable().optional(),
      jurisdictions: z.array(z.string()).default([]),
      expiresAt: z.string().nullable().optional(),
      requiredDisclaimerId: z.string().nullable().optional(),
      isActive: z.boolean().default(true),
    }),
  ),
  disclaimers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      text: z.string(),
      marketCodes: z.array(z.string()).nullable().optional(),
      channels: z.array(z.string()).nullable().optional(),
      minFontSizePt: z.number().nullable().optional(),
      minContrastRatio: z.number().nullable().optional(),
      maxProximityPct: z.number().nullable().optional(),
      severity: Severity.default('blocker'),
    }),
  ),
  imageStyleProfile: z
    .object({
      featureStats: z.record(z.unknown()),
      centroid: z.array(z.number()).nullable().optional(),
      distanceP5: z.number().nullable().optional(),
      distanceP50: z.number().nullable().optional(),
      allowedMediums: z.array(z.string()).nullable().optional(),
      prohibitedSubjects: z.array(z.string()).nullable().optional(),
    })
    .nullable()
    .optional(),
  channelSpec: z.record(z.unknown()).nullable().optional(),
});
export type EngineBrandContext = z.infer<typeof EngineBrandContext>;

/**
 * Precedents are injected as few-shot context. They MUST arrive balanced —
 * roughly half pass, half fail — or the label prior leaks and the judge
 * degenerates into a yes-machine.
 */
export const EnginePrecedent = z.object({
  assetId: z.string(),
  ruleKey: z.string(),
  verdict: Verdict,
  rationale: z.string().nullable().optional(),
  measured: z.record(z.unknown()).nullable().optional(),
  cropUri: z.string().nullable().optional(),
  similarity: z.number().optional(),
});

export const EngineJudgeConfig = z.object({
  provider: z.string(),
  model: z.string(),
  temperature: z.number().default(0),
  /** k>1 enables self-consistency voting; vote entropy becomes free confidence. */
  selfConsistencyK: z.number().int().default(1),
  escalateK: z.number().int().default(3),
  abstainBelowConfidence: z.number().default(0.55),
  maxImageEdge: z.number().int().default(1568),
  enablePromptCache: z.boolean().default(true),
  /** Hard ceiling for one run. On breach we degrade to deterministic-only
   *  results rather than failing — a partial answer beats an error. */
  costCeilingUsd: z.number().default(2.5),
});

export const AnalyzeRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  asset: EngineAssetRef,
  brand: EngineBrandContext,
  rules: z.array(RuleDefinition),
  precedents: z.array(EnginePrecedent).default([]),
  judge: EngineJudgeConfig,
  /** Analyzer results already cached by the control plane; the engine skips
   *  recomputing these. Measurement is a pure function of the bytes. */
  cachedMeasurements: z.record(z.unknown()).default({}),
  /** Skip T2 entirely — used by the budget guard and the bulk audit path. */
  deterministicOnly: z.boolean().default(false),
  pipelineVersion: z.string().default('1.0.0'),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequest>;

export const EngineCriterionResult = z.object({
  ruleKey: z.string(),
  ruleVersion: z.number().int(),
  dimension: RuleDimension,
  tier: CheckTier,
  verdict: Verdict,
  severity: Severity,
  confidence: z.number().nullable(),
  evidence: Evidence,
  suggestedFix: z.string().nullish(),
  model: z
    .object({
      provider: z.string().nullish(),
      id: z.string().nullish(),
      promptHash: z.string().nullish(),
      temperature: z.number().nullish(),
      selfConsistencyK: z.number().nullish(),
      voteEntropy: z.number().nullish(),
    })
    .nullable()
    .nullish(),
  costUsd: z.number().default(0),
  latencyMs: z.number().nullish(),
  cached: z.boolean().default(false),
  error: z.string().nullish(),
});
export type EngineCriterionResult = z.infer<typeof EngineCriterionResult>;

export const AnalyzeResponse = z.object({
  requestId: z.string(),
  results: z.array(EngineCriterionResult),
  /** Reusable measurements the control plane should persist and replay. */
  measurements: z.record(z.unknown()).default({}),
  /** Evidence crops/overlays the engine wrote, for the UI to render. */
  artifacts: z
    .array(z.object({ key: z.string(), kind: z.string(), uri: z.string(), meta: z.record(z.unknown()).default({}) }))
    .default([]),
  costUsd: z.number().default(0),
  durationMs: z.number(),
  degraded: z.boolean().default(false),
  degradedReason: z.string().nullish(),
  engineVersion: z.string(),
  warnings: z.array(z.string()).default([]),
});
export type AnalyzeResponse = z.infer<typeof AnalyzeResponse>;

/* --------------------------------------------------------------------------
 * Brand-book ingestion → proposed rules
 * ------------------------------------------------------------------------ */
export const ExtractRulesRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  brandId: z.string(),
  documentUri: z.string(),
  documentName: z.string(),
  mimeType: z.string().optional(),
  maxPages: z.number().int().default(120),
  provider: z.string(),
  model: z.string(),
});

export const ExtractRulesResponse = z.object({
  requestId: z.string(),
  /** Always `status: proposed`. Activation is the customer's act — that is
   *  what makes the audit trail defensible, and it is the onboarding moment
   *  that sells the product. */
  rules: z.array(RuleDefinition),
  tokens: z
    .array(z.object({ path: z.string(), type: z.string(), value: z.unknown(), hex: z.string().nullish() }))
    .default([]),
  voiceAttributes: z
    .array(z.object({ name: z.string(), weAre: z.string(), weAreNot: z.string() }))
    .default([]),
  chunks: z
    .array(
      z.object({
        page: z.number().int(),
        ordinal: z.number().int(),
        heading: z.string().nullish(),
        text: z.string(),
        bbox: z.array(z.number()).nullish(),
      }),
    )
    .default([]),
  pageCount: z.number().int(),
  costUsd: z.number().default(0),
  warnings: z.array(z.string()).default([]),
});

/* --------------------------------------------------------------------------
 * Rule induction — measuring the approved corpus to find the rules the team
 * actually enforces, as opposed to the ones they wrote down.
 * ------------------------------------------------------------------------ */
export const InduceRulesRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  brandId: z.string(),
  assets: z.array(EngineAssetRef),
  brand: EngineBrandContext,
  /** Percentile used as the proposed threshold, e.g. p5 for minima. */
  percentile: z.number().default(5),
  minSupport: z.number().int().default(20),
});

export const InduceRulesResponse = z.object({
  requestId: z.string(),
  rules: z.array(RuleDefinition),
  styleProfile: z.record(z.unknown()).nullish(),
  measuredCount: z.number().int(),
  warnings: z.array(z.string()).default([]),
});

/* --------------------------------------------------------------------------
 * Copy intelligence — voice, lexicon, claims and disclaimers from site copy
 *
 * Engine-produced, so every optional field is `.nullish()` rather than
 * `.optional()`. Pydantic serialises an unset Optional as an explicit null,
 * and `.optional()` would reject a perfectly good analysis. See ADR 0011.
 * ------------------------------------------------------------------------ */
export const CopyPageInput = z.object({
  url: z.string(),
  role: z.string().default('other'),
  title: z.string().nullish(),
  text: z.string().default(''),
});

export const AnalyzeCopyRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  brandId: z.string().nullish(),
  brandName: z.string().nullish(),
  originUrl: z.string().nullish(),
  pages: z.array(CopyPageInput),
  provider: z.string(),
  model: z.string(),
  maxChars: z.number().int().optional(),
});
export type AnalyzeCopyRequest = z.infer<typeof AnalyzeCopyRequest>;

export const DiscoveredVoiceAxisWire = z.object({
  name: z.string(),
  lowLabel: z.string(),
  highLabel: z.string(),
  value: z.number(),
  rationale: z.string().nullish(),
  evidence: z.array(z.string()).default([]),
});

export const DiscoveredLexiconTermWire = z.object({
  term: z.string(),
  kind: z.string().default('preferred'),
  note: z.string().nullish(),
  uses: z.number().int().default(0),
  pageCount: z.number().int().default(0),
});

export const DiscoveredClaimWire = z.object({
  text: z.string(),
  url: z.string(),
  triggers: z.array(z.string()).default([]),
  claimType: z.string().default('other'),
  needsSubstantiation: z.boolean().default(true),
  suggestedEvidence: z.string().nullish(),
  judged: z.boolean().default(false),
});

export const DiscoveredDisclaimerWire = z.object({
  text: z.string(),
  url: z.string(),
  triggerCondition: z.string().nullish(),
});

export const ReadabilityProfileWire = z.object({
  metrics: z.record(z.number()).default({}),
  degraded: z.boolean().default(false),
  stats: z.record(z.number()).default({}),
});

export const AnalyzeCopyResponse = z.object({
  requestId: z.string(),
  voiceAxes: z.array(DiscoveredVoiceAxisWire).default([]),
  lexicon: z.array(DiscoveredLexiconTermWire).default([]),
  claims: z.array(DiscoveredClaimWire).default([]),
  disclaimers: z.array(DiscoveredDisclaimerWire).default([]),
  readability: ReadabilityProfileWire.default({ metrics: {}, degraded: false, stats: {} }),
  costUsd: z.number().default(0),
  warnings: z.array(z.string()).default([]),
});
export type AnalyzeCopyResponse = z.infer<typeof AnalyzeCopyResponse>;

/* --------------------------------------------------------------------------
 * Assemble & Predict
 * ------------------------------------------------------------------------ */
export const AssembleRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  brand: EngineBrandContext,
  brief: z.object({
    title: z.string(),
    objective: z.string().nullable().optional(),
    keyMessage: z.string().nullable().optional(),
    audience: z.record(z.unknown()).default({}),
    mandatories: z.array(z.string()).default([]),
    targets: z.array(z.record(z.unknown())).default([]),
  }),
  candidateAssets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      uri: z.string().nullable().optional(),
      tags: z.array(z.string()).default([]),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      score: z.number().nullable().optional(),
    }),
  ),
  rules: z.array(RuleDefinition),
  provider: z.string(),
  model: z.string(),
});

export const AssembleResponse = z.object({
  requestId: z.string(),
  items: z.array(z.record(z.unknown())),
  constraintsApplied: z.record(z.unknown()).default({}),
  rationale: z.string(),
  costUsd: z.number().default(0),
});

export const PredictRequest = z.object({
  requestId: z.string(),
  orgId: z.string(),
  asset: EngineAssetRef,
  brand: EngineBrandContext,
  personas: z.array(z.record(z.unknown())),
  /** Ranking beats scoring, so we always predict relative to real reference
   *  assets from the tenant's own corpus. */
  comparisonAssets: z
    .array(z.object({ id: z.string(), uri: z.string(), label: z.string().optional() }))
    .default([]),
  provider: z.string(),
  model: z.string(),
});

export const PredictResponse = z.object({
  requestId: z.string(),
  percentileVsCorpus: z.number().nullable(),
  dimensionScores: z.record(z.number()),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  panelResponses: z.array(z.record(z.unknown())),
  recommendations: z.array(z.record(z.unknown())),
  costUsd: z.number().default(0),
});

/**
 * Note the `.nullish()` on every optional field.
 *
 * This is a real cross-language boundary: Pydantic serialises `Optional[str]`
 * as an explicit `null`, whereas zod's `.nullish()` means "key absent" and
 * rejects null outright. Using `.nullish()` here makes the engine's health
 * response fail validation for a field nobody set — and the API then reports
 * a perfectly healthy engine as unreachable. Anywhere the Python engine is the
 * producer, optional means nullish.
 */
export const EngineHealth = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  engineVersion: z.string(),
  analyzers: z.record(
    z.object({ available: z.boolean(), version: z.string(), note: z.string().nullish() }),
  ),
  providers: z.record(z.object({ configured: z.boolean(), model: z.string().nullish() })),
  ocrDriver: z.string(),
  warnings: z.array(z.string()).default([]),
});
