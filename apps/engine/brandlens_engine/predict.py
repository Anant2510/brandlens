"""Synthetic persona panel — *relative* ranking, never a bare absolute score.

The literature and our own calibration agree: LLM panels rank reliably and score
unreliably. Ask a model "score this 1-10" and you get a number that drifts with
prompt phrasing, model version and time of day. Ask it "which of these three is
strongest for this persona, and why" and it agrees with human panels far more
often.

So every prediction here is anchored to real reference assets from the tenant's
own corpus, is reported as a percentile against those references, and always
carries an interval. `percentileVsCorpus` is null — not 50 — when no comparison
assets were supplied, because a percentile against nothing is a fabrication.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

import numpy as np

from .config import Settings, get_settings
from .imagery import extract_style_features
from .llm.base import LLMError, NullProvider
from .llm.factory import build_provider, canonical_provider
from .logging import get_logger
from .media import MediaError, encode_png, load_image, resize_max_edge
from .models import PredictRequest, PredictResponse

log = get_logger(__name__)

DIMENSIONS: tuple[str, ...] = (
    "attention",
    "clarity",
    "brandFit",
    "distinctiveness",
    "persuasion",
    "trust",
)

_PANEL_SYSTEM = """You are simulating one member of an audience panel. You react to advertising as
that person would — not as a marketer, and not as a critic.

You will see the CANDIDATE asset first, then one or more REFERENCE assets that this brand
has already run. Your job is comparative: rank the candidate against the references.

Return ONLY this JSON object:
{
  "firstReaction": "what you notice in the first two seconds, in your own words",
  "comparison": "how the candidate compares with each reference, by number",
  "rankOfCandidate": <1 = strongest, N = weakest, among candidate + references>,
  "totalRanked": <how many assets you ranked>,
  "dimensionRanks": {"attention": <rank>, "clarity": <rank>, "brandFit": <rank>,
                     "distinctiveness": <rank>, "persuasion": <rank>, "trust": <rank>},
  "wouldAct": true | false,
  "biggestConcern": "the one thing that would stop you",
  "confidence": 0.0-1.0
}

Rank, do not score. If you cannot tell two assets apart on a dimension, give them the
same rank rather than inventing a difference.
"""

_JSON_OBJECT = re.compile(r"\{.*\}", re.S)


def _persona_prompt(persona: dict[str, Any], brand_name: str, reference_count: int) -> str:
    described = ", ".join(f"{k}: {v}" for k, v in persona.items() if v not in (None, "", []))
    return (
        f"YOU ARE: {described or 'a general consumer'}\n\n"
        f"BRAND: {brand_name}\n"
        f"The first image is the CANDIDATE. The next {reference_count} image(s) are REFERENCES, "
        "numbered in order.\n\n"
        "React as yourself, then rank."
    )


def _parse_panel(raw: str) -> dict[str, Any] | None:
    match = _JSON_OBJECT.search(raw or "")
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _rank_to_percentile(rank: float, total: int) -> float:
    """Rank 1 of N -> 100th percentile; rank N -> 0th."""
    if total <= 1:
        return 50.0
    return round(max(0.0, min(100.0, (total - rank) / (total - 1) * 100.0)), 2)


def _style_prior(candidate_rgb: Any, reference_rgbs: list[Any]) -> dict[str, float]:
    """A measured fallback so the endpoint still says something useful with no
    model configured: distinctiveness proxied by distance from the references."""
    if not reference_rgbs:
        return {}
    cand = np.asarray(extract_style_features(candidate_rgb).as_vector(), dtype=np.float64)
    refs = np.asarray([extract_style_features(r).as_vector() for r in reference_rgbs], dtype=np.float64)
    centroid = refs.mean(axis=0)
    spread = float(np.linalg.norm(refs - centroid, axis=1).mean()) or 1.0
    distance = float(np.linalg.norm(cand - centroid))
    normalized = distance / spread
    return {
        # Distinctive is good up to a point; far outside the corpus reads as
        # off-brand rather than fresh, hence the peak at ~1.5 spreads out.
        "distinctiveness": round(min(100.0, 100.0 * math.exp(-((normalized - 1.5) ** 2) / 2.0)), 2),
        "brandFit": round(max(0.0, 100.0 * math.exp(-normalized / 2.0)), 2),
        "_styleDistanceInSpreads": round(normalized, 3),
    }


def predict(request: PredictRequest, settings: Settings | None = None) -> PredictResponse:
    s = settings or get_settings()
    warnings: list[str] = []

    try:
        candidate = load_image(request.asset.uri, dpi_hint=request.asset.dpi)
    except MediaError as exc:
        return PredictResponse(
            request_id=request.request_id,
            percentile_vs_corpus=None,
            dimension_scores={},
            interval_low=None,
            interval_high=None,
            panel_responses=[],
            recommendations=[{"kind": "error", "detail": f"candidate asset could not be loaded: {exc}"}],
        )

    references: list[tuple[str, Any]] = []
    for comparison in request.comparison_assets[:4]:
        try:
            references.append((comparison.label or comparison.id, load_image(comparison.uri).rgb))
        except MediaError as exc:
            warnings.append(f"reference {comparison.id} unavailable: {exc}")

    total_ranked = 1 + len(references)
    provider = build_provider(canonical_provider(request.provider), request.model, s)

    panel: list[dict[str, Any]] = []
    cost = 0.0

    if isinstance(provider, NullProvider):
        warnings.append(f"panel simulation unavailable: {provider.reason}")
    elif not request.personas:
        warnings.append("no personas supplied; nothing to simulate")
    else:
        images = [encode_png(resize_max_edge(candidate.rgb, 1024))] + [
            encode_png(resize_max_edge(rgb, 1024)) for _label, rgb in references
        ]
        for persona in request.personas[:8]:
            try:
                completion = provider.complete_vision(
                    system=_PANEL_SYSTEM,
                    prompt=_persona_prompt(persona, request.brand.name, len(references)),
                    images=images,
                    # Personas should differ from each other; a panel of
                    # identical respondents has no more information than one.
                    temperature=0.8,
                    max_tokens=900,
                )
                cost += completion.cost_usd
            except LLMError as exc:
                warnings.append(f"panel member failed: {exc}")
                continue
            parsed = _parse_panel(completion.text)
            if parsed is None:
                warnings.append("a panel response was not parsable JSON")
                continue
            parsed["persona"] = persona
            panel.append(parsed)

    dimension_scores: dict[str, float] = {}
    percentile: float | None = None
    low: float | None = None
    high: float | None = None
    recommendations: list[dict[str, Any]] = []

    if panel and references:
        overall_ranks: list[float] = []
        per_dimension: dict[str, list[float]] = {d: [] for d in DIMENSIONS}
        for response in panel:
            total = int(response.get("totalRanked") or total_ranked) or total_ranked
            try:
                overall_ranks.append(float(response.get("rankOfCandidate", total)))
            except (TypeError, ValueError):
                continue
            ranks = response.get("dimensionRanks") or {}
            for dimension in DIMENSIONS:
                try:
                    per_dimension[dimension].append(float(ranks[dimension]))
                except (KeyError, TypeError, ValueError):
                    continue

        if overall_ranks:
            percentiles = [_rank_to_percentile(r, total_ranked) for r in overall_ranks]
            percentile = round(float(np.mean(percentiles)), 2)
            # Interval over panel members, not a model-reported confidence: the
            # spread of simulated opinion is the honest uncertainty here.
            if len(percentiles) > 1:
                sem = float(np.std(percentiles, ddof=1)) / math.sqrt(len(percentiles))
                low = round(max(0.0, percentile - 1.96 * sem), 2)
                high = round(min(100.0, percentile + 1.96 * sem), 2)
            else:
                # One respondent is one opinion; the interval must say so.
                low, high = round(max(0.0, percentile - 25.0), 2), round(min(100.0, percentile + 25.0), 2)

        for dimension, ranks in per_dimension.items():
            if ranks:
                dimension_scores[dimension] = round(
                    float(np.mean([_rank_to_percentile(r, total_ranked) for r in ranks])), 2
                )

        concerns = [str(r.get("biggestConcern")) for r in panel if r.get("biggestConcern")]
        for concern in list(dict.fromkeys(concerns))[:5]:
            recommendations.append({"kind": "panel-concern", "detail": concern})
        weakest = min(dimension_scores.items(), key=lambda kv: kv[1]) if dimension_scores else None
        if weakest:
            recommendations.append(
                {
                    "kind": "weakest-dimension",
                    "dimension": weakest[0],
                    "percentile": weakest[1],
                    "detail": f"{weakest[0]} ranks lowest against the reference set; address it first.",
                }
            )
    elif panel and not references:
        warnings.append(
            "no comparison assets were supplied, so no percentile is reported — "
            "an absolute score from a model panel is not trustworthy enough to publish"
        )
        recommendations.extend(
            {"kind": "panel-concern", "detail": str(r.get("biggestConcern"))}
            for r in panel
            if r.get("biggestConcern")
        )

    prior = _style_prior(candidate.rgb, [rgb for _label, rgb in references])
    for key, value in prior.items():
        if not key.startswith("_"):
            dimension_scores.setdefault(f"{key}Measured", value)
    if "_styleDistanceInSpreads" in prior:
        recommendations.append(
            {
                "kind": "measured-style-distance",
                "value": prior["_styleDistanceInSpreads"],
                "detail": (
                    f"The candidate sits {prior['_styleDistanceInSpreads']} corpus-spreads from the "
                    "reference centroid. This is a measurement, not an opinion."
                ),
            }
        )
    for warning in warnings:
        recommendations.append({"kind": "warning", "detail": warning})

    return PredictResponse(
        request_id=request.request_id,
        percentile_vs_corpus=percentile,
        dimension_scores=dimension_scores,
        interval_low=low,
        interval_high=high,
        panel_responses=panel,
        recommendations=recommendations,
        cost_usd=round(cost, 6),
    )


__all__ = ["DIMENSIONS", "predict"]
