"""Rule induction: measure the approved corpus, propose the rules it implies.

Written guidelines describe the rules a brand team *believes* it enforces.
The approved corpus reveals the rules it *actually* enforces — and the gap is
usually large: the book says "minimum 24px logo" while three years of approved
work never goes below 41px, because 24px was never really acceptable.

So every proposed rule here carries `support`: n, the percentile used, the
observed value, and example asset ids. A threshold a customer can trace back to
their own approved work is a threshold they will accept; a threshold that
appeared from nowhere is one they will argue with, then disable.

Nothing induced is ever active. Same discipline as `extract.py`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .color import extract_palette, hex_to_lab, nearest_token
from .config import Settings, get_settings
from .imagery import FEATURE_KEYS, extract_style_features
from .layout import ink_bbox, measure_margins
from .logging import get_logger
from .logo import detect_logo
from .media import MediaError, load_image
from .models import (
    EngineAssetRef,
    EngineBrandContext,
    InduceRulesRequest,
    InduceRulesResponse,
    RuleCheckSpec,
    RuleDefinition,
    RuleSupport,
)
from .structured import parse_structured_source

log = get_logger(__name__)

#: Below this, a percentile is noise. The contract's default `minSupport` is 20;
#: we never propose below it, and we say so in the warnings when we cannot.
ABSOLUTE_MIN_SUPPORT = 5


@dataclass(slots=True)
class CorpusMeasurements:
    margins: dict[str, list[float]] = field(default_factory=lambda: {"left": [], "top": [], "right": [], "bottom": []})
    logo_height_pct: list[float] = field(default_factory=list)
    logo_clearspace_multiple: list[float] = field(default_factory=list)
    type_sizes_pt: list[float] = field(default_factory=list)
    style_vectors: list[list[float]] = field(default_factory=list)
    palette_conformance_de: list[float] = field(default_factory=list)
    aspect_ratios: list[float] = field(default_factory=list)
    asset_ids: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.asset_ids)


def measure_asset(asset: EngineAssetRef, brand: EngineBrandContext, into: CorpusMeasurements) -> bool:
    try:
        img = load_image(asset.uri, dpi_hint=asset.dpi)
    except MediaError as exc:
        into.failures.append(f"{asset.id}: {exc}")
        return False

    into.asset_ids.append(asset.id)
    into.aspect_ratios.append(img.width / max(img.height, 1))

    box = ink_bbox(img.rgb)
    if box is not None:
        for edge, value in measure_margins(box).items():
            into.margins[edge].append(value)

    features = extract_style_features(img.rgb)
    into.style_vectors.append(features.as_vector())

    token_labs: list[tuple[float, float, float]] = []
    for token in brand.color_tokens:
        try:
            token_labs.append(tuple(token.lab) if token.lab else hex_to_lab(token.hex))  # type: ignore[arg-type]
        except ValueError:
            continue
    if token_labs:
        palette = extract_palette(img.rgb, k=6, alpha=img.alpha)
        for entry in palette.entries:
            if entry.share >= 0.05:
                _idx, de = nearest_token(entry.lab, token_labs)
                into.palette_conformance_de.append(de)

    for variant in brand.logo_variants[:3]:
        try:
            template = load_image(variant.uri)
        except MediaError:
            continue
        detection = detect_logo(img.rgb, template.rgb, variant)
        if detection is not None:
            into.logo_height_pct.append(detection.height_norm * 100.0)
            break

    doc = parse_structured_source(asset.structured_source, asset.kind, None)
    for el in doc.all_text:
        if el.font_size_pt > 0 and el.text.strip():
            into.type_sizes_pt.append(el.font_size_pt)
    return True


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=np.float64), percentile))


def _support(values: list[float], percentile: float, asset_ids: list[str]) -> RuleSupport:
    return RuleSupport(
        sample_size=len(values),
        percentile=percentile,
        observed_value=round(_percentile(values, percentile) or 0.0, 4),
        example_asset_ids=asset_ids[:5],
    )


def induce_rules(request: InduceRulesRequest, settings: Settings | None = None) -> InduceRulesResponse:
    _ = settings or get_settings()
    measurements = CorpusMeasurements()
    for asset in request.assets:
        measure_asset(asset, request.brand, measurements)

    warnings: list[str] = list(measurements.failures[:20])
    n = measurements.count
    if n == 0:
        return InduceRulesResponse(
            request_id=request.request_id,
            measured_count=0,
            warnings=warnings + ["no corpus asset could be measured"],
        )

    min_support = max(ABSOLUTE_MIN_SUPPORT, int(request.min_support))
    if n < min_support:
        warnings.append(
            f"only {n} assets measured against a minSupport of {request.min_support}; "
            "thresholds are reported but no rules are proposed — an under-supported threshold is "
            "worse than no rule, because it fails work the team considers fine"
        )

    p = float(request.percentile)
    rules: list[RuleDefinition] = []

    def _emit(
        key: str,
        statement: str,
        dimension: str,
        tier: str,
        fn: str,
        params: dict[str, Any],
        values: list[float],
        percentile: float,
        rationale: str,
        severity: str = "major",
    ) -> None:
        if n < min_support or len(values) < min_support:
            return
        rules.append(
            RuleDefinition(
                key=key,
                statement=statement,
                rationale=rationale,
                dimension=dimension,  # type: ignore[arg-type]
                tier=tier,  # type: ignore[arg-type]
                severity=severity,  # type: ignore[arg-type]
                check=RuleCheckSpec(fn=fn, params=params),
                provenance="inductive",
                support=_support(values, percentile, measurements.asset_ids),
                status="proposed",
            )
        )

    # --- margins: the p-th percentile is the floor the team actually holds ---
    all_margins = [v for edge in measurements.margins.values() for v in edge]
    min_margin = _percentile(all_margins, p)
    if min_margin is not None:
        _emit(
            key="induced.layout.margins",
            statement=(
                f"Keep content at least {min_margin * 100:.1f}% of the canvas from every edge."
            ),
            dimension="layout",
            tier="cv",
            fn="layout.margins",
            params={"minMarginPct": round(min_margin * 100, 2)},
            values=all_margins,
            percentile=p,
            rationale=(
                f"{p:.0f}th percentile of edge margins across {n} approved assets. "
                "Set at the percentile rather than the minimum so one outlier cannot define the rule."
            ),
        )

    # --- logo minimum size ---------------------------------------------------
    if measurements.logo_height_pct:
        floor = _percentile(measurements.logo_height_pct, p)
        if floor is not None:
            _emit(
                key="induced.logo.min_size",
                statement=f"The logo should occupy at least {floor:.2f}% of the canvas height.",
                dimension="logo",
                tier="cv",
                fn="logo.min_size",
                params={"minHeightPct": round(floor, 3)},
                values=measurements.logo_height_pct,
                percentile=p,
                rationale=(
                    f"{p:.0f}th percentile of detected logo height over {len(measurements.logo_height_pct)} "
                    "approved assets where a logo was located."
                ),
            )

    # --- type size floor -----------------------------------------------------
    if measurements.type_sizes_pt:
        floor_pt = _percentile(measurements.type_sizes_pt, p)
        if floor_pt is not None:
            _emit(
                key="induced.typography.min_size",
                statement=f"Set no type smaller than {floor_pt:.1f}pt.",
                dimension="typography",
                tier="deterministic",
                fn="typography.min_size",
                params={"minSizePt": round(floor_pt, 1)},
                values=measurements.type_sizes_pt,
                percentile=p,
                rationale=(
                    f"{p:.0f}th percentile of {len(measurements.type_sizes_pt)} type runs read from "
                    "structured sources in the approved corpus."
                ),
            )

    # --- palette tolerance ---------------------------------------------------
    if measurements.palette_conformance_de:
        # Upper tail here, not lower: we want the tolerance that admits the
        # corpus, so 100-p, not p.
        tolerance = _percentile(measurements.palette_conformance_de, 100.0 - p)
        if tolerance is not None:
            _emit(
                key="induced.color.palette_conformance",
                statement=(
                    f"Flat colour should sit within dE2000 {tolerance:.1f} of a brand token."
                ),
                dimension="color",
                tier="cv",
                fn="color.palette_conformance",
                params={"maxDeltaE": round(max(1.5, tolerance), 2)},
                values=measurements.palette_conformance_de,
                percentile=100.0 - p,
                rationale=(
                    f"{100 - p:.0f}th percentile of the dE2000 between measured colour clusters and the "
                    "nearest brand token across the approved corpus — the tolerance the corpus itself implies."
                ),
                severity="minor",
            )

    # --- aspect ratios -------------------------------------------------------
    if len(set(round(a, 3) for a in measurements.aspect_ratios)) <= 3 and len(measurements.aspect_ratios) >= min_support:
        common = sorted({round(a, 4) for a in measurements.aspect_ratios})
        _emit(
            key="induced.channel_spec.aspect",
            statement=f"Use only the established aspect ratios: {common}.",
            dimension="channel_spec",
            tier="deterministic",
            fn="channel_spec.conformance",
            params={"spec": {"aspectRatio": common[0], "aspectTolerance": 0.02}},
            values=measurements.aspect_ratios,
            percentile=50.0,
            rationale=f"All {n} approved assets use one of {len(common)} aspect ratio(s).",
            severity="minor",
        )

    # --- style manifold ------------------------------------------------------
    style_profile: dict[str, Any] | None = None
    if measurements.style_vectors:
        matrix = np.asarray(measurements.style_vectors, dtype=np.float64)
        centroid = matrix.mean(axis=0)
        from .imagery import style_distance

        distances = [style_distance(list(v), list(centroid)) for v in measurements.style_vectors]
        finite = [d for d in distances if math.isfinite(d)]
        style_profile = {
            "featureKeys": list(FEATURE_KEYS),
            "featureStats": {
                key: {
                    "mean": round(float(matrix[:, i].mean()), 5),
                    "std": round(float(matrix[:, i].std()), 5),
                    "p5": round(float(np.percentile(matrix[:, i], 5)), 5),
                    "p95": round(float(np.percentile(matrix[:, i], 95)), 5),
                }
                for i, key in enumerate(FEATURE_KEYS)
                if i < matrix.shape[1]
            },
            "centroid": [round(float(v), 6) for v in centroid],
            "distanceP50": round(float(np.percentile(finite, 50)), 5) if finite else None,
            "distanceP95": round(float(np.percentile(finite, 95)), 5) if finite else None,
            "distanceP5": round(float(np.percentile(finite, 95)), 5) if finite else None,
            "sampleSize": len(measurements.style_vectors),
        }
        if finite and n >= min_support:
            _emit(
                key="induced.imagery.style_conformance",
                statement="Imagery should sit inside the established style manifold of the approved corpus.",
                dimension="imagery",
                tier="cv",
                fn="imagery.style_conformance",
                params={"maxDistance": round(float(np.percentile(finite, 95)), 4)},
                values=finite,
                percentile=95.0,
                rationale=(
                    f"95th percentile of the distance-to-centroid over {len(finite)} approved assets: "
                    "an asset further from the corpus than 95% of the corpus is an outlier by the "
                    "team's own revealed standard."
                ),
                severity="minor",
            )

    return InduceRulesResponse(
        request_id=request.request_id,
        rules=rules,
        style_profile=style_profile,
        measured_count=n,
        warnings=warnings,
    )


__all__ = ["CorpusMeasurements", "induce_rules", "measure_asset"]
