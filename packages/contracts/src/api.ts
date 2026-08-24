import { z } from 'zod';
import { RuleDefinition, RuleDimension, ScopeSelector, Severity } from './core.js';

/* ==========================================================================
 * Public REST surface.
 *
 * Verification-as-an-API is the wedge: one endpoint that takes an asset and a
 * brand and returns structured findings with severities, measured values,
 * bounding boxes and citations. Everything else in the product exists to make
 * that endpoint good.
 * ========================================================================== */

/* --- auth ---------------------------------------------------------------- */
export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Use at least 10 characters'),
  name: z.string().min(1).optional(),
  organizationName: z.string().min(1),
});

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
});

export const SessionUser = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  orgId: z.string().uuid(),
  orgName: z.string(),
  orgSlug: z.string(),
  role: z.string(),
});

/* --- brands & ontology --------------------------------------------------- */
export const CreateBrandInput = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens only'),
  description: z.string().optional(),
  positioning: z.string().optional(),
  parentBrandId: z.string().uuid().optional(),
});

export const UpdateBrandInput = CreateBrandInput.partial().omit({ slug: true });

export const UpsertTokenInput = z.object({
  path: z.string().min(1),
  type: z.enum(['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'number', 'shadow', 'typography', 'other']),
  value: z.unknown(),
  description: z.string().optional(),
  hex: z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).optional(),
  role: z.string().optional(),
  allowedTints: z.array(z.number().int()).optional(),
  usage: z.record(z.unknown()).optional(),
});

/** W3C DTCG import — gives direct interop with Figma Variables, Style
 *  Dictionary and Tailwind configs. */
export const ImportTokensInput = z.object({
  format: z.enum(['dtcg', 'style-dictionary', 'figma-variables', 'tailwind']).default('dtcg'),
  payload: z.record(z.unknown()),
  replace: z.boolean().default(false),
});

export const CreateRuleInput = RuleDefinition.omit({ id: true, version: true }).extend({
  status: z.enum(['proposed', 'active']).default('proposed'),
});

export const UpdateRuleInput = RuleDefinition.partial().omit({ id: true, key: true });

export const BulkRuleDecisionInput = z.object({
  ruleIds: z.array(z.string().uuid()).min(1),
  action: z.enum(['activate', 'reject', 'deprecate']),
  note: z.string().optional(),
});

/* --- rule packs ---------------------------------------------------------- */

/**
 * Turning a pack on or off for one brand.
 *
 * `reason` is required to DISABLE a pack that is on by default. Switching off
 * accessibility checks is a decision somebody should have to write down, and
 * the row records who did it — a disabled baseline with no explanation is
 * indistinguishable, six months later, from one nobody ever noticed.
 */
export const SetRulePackEnabledInput = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(2000).optional(),
});

/**
 * Taking ownership of one shipped rule.
 *
 * `edits` is optional and applies in the same transaction, so "fork and change
 * the threshold" is one act with one audit entry rather than a fork followed
 * by an edit that looks unrelated.
 */
export const ForkRuleTemplateInput = z.object({
  templateId: z.string().uuid(),
  edits: z
    .object({
      statement: z.string().min(1).optional(),
      rationale: z.string().optional(),
      severity: z.enum(['blocker', 'major', 'minor', 'advisory']).optional(),
      weight: z.number().min(0).max(10).optional(),
      scope: z.record(z.unknown()).optional(),
      check: z.object({ fn: z.string(), params: z.record(z.unknown()).optional() }).optional(),
      rubric: z.record(z.unknown()).nullish(),
    })
    .optional(),
});

export const CompileRulesetInput = z.object({
  label: z.string().optional(),
  scoringConfig: z
    .object({
      dimensionWeights: z.record(z.number()).optional(),
      passThreshold: z.number().default(85),
      conditionalThreshold: z.number().default(70),
    })
    .optional(),
});

/* --- assets & checks ----------------------------------------------------- */
export const RegisterAssetInput = z.object({
  brandId: z.string().uuid(),
  name: z.string().min(1),
  kind: z.enum(['image', 'video', 'pdf', 'html', 'figma', 'pptx', 'psd', 'copy']),
  campaignId: z.string().uuid().optional(),
  variantFamilyId: z.string().uuid().optional(),
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
  locale: z.string().optional(),
  copyFields: z.record(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  isApprovedExemplar: z.boolean().optional(),
});

/**
 * The wedge endpoint. `POST /v1/checks` — asset in, structured findings out.
 * Synchronous by default because an agent in a generate→verify→fix loop
 * cannot poll; `async: true` returns immediately with a run id.
 */
export const CreateCheckInput = z.object({
  assetId: z.string().uuid().optional(),
  /** Alternative to assetId: register and check in one call. */
  asset: RegisterAssetInput.optional(),
  brandId: z.string().uuid().optional(),
  rulesetId: z.string().uuid().optional(),
  /** Restrict to specific dimensions — cheap targeted re-checks after a fix. */
  dimensions: z.array(RuleDimension).optional(),
  deterministicOnly: z.boolean().default(false),
  async: z.boolean().default(true),
  /** Bypasses the result cache. Use sparingly; it costs real money. */
  force: z.boolean().default(false),
  idempotencyKey: z.string().max(120).optional(),
});

export const ListChecksQuery = z.object({
  brandId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  status: z.string().optional(),
  scoreBand: z.enum(['pass', 'conditional', 'fail']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/* --- review -------------------------------------------------------------- */
export const ReviewDecisionInput = z.object({
  findingId: z.string().uuid().optional(),
  traceId: z.string().uuid().optional(),
  action: z.enum(['confirm', 'override_pass', 'override_fail', 'waive', 'escalate', 'comment']),
  /** Required on overrides — it is both the audit record and the natural
   *  language signal that prompt optimisation consumes. */
  rationale: z.string().optional(),
  annotationBbox: z.array(z.number()).length(4).optional(),
  isCalibrationLabel: z.boolean().default(false),
});

export const SubmitReviewInput = z.object({
  state: z.enum(['approved', 'rejected', 'changes_requested']),
  summary: z.string().optional(),
});

/* --- assemble / predict -------------------------------------------------- */
export const CreateBriefInput = z.object({
  brandId: z.string().uuid(),
  title: z.string().min(1),
  objective: z.string().optional(),
  keyMessage: z.string().optional(),
  audience: z.record(z.unknown()).optional(),
  mandatories: z.array(z.string()).optional(),
  targets: z
    .array(
      z.object({
        platform: z.string(),
        placement: z.string(),
        assetType: z.string(),
        count: z.number().int().min(1).default(1),
        market: z.string().optional(),
      }),
    )
    .default([]),
  campaignId: z.string().uuid().optional(),
});

export const CreatePredictionInput = z.object({
  assetId: z.string().uuid(),
  panelId: z.string().uuid().optional(),
  comparisonAssetIds: z.array(z.string().uuid()).max(6).optional(),
});

/* --- platform ------------------------------------------------------------ */
export const CreateApiKeyInput = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).default(['checks:write', 'checks:read', 'assets:write', 'brands:read']),
  expiresInDays: z.number().int().positive().optional(),
});

export const CreateWebhookInput = z.object({
  url: z.string().url(),
  description: z.string().optional(),
  events: z.array(z.string()).min(1),
});

export const InviteMemberInput = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'brand_manager', 'reviewer', 'creator', 'viewer']),
});

/* --- analytics ----------------------------------------------------------- */
export const AnalyticsQuery = z.object({
  brandId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});

export const RuleHealthRow = z.object({
  ruleKey: z.string(),
  statement: z.string(),
  dimension: RuleDimension,
  severity: Severity,
  tier: z.string(),
  evaluations: z.number().int(),
  failRate: z.number(),
  /** The single best product-health metric. Above 20% the rule is broken,
   *  not the customer. */
  overrideRate: z.number(),
  agreementRate: z.number().nullable(),
  beta: z.number().nullable(),
  autoRouteToHuman: z.boolean(),
  costUsd: z.number(),
});
export type RuleHealthRow = z.infer<typeof RuleHealthRow>;

export const DashboardSummary = z.object({
  checksRun: z.number().int(),
  assetsAnalyzed: z.number().int(),
  passRate: z.number(),
  blockerRate: z.number(),
  avgScore: z.number().nullable(),
  /** Headline customer-facing number: share auto-cleared without a human. */
  autoClearedRate: z.number(),
  cacheHitRate: z.number(),
  costUsd: z.number(),
  costPerAsset: z.number(),
  openFindings: z.number().int(),
  pendingReviews: z.number().int(),
  topFailingRules: z.array(z.object({ ruleKey: z.string(), statement: z.string(), count: z.number().int() })),
  scoreTrend: z.array(z.object({ date: z.string(), avgScore: z.number(), checks: z.number().int() })),
  dimensionBreakdown: z.array(z.object({ dimension: z.string(), passRate: z.number(), evaluations: z.number().int() })),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

export const ScopeQuery = ScopeSelector.extend({
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
});
