"""Wire models — a 1:1 mirror of `packages/contracts/src/{core,engine}.ts`.

The contract is camelCase because it is authored in TypeScript. Rather than
translate at every boundary we declare camelCase aliases and let Python code use
idiomatic snake_case; `populate_by_name=True` means both spellings parse, and
`by_alias=True` on dump guarantees the control plane sees exactly the shape zod
expects.

Deliberate deviation: fields typed `z.string().uuid()` are modelled as `str`.
The engine is not the validation authority for tenant identifiers, and a strict
UUID type would turn a harmless id-format difference into a 422 on a request
whose measurement work is perfectly well defined.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# core.ts vocabulary
# ---------------------------------------------------------------------------
Severity = Literal["blocker", "major", "minor", "advisory"]
CheckTier = Literal["deterministic", "cv", "vlm", "hybrid"]
RuleDimension = Literal[
    "logo",
    "color",
    "typography",
    "layout",
    "imagery",
    "copy",
    "accessibility",
    "channel_spec",
    "legal",
]
Verdict = Literal["pass", "fail", "not_applicable", "insufficient_evidence", "abstained"]
RuleStatus = Literal["proposed", "active", "deprecated", "rejected"]
RuleProvenance = Literal["deductive", "inductive", "transfer", "manual"]
AssetKind = Literal["image", "video", "pdf", "html", "figma", "pptx", "psd", "copy"]
RubricKind = Literal["binary", "ordinal", "nominal"]
CropTo = Literal["full", "logo", "text", "region"]
LexiconKind = Literal["banned", "required", "preferred", "trademark"]

#: Normalized to [0,1] against the canvas, origin top-left: (x0, y0, x1, y1).
BBox = tuple[float, float, float, float]

SEVERITY_ORDER: dict[str, int] = {"advisory": 0, "minor": 1, "major": 2, "blocker": 3}


class Wire(BaseModel):
    """Base for every model that crosses the API boundary."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
        ser_json_inf_nan="null",
    )


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
class ScopeSelector(Wire):
    sub_brands: list[str] | None = None
    markets: list[str] | None = None
    channels: list[str] | None = None
    asset_types: list[str] | None = None
    campaigns: list[str] | None = None


class RuleCheckSpec(Wire):
    fn: str
    params: dict[str, Any] = Field(default_factory=dict)


class RubricLevel(Wire):
    value: float
    label: str
    anchor: str


class RubricSpec(Wire):
    kind: RubricKind = "binary"
    question: str
    levels: list[RubricLevel] | None = None
    pass_when: str | None = None
    fail_when: str | None = None
    use_precedents: bool = True
    crop_to: CropTo = "full"


class RuleCitation(Wire):
    doc: str | None = None
    document_id: str | None = None
    page: int | None = None
    bbox: BBox | None = None
    extracted_by: str | None = None
    confirmed_by_user_id: str | None = None


class RuleSupport(Wire):
    sample_size: int | None = None
    percentile: float | None = None
    observed_value: float | None = None
    example_asset_ids: list[str] | None = None


class RuleDefinition(Wire):
    id: str | None = None
    key: str = Field(min_length=1)
    version: int = 1
    statement: str = Field(min_length=1)
    rationale: str | None = None
    dimension: RuleDimension
    tier: CheckTier
    severity: Severity = "major"
    weight: float = 1.0
    scope: ScopeSelector = Field(default_factory=ScopeSelector)
    check: RuleCheckSpec
    rubric: RubricSpec | None = None
    provenance: RuleProvenance = "manual"
    citation: RuleCitation | None = None
    support: RuleSupport | None = None
    status: RuleStatus = "proposed"


class Evidence(Wire):
    """What we measured. Code measures; the model only judges."""

    measured: dict[str, Any] | None = None
    threshold: dict[str, Any] | None = None
    bbox: BBox | None = None
    crop_key: str | None = None
    quoted_text: str | None = None
    observation: str | None = None


# ---------------------------------------------------------------------------
# engine.ts — request side
# ---------------------------------------------------------------------------
class EngineAssetRef(Wire):
    id: str
    kind: AssetKind
    uri: str
    mime_type: str | None = None
    content_hash: str
    width: float | None = None
    height: float | None = None
    dpi: float | None = None
    color_profile: str | None = None
    structured_source: dict[str, Any] | None = None
    copy_fields: dict[str, str] = Field(default_factory=dict)
    market: str | None = None
    channel: str | None = None
    asset_type: str | None = None
    locale: str | None = None


class ColorToken(Wire):
    path: str
    hex: str
    lab: tuple[float, float, float] | None = None
    role: str | None = None
    allowed_tints: list[float] | None = None
    usage: dict[str, Any] = Field(default_factory=dict)


class ForbiddenColor(Wire):
    hex: str
    reason: str | None = None


class LogoVariant(Wire):
    id: str
    name: str
    kind: str
    uri: str
    aspect_ratio: float | None = None
    logomark_height_px: float | None = None
    palette: list[str] = Field(default_factory=list)
    constraints: dict[str, Any] = Field(default_factory=dict)


class TypeStyle(Wire):
    name: str
    role: str
    font_family: str
    font_aliases: list[str] = Field(default_factory=list)
    # None when the ontology never measured it (a static crawl of a site that
    # refuses browsers). Consumers must skip the weight check rather than
    # substitute 400 -- see typography.py, which already does.
    font_weight: float | None = None
    min_size_px: float | None = None
    min_size_pt: float | None = None
    min_size_pct_of_canvas: float | None = None
    line_height_ratio: float | None = None
    scale_rank: float | None = None
    casing_rules: dict[str, Any] = Field(default_factory=dict)


class ForbiddenFont(Wire):
    font_family: str
    reason: str | None = None


class VoiceAttribute(Wire):
    name: str
    we_are: str
    we_are_not: str
    positive_examples: list[str] = Field(default_factory=list)
    negative_examples: list[str] = Field(default_factory=list)
    weight: float = 1.0


class LexiconEntry(Wire):
    term: str
    kind: LexiconKind
    replacement: str | None = None
    case_sensitive: bool = False
    match_whole_word: bool = True
    allow_fuzzy: bool = True
    severity: Severity = "minor"
    market_codes: list[str] | None = None


class ClaimEntry(Wire):
    id: str
    text: str
    variants: list[str] = Field(default_factory=list)
    category: str | None = None
    jurisdictions: list[str] = Field(default_factory=list)
    expires_at: str | None = None
    required_disclaimer_id: str | None = None
    is_active: bool = True


class DisclaimerEntry(Wire):
    id: str
    name: str
    text: str
    market_codes: list[str] | None = None
    channels: list[str] | None = None
    min_font_size_pt: float | None = None
    min_contrast_ratio: float | None = None
    max_proximity_pct: float | None = None
    severity: Severity = "blocker"


class ImageStyleProfile(Wire):
    feature_stats: dict[str, Any] = Field(default_factory=dict)
    centroid: list[float] | None = None
    distance_p5: float | None = None
    distance_p50: float | None = None
    allowed_mediums: list[str] | None = None
    prohibited_subjects: list[str] | None = None


class EngineBrandContext(Wire):
    brand_id: str
    name: str
    positioning: str | None = None
    color_tokens: list[ColorToken] = Field(default_factory=list)
    forbidden_colors: list[ForbiddenColor] = Field(default_factory=list)
    logo_variants: list[LogoVariant] = Field(default_factory=list)
    type_styles: list[TypeStyle] = Field(default_factory=list)
    forbidden_fonts: list[ForbiddenFont] = Field(default_factory=list)
    voice_attributes: list[VoiceAttribute] = Field(default_factory=list)
    lexicon: list[LexiconEntry] = Field(default_factory=list)
    claims: list[ClaimEntry] = Field(default_factory=list)
    disclaimers: list[DisclaimerEntry] = Field(default_factory=list)
    image_style_profile: ImageStyleProfile | None = None
    channel_spec: dict[str, Any] | None = None


class EnginePrecedent(Wire):
    asset_id: str
    rule_key: str
    verdict: Verdict
    rationale: str | None = None
    measured: dict[str, Any] | None = None
    crop_uri: str | None = None
    similarity: float | None = None


class EngineJudgeConfig(Wire):
    provider: str
    model: str
    temperature: float = 0.0
    self_consistency_k: int = 1
    escalate_k: int = 3
    abstain_below_confidence: float = 0.55
    max_image_edge: int = 1568
    enable_prompt_cache: bool = True
    cost_ceiling_usd: float = 2.5


class AnalyzeRequest(Wire):
    request_id: str
    org_id: str
    asset: EngineAssetRef
    brand: EngineBrandContext
    rules: list[RuleDefinition] = Field(default_factory=list)
    precedents: list[EnginePrecedent] = Field(default_factory=list)
    judge: EngineJudgeConfig
    cached_measurements: dict[str, Any] = Field(default_factory=dict)
    deterministic_only: bool = False
    pipeline_version: str = "1.0.0"


# ---------------------------------------------------------------------------
# engine.ts — response side
# ---------------------------------------------------------------------------
class ModelTrace(Wire):
    provider: str | None = None
    id: str | None = None
    prompt_hash: str | None = None
    temperature: float | None = None
    self_consistency_k: int | None = None
    vote_entropy: float | None = None


class CriterionResult(Wire):
    """`EngineCriterionResult` in the contract; the analyzer return type."""

    rule_key: str
    rule_version: int
    dimension: RuleDimension
    tier: CheckTier
    verdict: Verdict
    severity: Severity
    confidence: float | None = None
    evidence: Evidence = Field(default_factory=Evidence)
    suggested_fix: str | None = None
    model: ModelTrace | None = None
    cost_usd: float = 0.0
    latency_ms: float | None = None
    cached: bool = False
    error: str | None = None


def build_result(
    rule: RuleDefinition,
    verdict: Verdict,
    *,
    measured: dict[str, Any] | None = None,
    threshold: dict[str, Any] | None = None,
    observation: str | None = None,
    bbox: BBox | None = None,
    quoted_text: str | None = None,
    crop_key: str | None = None,
    confidence: float | None = None,
    suggested_fix: str | None = None,
    severity: Severity | None = None,
    tier: CheckTier | None = None,
    model: ModelTrace | None = None,
    cost_usd: float = 0.0,
    latency_ms: float | None = None,
    cached: bool = False,
    error: str | None = None,
) -> CriterionResult:
    """Assemble a `CriterionResult` from its rule.

    Every analyzer funnels through here so that `dimension`, `tier`, `severity`
    and `ruleVersion` are always copied from the rule rather than re-typed —
    a mismatch there silently mis-buckets a finding in the control plane's
    dimension scores.
    """
    return CriterionResult(
        rule_key=rule.key,
        rule_version=rule.version,
        dimension=rule.dimension,
        tier=tier or rule.tier,
        verdict=verdict,
        severity=severity or rule.severity,
        confidence=confidence,
        evidence=Evidence(
            measured=measured,
            threshold=threshold,
            bbox=bbox,
            crop_key=crop_key,
            quoted_text=quoted_text,
            observation=observation,
        ),
        suggested_fix=suggested_fix,
        model=model,
        cost_usd=cost_usd,
        latency_ms=latency_ms,
        cached=cached,
        error=error,
    )


class EngineArtifact(Wire):
    key: str
    kind: str
    uri: str
    meta: dict[str, Any] = Field(default_factory=dict)


class AnalyzeResponse(Wire):
    request_id: str
    results: list[CriterionResult] = Field(default_factory=list)
    measurements: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[EngineArtifact] = Field(default_factory=list)
    cost_usd: float = 0.0
    duration_ms: float
    degraded: bool = False
    degraded_reason: str | None = None
    engine_version: str
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Brand-book ingestion
# ---------------------------------------------------------------------------
class ExtractRulesRequest(Wire):
    request_id: str
    org_id: str
    brand_id: str
    document_uri: str
    document_name: str
    mime_type: str | None = None
    max_pages: int = 120
    provider: str
    model: str


class ExtractedToken(Wire):
    path: str
    type: str
    value: Any = None
    hex: str | None = None


class ExtractedVoiceAttribute(Wire):
    name: str
    we_are: str
    we_are_not: str


class DocumentChunk(Wire):
    page: int
    ordinal: int
    heading: str | None = None
    text: str
    bbox: list[float] | None = None


class ExtractRulesResponse(Wire):
    request_id: str
    rules: list[RuleDefinition] = Field(default_factory=list)
    tokens: list[ExtractedToken] = Field(default_factory=list)
    voice_attributes: list[ExtractedVoiceAttribute] = Field(default_factory=list)
    chunks: list[DocumentChunk] = Field(default_factory=list)
    page_count: int = 0
    cost_usd: float = 0.0
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Copy intelligence — voice, lexicon, claims and disclaimers from site copy
# ---------------------------------------------------------------------------
class CopyPageInput(Wire):
    url: str
    role: str = "other"
    title: str | None = None
    text: str = ""


class AnalyzeCopyRequest(Wire):
    request_id: str
    org_id: str
    brand_id: str | None = None
    brand_name: str | None = None
    origin_url: str | None = None
    pages: list[CopyPageInput] = Field(default_factory=list)
    provider: str
    model: str
    #: Corpus sent to the model. Trimmed rather than summarised — a voice read
    #: from a summary is the summariser's voice, not the brand's.
    max_chars: int = 60_000


class DiscoveredVoiceAxis(Wire):
    name: str
    low_label: str
    high_label: str
    #: 0.0 = fully lowLabel, 1.0 = fully highLabel.
    value: float
    rationale: str | None = None
    #: Verbatim sentences from the brand's copy. An axis with no verifiable
    #: evidence is discarded before it reaches this model.
    evidence: list[str] = Field(default_factory=list)


class DiscoveredLexiconTerm(Wire):
    term: str
    kind: str = "preferred"  # preferred|required|banned|avoid
    note: str | None = None
    uses: int = 0
    page_count: int = 0


class DiscoveredClaim(Wire):
    text: str
    url: str
    triggers: list[str] = Field(default_factory=list)
    claim_type: str = "other"
    needs_substantiation: bool = True
    suggested_evidence: str | None = None
    #: False when the model never reached this candidate. Such a claim keeps
    #: needsSubstantiation=True, because an unanswered question about
    #: regulated copy resolves to "a human should look".
    judged: bool = False


class DiscoveredDisclaimer(Wire):
    text: str
    url: str
    trigger_condition: str | None = None


class ReadabilityProfile(Wire):
    metrics: dict[str, float] = Field(default_factory=dict)
    degraded: bool = False
    stats: dict[str, float] = Field(default_factory=dict)


class AnalyzeCopyResponse(Wire):
    request_id: str
    voice_axes: list[DiscoveredVoiceAxis] = Field(default_factory=list)
    lexicon: list[DiscoveredLexiconTerm] = Field(default_factory=list)
    claims: list[DiscoveredClaim] = Field(default_factory=list)
    disclaimers: list[DiscoveredDisclaimer] = Field(default_factory=list)
    readability: ReadabilityProfile = Field(default_factory=ReadabilityProfile)
    cost_usd: float = 0.0
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Rule induction
# ---------------------------------------------------------------------------
class InduceRulesRequest(Wire):
    request_id: str
    org_id: str
    brand_id: str
    assets: list[EngineAssetRef] = Field(default_factory=list)
    brand: EngineBrandContext
    percentile: float = 5.0
    min_support: int = 20


class InduceRulesResponse(Wire):
    request_id: str
    rules: list[RuleDefinition] = Field(default_factory=list)
    style_profile: dict[str, Any] | None = None
    measured_count: int = 0
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Assemble & Predict
# ---------------------------------------------------------------------------
class AssembleBrief(Wire):
    title: str
    objective: str | None = None
    key_message: str | None = None
    audience: dict[str, Any] = Field(default_factory=dict)
    mandatories: list[str] = Field(default_factory=list)
    targets: list[dict[str, Any]] = Field(default_factory=list)


class AssembleCandidate(Wire):
    id: str
    name: str
    uri: str | None = None
    tags: list[str] = Field(default_factory=list)
    width: float | None = None
    height: float | None = None
    score: float | None = None


class AssembleRequest(Wire):
    request_id: str
    org_id: str
    brand: EngineBrandContext
    brief: AssembleBrief
    candidate_assets: list[AssembleCandidate] = Field(default_factory=list)
    rules: list[RuleDefinition] = Field(default_factory=list)
    provider: str
    model: str


class AssembleResponse(Wire):
    request_id: str
    items: list[dict[str, Any]] = Field(default_factory=list)
    constraints_applied: dict[str, Any] = Field(default_factory=dict)
    rationale: str = ""
    cost_usd: float = 0.0


class ComparisonAsset(Wire):
    id: str
    uri: str
    label: str | None = None


class PredictRequest(Wire):
    request_id: str
    org_id: str
    asset: EngineAssetRef
    brand: EngineBrandContext
    personas: list[dict[str, Any]] = Field(default_factory=list)
    comparison_assets: list[ComparisonAsset] = Field(default_factory=list)
    provider: str
    model: str


class PredictResponse(Wire):
    request_id: str
    percentile_vs_corpus: float | None = None
    dimension_scores: dict[str, float] = Field(default_factory=dict)
    interval_low: float | None = None
    interval_high: float | None = None
    panel_responses: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[dict[str, Any]] = Field(default_factory=list)
    cost_usd: float = 0.0


# ---------------------------------------------------------------------------
# Health / misc
# ---------------------------------------------------------------------------
class AnalyzerHealth(Wire):
    available: bool
    version: str
    note: str | None = None


class ProviderHealth(Wire):
    configured: bool
    model: str | None = None


class EngineHealth(Wire):
    status: Literal["ok", "degraded", "error"]
    engine_version: str
    analyzers: dict[str, AnalyzerHealth] = Field(default_factory=dict)
    providers: dict[str, ProviderHealth] = Field(default_factory=dict)
    ocr_driver: str
    warnings: list[str] = Field(default_factory=list)


class EmbedRequest(Wire):
    request_id: str | None = None
    texts: list[str] = Field(default_factory=list)
    image_uris: list[str] = Field(default_factory=list)
    kind: Literal["text", "image"] = "text"


class EmbedResponse(Wire):
    request_id: str | None = None
    provider: str
    dim: int
    vectors: list[list[float]] = Field(default_factory=list)
    cost_usd: float = 0.0
    warnings: list[str] = Field(default_factory=list)


class VersionResponse(Wire):
    engine_version: str
    pipeline_version: str
    python: str
    analyzers: int


__all__ = [name for name in dir() if name[0].isupper()] + ["build_result", "SEVERITY_ORDER"]
