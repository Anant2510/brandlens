"""The orchestrator: AnalysisContext + tiered execution + budget guard.

Execution is strictly T0 -> T1 -> hybrid -> T2. That ordering is the product,
not an implementation detail:

* Deterministic checks are free and near-perfect, so they run first and their
  answers are banked before anything can fail.
* CV checks are free but fallible, and they produce the *numbers* the judge
  needs, so they run before T2.
* T2 costs money and is the only tier that can be wrong in a way a reviewer
  cannot audit, so it runs last, on the smallest crop, one criterion at a time,
  and only for what genuinely needs a semantic read.

When the budget is exhausted the run **degrades** rather than fails: remaining
T2 criteria come back as `insufficient_evidence` with an explanation, and the
response is flagged `degraded`. A partial answer with an honest gap beats an
error, and it beats a fabricated pass by a much wider margin.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray

from . import ENGINE_VERSION
from .cache import MeasurementCache, get_cache, measurement_key
from .config import Settings, get_settings
from .embeddings import HashEmbeddingProvider, cosine_similarity
from .judge import Judge
from .llm.base import LLMProvider, NullProvider
from .llm.factory import build_provider, canonical_provider
from .logging import bind_request, clear_request, get_logger
from .media import LoadedImage, MediaError, load_image_bytes, render_pdf_page, resolve_uri
from .models import (
    AnalyzeRequest,
    AnalyzeResponse,
    CriterionResult,
    EngineArtifact,
    RuleDefinition,
    build_result,
)
from .ocr import OcrResult, TextSpan, build_ocr_driver
from .registry import ANALYZERS, TIER_ORDER, effective_tier, get_analyzer, requires_llm
from .structured import StructuredDocument, parse_structured_source

log = get_logger(__name__)

_IMAGE_KINDS = {"image", "psd"}


@dataclass
class AnalysisContext:
    """Everything an analyzer may need, lazily resolved and memoised.

    Analyzers take `(ctx, rule)` and nothing else. Loading, OCR, structured
    parsing and logo detection are all shared across the ~40 checks in a run —
    doing them per-analyzer would multiply the cost of a single asset by an
    order of magnitude.
    """

    request: AnalyzeRequest
    settings: Settings
    cache: MeasurementCache
    warnings: list[str] = field(default_factory=list)
    artifacts: list[EngineArtifact] = field(default_factory=list)
    measurements: dict[str, Any] = field(default_factory=dict)
    cost_usd: float = 0.0
    deterministic_only: bool = False
    judge_unavailable_reason: str | None = None
    cache_hits: int = 0
    cache_misses: int = 0

    _image: LoadedImage | None = field(default=None, init=False, repr=False)
    _image_loaded: bool = field(default=False, init=False, repr=False)
    _bytes: bytes | None = field(default=None, init=False, repr=False)
    _bytes_loaded: bool = field(default=False, init=False, repr=False)
    _structured: StructuredDocument | None = field(default=None, init=False, repr=False)
    _ocr: OcrResult | None = field(default=None, init=False, repr=False)
    _judge: Judge | None = field(default=None, init=False, repr=False)
    _judge_built: bool = field(default=False, init=False, repr=False)
    _embedder: HashEmbeddingProvider | None = field(default=None, init=False, repr=False)
    _results: list[CriterionResult] = field(default_factory=list, init=False, repr=False)

    # -- shortcuts -----------------------------------------------------------
    @property
    def asset(self):  # noqa: ANN201 - EngineAssetRef, kept terse at 40 call sites
        return self.request.asset

    @property
    def brand(self):  # noqa: ANN201 - EngineBrandContext
        return self.request.brand

    @property
    def judge_config(self):  # noqa: ANN201 - EngineJudgeConfig
        return self.request.judge

    @property
    def dpi(self) -> float:
        if self.asset.dpi:
            return float(self.asset.dpi)
        img = self.image()
        return float(img.dpi) if img else 96.0

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)
            log.warning("analysis_warning", message=message)

    def spend(self, usd: float) -> None:
        self.cost_usd += max(0.0, float(usd))

    def budget_remaining(self) -> float:
        ceiling = float(self.judge_config.cost_ceiling_usd or self.settings.cost_job_usd_limit)
        return max(0.0, ceiling - self.cost_usd)

    def budget_allows_t2(self) -> bool:
        """Can we afford the *next* T2 criterion, not just the current spend?

        Waiting until the budget is fully drained lets a run overshoot its
        ceiling by a whole criterion — precisely what the ceiling exists to
        prevent. So we forecast from observed cost per call.

        The very first T2 call is always permitted: token pricing varies by an
        order of magnitude across the models a tenant may configure, and
        refusing to start means never learning what a call actually costs here.
        """
        remaining = self.budget_remaining()
        if remaining <= 0:
            return False
        judge = self._judge
        if judge is None or judge.calls <= 0:
            return True
        per_criterion = (judge.cost_usd / judge.calls) * max(1, int(self.judge_config.self_consistency_k))
        return remaining >= per_criterion

    def results_so_far(self) -> list[CriterionResult]:
        return list(self._results)

    def add_artifact(self, key: str, kind: str, uri: str, meta: dict[str, Any] | None = None) -> None:
        self.artifacts.append(EngineArtifact(key=key, kind=kind, uri=uri, meta=meta or {}))

    # -- asset bytes / image -------------------------------------------------
    def raw_bytes(self) -> bytes | None:
        if self._bytes_loaded:
            return self._bytes
        self._bytes_loaded = True
        if self.asset.kind == "copy":
            return None
        try:
            self._bytes = resolve_uri(self.asset.uri, timeout=self.settings.engine_timeout_ms / 1000.0)
        except MediaError as exc:
            self.warn(f"asset bytes unavailable: {exc}")
            self._bytes = None
        return self._bytes

    def image(self) -> LoadedImage | None:
        """Rasterised asset. PDFs render page 1; `copy` assets have no pixels."""
        if self._image_loaded:
            return self._image
        self._image_loaded = True
        data = self.raw_bytes()
        if data is None:
            return None
        try:
            if self.asset.kind == "pdf" or data[:5] == b"%PDF-":
                self._image = render_pdf_page(data, page_index=0, dpi=float(self.asset.dpi or 150.0))
            elif self.asset.kind in _IMAGE_KINDS or self.asset.kind in ("figma", "html", "pptx", "video"):
                self._image = load_image_bytes(data, dpi_hint=self.asset.dpi)
            else:
                self._image = load_image_bytes(data, dpi_hint=self.asset.dpi)
        except MediaError as exc:
            self.warn(f"asset could not be rasterised ({self.asset.kind}): {exc}")
            self._image = None
        if self._image is not None:
            for w in self._image.warnings:
                self.warn(w)
        return self._image

    # -- structured source ---------------------------------------------------
    def structured(self) -> StructuredDocument:
        if self._structured is not None:
            return self._structured
        doc = parse_structured_source(
            self.asset.structured_source,
            self.asset.kind,
            self.raw_bytes() if self.asset.kind in ("pdf", "pptx", "html") else None,
        )
        for w in doc.warnings:
            self.warn(w)
        self._structured = doc
        return doc

    # -- text spans ----------------------------------------------------------
    def ocr(self) -> OcrResult:
        if self._ocr is not None:
            return self._ocr
        img = self.image()
        driver = build_ocr_driver(self.settings, self._llm_provider())
        if img is None:
            self._ocr = OcrResult(driver=driver.name, available=False, warnings=["no pixels to OCR"])
            return self._ocr

        key = measurement_key(self.asset.content_hash, f"ocr.{driver.name}", {}, "1")
        cached = self.cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            self._ocr = OcrResult(
                spans=[
                    TextSpan(
                        text=s["text"],
                        bbox=tuple(s["bbox"]),
                        confidence=float(s.get("confidence", 0.0)),
                        source=str(s.get("source", driver.name)),
                    )
                    for s in cached.get("spans", [])
                ],
                driver=driver.name,
                available=bool(cached.get("available", True)),
            )
            return self._ocr

        self.cache_misses += 1
        result = driver.read(img.rgb)
        self.spend(result.cost_usd)
        for w in result.warnings:
            self.warn(w)
        if result.available:
            self.cache.set(
                key, {"spans": [s.as_dict() for s in result.spans], "available": result.available}
            )
        self._ocr = result
        return result

    def text_spans(self) -> list[TextSpan]:
        """Located text: structured geometry first, OCR only as a fallback.

        Structured spans are exact and free. Falling through to OCR when a PDF
        is right there would be slower, dearer and less accurate.
        """
        doc = self.structured()
        if doc.available:
            page = doc.page(0)
            if page and page.text:
                return [
                    TextSpan(
                        text=el.text,
                        bbox=el.bbox,
                        confidence=1.0,
                        source=doc.kind,
                        font_size_pt_estimate=el.font_size_pt or None,
                    )
                    for el in page.text
                    if el.text.strip()
                ]
        return self.ocr().spans

    # -- measurement cache ---------------------------------------------------
    def measure(self, name: str, params: dict[str, Any], compute: Callable[[], Any]) -> Any:
        """Content-addressed memoisation, exported in `AnalyzeResponse.measurements`.

        The control plane replays these on the next run of the same bytes, which
        is what makes a re-review after a copy tweak nearly free.
        """
        key = measurement_key(self.asset.content_hash, name, params, self.request.pipeline_version)
        preloaded = self.request.cached_measurements.get(key)
        if preloaded is not None:
            self.cache_hits += 1
            self.measurements[key] = preloaded
            return preloaded

        cached = self.cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            self.measurements[key] = cached
            return cached

        self.cache_misses += 1
        value = compute()
        if value is not None:
            self.cache.set(key, value)
            self.measurements[key] = value
        return value

    # -- embeddings ----------------------------------------------------------
    def image_similarity(self, a: NDArray[np.uint8], b: NDArray[np.uint8]) -> float:
        if self._embedder is None:
            self._embedder = HashEmbeddingProvider(self.settings.image_embedding_dim)
        vectors = self._embedder.embed_image_arrays([a, b]).vectors
        return cosine_similarity(vectors[0], vectors[1]) if len(vectors) == 2 else 0.0

    # -- judge ---------------------------------------------------------------
    def _llm_provider(self) -> LLMProvider | None:
        judge = self.judge()
        return judge.provider if judge else None

    def judge(self) -> Judge | None:
        if self._judge_built:
            return self._judge
        self._judge_built = True
        cfg = self.judge_config
        provider = build_provider(
            canonical_provider(cfg.provider or self.settings.llm_judge_provider),
            cfg.model or self.settings.llm_judge_model,
            self.settings,
        )
        if isinstance(provider, NullProvider):
            self.judge_unavailable_reason = provider.reason
            self.warn(f"T2 judge unavailable: {provider.reason}")
            return None
        self._judge = Judge(
            provider=provider,
            config=cfg,
            brand=self.brand,
            precedents=self.request.precedents,
            settings=self.settings,
        )
        return self._judge

    def judge_criterion(
        self,
        rule: RuleDefinition,
        question: str,
        measurements: dict[str, Any],
        crop_to: str = "full",
        pass_when: str | None = None,
        fail_when: str | None = None,
    ) -> CriterionResult:
        """Escape hatch so a T1 analyzer can hand a semantic sub-question to T2."""
        from .judge import _judge_or_degrade

        return _judge_or_degrade(
            self,
            rule,
            question=question,
            measurements=measurements,
            crop_to=crop_to,
            pass_when=pass_when,
            fail_when=fail_when,
        )


# ---------------------------------------------------------------------------
# Scoping
# ---------------------------------------------------------------------------
def rule_in_scope(rule: RuleDefinition, ctx: AnalysisContext) -> bool:
    """A scope selector that names a dimension the asset does not carry is
    treated as *in scope*: silently skipping a rule because metadata was missing
    is how compliance gaps happen."""
    scope = rule.scope
    checks = (
        (scope.markets, ctx.asset.market),
        (scope.channels, ctx.asset.channel),
        (scope.asset_types, ctx.asset.asset_type),
    )
    for allowed, actual in checks:
        if allowed and actual and actual not in allowed:
            return False
    return True


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def run_analysis(request: AnalyzeRequest, settings: Settings | None = None) -> AnalyzeResponse:
    s = settings or get_settings()
    started = time.perf_counter()
    bind_request(request.request_id, org_id=request.org_id, asset_id=request.asset.id)

    try:
        s.ensure_dirs()
    except OSError as exc:
        log.warning("scratch_dirs_unavailable", error=str(exc))

    ctx = AnalysisContext(
        request=request,
        settings=s,
        cache=get_cache(),
        deterministic_only=bool(request.deterministic_only),
    )

    results: list[CriterionResult] = []
    degraded = bool(request.deterministic_only)
    degraded_reason: str | None = (
        "deterministicOnly requested by the control plane" if request.deterministic_only else None
    )

    # Group by effective tier; within a tier, blockers first so the most
    # consequential answers are banked before any budget pressure appears.
    buckets: dict[str, list[RuleDefinition]] = {tier: [] for tier in TIER_ORDER}
    skipped: list[RuleDefinition] = []
    for rule in request.rules:
        if not rule_in_scope(rule, ctx):
            skipped.append(rule)
            continue
        buckets[effective_tier(rule.check.fn, rule.tier)].append(rule)

    severity_rank = {"blocker": 0, "major": 1, "minor": 2, "advisory": 3}
    for tier in TIER_ORDER:
        buckets[tier].sort(key=lambda r: (severity_rank.get(r.severity, 2), r.key))
        # `vlm.overall_judgment` must see the itemised findings, so it goes last.
        buckets[tier].sort(key=lambda r: r.check.fn == "vlm.overall_judgment")

    for rule in skipped:
        results.append(
            build_result(
                rule,
                "not_applicable",
                observation=(
                    "Rule is out of scope for this asset "
                    f"(market={request.asset.market}, channel={request.asset.channel}, "
                    f"assetType={request.asset.asset_type})."
                ),
                measured={"scope": rule.scope.model_dump(by_alias=True, exclude_none=True)},
            )
        )

    for tier in TIER_ORDER:
        for rule in buckets[tier]:
            needs_llm = requires_llm(rule.check.fn)

            if needs_llm and ctx.deterministic_only:
                results.append(
                    build_result(
                        rule,
                        "insufficient_evidence",
                        observation=(
                            "Skipped: this run is deterministic-only, so no T2 judgment was made. "
                            "Re-run with T2 enabled to evaluate this criterion."
                        ),
                        measured={"skipped": True, "reason": "deterministicOnly"},
                    )
                )
                continue

            if needs_llm and not ctx.budget_allows_t2():
                if not degraded:
                    degraded = True
                    degraded_reason = (
                        f"cost ceiling of ${float(request.judge.cost_ceiling_usd):.2f} reached; "
                        "remaining T2 criteria were not evaluated"
                    )
                    ctx.warn(degraded_reason)
                # Once the ceiling is hit, stop *starting* new paid work but keep
                # running free tiers: a partial answer beats an error.
                ctx.deterministic_only = True
                results.append(
                    build_result(
                        rule,
                        "insufficient_evidence",
                        observation=(
                            f"Skipped: the ${float(request.judge.cost_ceiling_usd):.2f} per-run cost "
                            "ceiling was reached before this criterion was evaluated."
                        ),
                        measured={"skipped": True, "reason": "costCeiling", "spentUsd": round(ctx.cost_usd, 6)},
                    )
                )
                continue

            analyzer = get_analyzer(rule.check.fn)
            if analyzer is None:
                results.append(
                    build_result(
                        rule,
                        "insufficient_evidence",
                        observation=(
                            f"No analyzer is registered for {rule.check.fn!r}. "
                            f"Registered analyzers: {len(ANALYZERS)}."
                        ),
                        error=f"unknown analyzer {rule.check.fn!r}",
                        measured={"fn": rule.check.fn},
                    )
                )
                continue

            t0 = time.perf_counter()
            try:
                result = analyzer(ctx, rule)
            except Exception as exc:  # noqa: BLE001 - one bad analyzer must not fail the run
                log.exception("analyzer_failed", rule_key=rule.key, fn=rule.check.fn)
                ctx.warn(f"{rule.key} ({rule.check.fn}) raised {type(exc).__name__}: {exc}")
                result = build_result(
                    rule,
                    "insufficient_evidence",
                    observation=(
                        f"The {rule.check.fn} analyzer failed with {type(exc).__name__}: {exc}. "
                        "No verdict could be produced for this criterion."
                    ),
                    error=f"{type(exc).__name__}: {exc}",
                )
            if result.latency_ms is None:
                result.latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
            results.append(result)
            ctx._results = results

    total_cost = round(ctx.cost_usd, 6)
    duration = round((time.perf_counter() - started) * 1000.0, 2)

    warnings = list(ctx.warnings)
    if ctx.cache_hits or ctx.cache_misses:
        log.info(
            "analysis_complete",
            criteria=len(results),
            cost_usd=total_cost,
            duration_ms=duration,
            cache_hits=ctx.cache_hits,
            cache_misses=ctx.cache_misses,
            degraded=degraded,
        )

    response = AnalyzeResponse(
        request_id=request.request_id,
        results=results,
        measurements=ctx.measurements,
        artifacts=ctx.artifacts,
        cost_usd=total_cost,
        duration_ms=duration,
        degraded=degraded,
        degraded_reason=degraded_reason,
        engine_version=ENGINE_VERSION,
        warnings=warnings,
    )
    clear_request()
    return response


__all__ = ["AnalysisContext", "rule_in_scope", "run_analysis"]
