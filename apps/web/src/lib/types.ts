import type {
  BBox,
  CheckTier,
  DecisionTraceDTO,
  FindingDTO,
  RuleDimension,
  Severity,
} from '@brandlens/contracts';

/* ==========================================================================
 * Shapes the API returns that are not (yet) zod-declared in
 * @brandlens/contracts. Kept narrow and read-only: anything that IS in
 * contracts is imported from there rather than restated.
 * ========================================================================== */

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/* --- brands -------------------------------------------------------------- */
export interface Brand {
  id: string;
  orgId: string;
  parentBrandId: string | null;
  name: string;
  slug: string;
  description: string | null;
  positioning: string | null;
  activeRulesetId: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrandOverview extends Brand {
  counts: {
    tokens: number;
    logos: number;
    typeStyles: number;
    voiceAttributes: number;
    claims: number;
    disclaimers: number;
    rulesActive: number;
    rulesProposed: number;
    assets: number;
  };
  activeRuleset: { id: string; version: number; hash: string; ruleCount: number; publishedAt: string } | null;
  recentChecks: Array<{ id: string; score: number | null; scoreBand: string | null; createdAt: string }>;
  openFindings: number;
  readiness: { hasTokens: boolean; hasLogos: boolean; hasRules: boolean; hasRuleset: boolean; percent: number };
}

/* --- rules --------------------------------------------------------------- */
export interface RuleScope {
  subBrands?: string[];
  markets?: string[];
  channels?: string[];
  assetTypes?: string[];
  campaigns?: string[];
}

export interface RuleCitation {
  doc?: string;
  documentId?: string;
  page?: number;
  bbox?: BBox;
  extractedBy?: string;
  confirmedByUserId?: string;
}

export interface RuleSupport {
  sampleSize?: number;
  percentile?: number;
  observedValue?: number;
  exampleAssetIds?: string[];
}

export interface RuleCalibration {
  thresholdOverride?: number;
  alpha?: number;
  beta?: number;
  agreementRate?: number;
  overrideRate?: number;
  sampleSize?: number;
  updatedAt?: string;
  autoRouteToHuman?: boolean;
}

export type RuleStatus = 'proposed' | 'active' | 'deprecated' | 'rejected';
export type RuleProvenance = 'deductive' | 'inductive' | 'transfer' | 'manual';

export interface Rule {
  id: string;
  orgId: string;
  brandId: string;
  key: string;
  version: number;
  statement: string;
  rationale: string | null;
  dimension: RuleDimension;
  tier: CheckTier;
  severity: Severity;
  weight: number;
  scope: RuleScope;
  specificity: number;
  check: { fn: string; params?: Record<string, unknown> };
  rubric: Record<string, unknown> | null;
  provenance: RuleProvenance;
  citation: RuleCitation | null;
  support: RuleSupport | null;
  status: RuleStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  calibration: RuleCalibration | null;
  optimizedPrompt: string | null;
  optimizedPromptHash: string | null;
  createdByUserId: string | null;
  activatedByUserId: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Ruleset {
  id: string;
  orgId: string;
  brandId: string;
  version: number;
  hash: string;
  label: string | null;
  compiled?: Record<string, unknown>;
  ruleCount: number;
  scoringConfig: Record<string, unknown>;
  publishedByUserId: string | null;
  publishedAt: string;
}

export interface BulkRuleDecisionResult {
  updated: number;
  action: string;
  ruleIds?: string[];
}

/* --- assets -------------------------------------------------------------- */
export interface Asset {
  id: string;
  brandId: string;
  campaignId: string | null;
  variantFamilyId: string | null;
  name: string;
  kind: string;
  status: string;
  contentHash: string;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  colorProfile: string | null;
  dpi: number | null;
  sourceFidelity: string;
  market: string | null;
  channel: string | null;
  assetType: string | null;
  locale: string | null;
  copyFields: Record<string, string>;
  tags: string[];
  isApprovedExemplar: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string | null;
}

export interface AssetUploadResult {
  asset: Asset;
  deduped: boolean;
  jobId: string | null;
}

export interface AssetDerivative {
  id: string;
  assetId: string;
  kind: string;
  transformHash: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  previewUrl?: string | null;
}

/* --- checks & review ----------------------------------------------------- */
export interface CreateCheckResult {
  id: string;
  status: string;
  score?: number | null;
  scoreBand?: string | null;
  [key: string]: unknown;
}

export interface FindingExplain {
  finding: FindingDTO;
  trace: RawTrace | null;
  run: { id: string; assetId: string; brandId: string; rulesetHash: string } | null;
  priorDecisions: ReviewDecision[];
}

/** decision_traces row as returned by GET /v1/checks/:id/traces. */
export interface RawTrace extends Omit<DecisionTraceDTO, 'createdAt'> {
  checkRunId: string;
  assetId: string;
  assetContentHash: string;
  rulesetHash: string;
  ruleId: string | null;
  createdAt: string;
}

export interface Review {
  id: string;
  orgId: string;
  assetId: string;
  checkRunId: string | null;
  state: 'pending' | 'in_review' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn';
  stage: string;
  assignedToUserId: string | null;
  dueAt: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDecision {
  id: string;
  orgId: string;
  reviewId: string | null;
  traceId: string | null;
  findingId: string | null;
  assetId: string;
  ruleKey: string;
  ruleVersion: number | null;
  action: 'confirm' | 'override_pass' | 'override_fail' | 'waive' | 'escalate' | 'comment';
  rationale: string | null;
  annotationBbox: number[] | null;
  reviewerUserId: string | null;
  isCalibrationLabel: boolean;
  createdAt: string;
}

export interface ReviewDetail {
  review: Review;
  asset: Asset | null;
  checkRun: {
    id: string;
    score: number | null;
    scoreBand: string | null;
    hasBlocker: boolean;
    status: string;
    dimensionScores: Record<string, number>;
    createdAt: string;
  } | null;
  findings: FindingDTO[];
  decisions: ReviewDecision[];
}

export interface DecisionResult {
  findingId: string;
  status: string;
  action: string;
  [key: string]: unknown;
}

/* --- ontology ------------------------------------------------------------ */
export interface DesignToken {
  id: string;
  brandId: string;
  path: string;
  type: string;
  value: unknown;
  description: string | null;
  hex: string | null;
  labL: number | null;
  labA: number | null;
  labB: number | null;
  role: string | null;
  allowedTints: number[] | null;
  usage: Record<string, unknown> | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogoVariant {
  id: string;
  brandId: string;
  name: string;
  kind: string;
  storageKey: string;
  contentHash: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  logomarkHeightPx: number | null;
  palette: Record<string, unknown> | null;
  constraints: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  previewUrl?: string | null;
}

export interface TypeStyle {
  id: string;
  brandId: string;
  name: string;
  role: string | null;
  fontFamily: string;
  fontAliases: string[] | null;
  fontWeight: number | null;
  isItalic: boolean;
  minSizePx: number | null;
  minSizePt: number | null;
  minSizePctOfCanvas: number | null;
  maxSizePx: number | null;
  lineHeightRatio: number | null;
  letterSpacingEm: number | null;
  casingRules: Record<string, unknown> | null;
  scaleRank: number | null;
  createdAt: string;
}

export interface VoiceAttribute {
  id: string;
  brandId: string;
  name: string;
  weAre: string | null;
  weAreNot: string | null;
  positiveExamples: string[] | null;
  negativeExamples: string[] | null;
  weight: number;
  createdAt: string;
}

export interface LexiconTerm {
  id: string;
  brandId: string;
  term: string;
  kind: string;
  replacement: string | null;
  caseSensitive: boolean;
  matchWholeWord: boolean;
  allowFuzzy: boolean;
  severity: Severity;
  marketCodes: string[] | null;
  notes: string | null;
}

export interface Claim {
  id: string;
  brandId: string;
  text: string;
  variants: string[] | null;
  category: string | null;
  substantiationRef: string | null;
  substantiationUrl: string | null;
  jurisdictions: string[] | null;
  requiredDisclaimerId: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface Disclaimer {
  id: string;
  brandId: string;
  name: string;
  text: string;
  marketCodes: string[] | null;
  channels: string[] | null;
  minFontSizePt: number | null;
  minContrastRatio: number | null;
  maxProximityPct: number | null;
  isRequired: boolean;
  severity: Severity;
  createdAt: string;
}

export interface BrandDocument {
  id: string;
  brandId: string;
  name: string;
  kind: string;
  storageKey: string;
  contentHash: string;
  mimeType: string | null;
  pageCount: number | null;
  status: string;
  extractionStats: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  page: number | null;
  kind?: string;
  text: string;
  bbox: number[] | null;
}

/* --- assemble & predict -------------------------------------------------- */
export interface Brief {
  id: string;
  orgId: string;
  brandId: string;
  campaignId: string | null;
  title: string;
  objective: string | null;
  audience: Record<string, unknown> | null;
  keyMessage: string | null;
  targets: Array<{ platform: string; placement: string; assetType: string; count: number; market?: string }>;
  mandatories: string[] | null;
  status: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssemblyPlan {
  id: string;
  briefId: string;
  rulesetHash: string;
  items: Array<Record<string, unknown>>;
  constraintsApplied: Array<Record<string, unknown>> | Record<string, unknown> | null;
  rationale: string | null;
  costUsd: number;
  createdAt: string;
}

export interface BriefDetail {
  brief: Brief;
  plans: AssemblyPlan[];
}

export interface AudiencePanel {
  id: string;
  orgId: string;
  brandId: string | null;
  name: string;
  personas: Array<Record<string, unknown>>;
  groundingStats: Record<string, unknown> | null;
  createdAt: string;
}

export interface Prediction {
  id: string;
  assetId: string;
  panelId: string | null;
  status: string;
  percentileVsCorpus: number | null;
  dimensionScores: Record<string, number> | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  panelResponses: Array<Record<string, unknown>> | null;
  comparisonAssetIds: string[] | null;
  recommendations: string[] | null;
  costUsd: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* --- platform & settings ------------------------------------------------- */
export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
  lastLoginAt: string | null;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  plan: string;
  dailyUsdLimit: number;
  settings: Record<string, unknown>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
  warning: string;
}

export interface WebhookEndpoint {
  id: string;
  orgId: string;
  url: string;
  description: string | null;
  events: string[];
  status: string;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  secretPreview: string;
}

export interface CreatedWebhook extends Omit<WebhookEndpoint, 'secretPreview'> {
  secret: string;
  warning?: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  outboxEventId: string | null;
  attempt: number;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  orgId: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ChannelSpec {
  id: string;
  orgId: string | null;
  platform: string;
  placement: string;
  assetType: string;
  version: string;
  effectiveFrom: string | null;
  spec: Record<string, unknown>;
  docsUrl: string | null;
  notes: string | null;
  isOverride: boolean;
}

/* --- analytics ----------------------------------------------------------- */
export interface CostReport {
  totalUsd: number;
  assetsAnalyzed: number;
  costPerAsset: number;
  costPerCheck: number;
  cacheHitRate: number;
  cacheSavingsUsd: number;
  byRule: Array<{ ruleKey: string; costUsd: number; evaluations: number; costPerEvaluation: number }>;
  byProvider: Array<{ provider: string; model: string; costUsd: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; checks: number }>;
}

export interface CoverageReport {
  autoClearedRate: number;
  totalCriteria: number;
  decidedCriteria: number;
  abstainedCriteria: number;
  byDimension: Array<{ dimension: string; coverage: number; evaluations: number; abstentions: number }>;
  autoRoutedRules: Array<{ ruleKey: string; beta: number | null; reason: string }>;
}
