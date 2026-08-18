"""Image style: feature extraction, manifold distance, medium, reuse.

"Does this photo feel like us?" is a real brand rule and a terrible VLM prompt —
ask five times and you get five answers. It becomes tractable when you turn it
into a *distance*: extract a fixed feature vector, compare it to the centroid of
the tenant's own approved corpus, and compare that distance against the corpus's
own p50/p95. Then the question is no longer aesthetic, it is "this asset is
further from your library than 95% of your library is".

`imagery.prohibited_subject` is the exception — it is genuinely semantic, so it
is the one analyzer here that routes to T2, with the measured style numbers
supplied as context rather than as the answer.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
from numpy.typing import NDArray

from .color import rgb_to_lab
from .media import MediaError, load_image, resize_max_edge
from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

#: Order is load-bearing: it is the vector layout stored in the brand's
#: `imageStyleProfile.centroid`, so appending is safe and reordering is not.
FEATURE_KEYS: tuple[str, ...] = (
    "saturationMean",
    "saturationStd",
    "lightnessMean",
    "lightnessStd",
    "warmthB",
    "greenRedA",
    "contrastRms",
    "hueSpread",
    "grain",
    "edgeDensity",
    "highlightClipping",
    "shadowClipping",
)


@dataclass(slots=True)
class StyleFeatures:
    saturation_mean: float
    saturation_std: float
    lightness_mean: float
    lightness_std: float
    warmth_b: float
    green_red_a: float
    contrast_rms: float
    hue_spread: float
    grain: float
    edge_density: float
    highlight_clipping: float
    shadow_clipping: float

    def as_vector(self) -> list[float]:
        return [
            self.saturation_mean,
            self.saturation_std,
            self.lightness_mean,
            self.lightness_std,
            self.warmth_b,
            self.green_red_a,
            self.contrast_rms,
            self.hue_spread,
            self.grain,
            self.edge_density,
            self.highlight_clipping,
            self.shadow_clipping,
        ]

    def as_dict(self) -> dict[str, float]:
        return dict(zip(FEATURE_KEYS, [round(v, 5) for v in self.as_vector()], strict=True))


def extract_style_features(rgb: NDArray[np.uint8], max_edge: int = 512) -> StyleFeatures:
    """Perceptual style statistics, all computed in Lab.

    Chroma-as-saturation and b*-as-warmth are measured in Lab rather than HSV
    because HSV saturation is a nonlinear function of lightness — the same paint
    reads as two different "saturations" in sun and shade.
    """
    small = resize_max_edge(np.asarray(rgb, dtype=np.uint8), max_edge).astype(np.float64)
    h, w = small.shape[:2]
    flat = small.reshape(-1, 3)
    lab = rgb_to_lab(flat)
    L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
    chroma = np.hypot(a, b)
    hue = np.degrees(np.arctan2(b, a)) % 360.0

    gray = flat @ np.array([0.2126, 0.7152, 0.0722])
    gray_img = gray.reshape(h, w)
    gy, gx = np.gradient(gray_img / 255.0)
    edges = np.hypot(gx, gy)

    # Grain: residual after a 3x3 box blur. High-frequency energy that is not
    # structure is film grain / sensor noise / heavy compression.
    kernel = np.ones((3, 3)) / 9.0
    padded = np.pad(gray_img, 1, mode="edge")
    blurred = sum(
        kernel[i, j] * padded[i : i + h, j : j + w] for i in range(3) for j in range(3)
    )
    grain = float(np.abs(gray_img - blurred).mean())

    # Circular hue spread: a mean of 359 and 1 degree is 0, not 180.
    weights = np.clip(chroma, 0, None)
    total_w = float(weights.sum())
    if total_w > 1e-9:
        rad = np.radians(hue)
        r = math.hypot(float((weights * np.cos(rad)).sum()), float((weights * np.sin(rad)).sum())) / total_w
        hue_spread = float(np.clip(1.0 - r, 0.0, 1.0))
    else:
        hue_spread = 0.0

    return StyleFeatures(
        saturation_mean=float(chroma.mean()),
        saturation_std=float(chroma.std()),
        lightness_mean=float(L.mean()),
        lightness_std=float(L.std()),
        warmth_b=float(b.mean()),
        green_red_a=float(a.mean()),
        contrast_rms=float(gray.std()),
        hue_spread=hue_spread,
        grain=grain,
        edge_density=float(edges.mean()),
        highlight_clipping=float((gray >= 250).mean()),
        shadow_clipping=float((gray <= 5).mean()),
    )


#: Rough per-feature scale, used to standardise before taking a distance. Without
#: it, `lightnessMean` (0..100) would swamp `highlightClipping` (0..1).
_FEATURE_SCALE = np.array([20.0, 15.0, 20.0, 18.0, 15.0, 12.0, 45.0, 0.35, 6.0, 0.09, 0.08, 0.08])


def style_distance(features: list[float], centroid: list[float]) -> float:
    """Scaled Euclidean distance in feature space."""
    f = np.asarray(features, dtype=np.float64)
    c = np.asarray(centroid, dtype=np.float64)
    n = min(f.size, c.size, _FEATURE_SCALE.size)
    if n == 0:
        return math.inf
    return float(np.linalg.norm((f[:n] - c[:n]) / _FEATURE_SCALE[:n]))


def classify_medium(features: StyleFeatures, rgb: NDArray[np.uint8]) -> tuple[str, float, dict[str, float]]:
    """Photo / illustration / 3D-render / screenshot / flat-graphic, heuristically.

    This is a genuine heuristic, and it reports its own confidence so the caller
    can escalate an ambiguous call to the VLM instead of asserting a violation.
    """
    small = resize_max_edge(np.asarray(rgb, dtype=np.uint8), 384)
    flat = small.reshape(-1, 3)
    # Unique-colour ratio separates vector art (few colours) from capture.
    uniq = float(len(np.unique(flat.astype(np.uint32) @ np.array([65536, 256, 1], dtype=np.uint32))))
    uniq_ratio = uniq / max(flat.shape[0], 1)

    gray = flat @ np.array([0.2126, 0.7152, 0.0722])
    hist, _ = np.histogram(gray, bins=64, range=(0, 255))
    hist = hist / max(hist.sum(), 1)
    entropy = float(-(hist[hist > 0] * np.log2(hist[hist > 0])).sum())

    signals = {
        "uniqueColourRatio": round(uniq_ratio, 5),
        "histogramEntropy": round(entropy, 3),
        "grain": round(features.grain, 4),
        "edgeDensity": round(features.edge_density, 5),
        "lightnessStd": round(features.lightness_std, 3),
    }

    scores: dict[str, float] = {
        "photo": 0.0,
        "illustration": 0.0,
        "3d-render": 0.0,
        "flat-graphic": 0.0,
        "screenshot": 0.0,
    }
    scores["photo"] += 2.0 if features.grain > 1.2 else 0.0
    scores["photo"] += 2.0 if uniq_ratio > 0.35 else 0.0
    scores["photo"] += 1.0 if entropy > 5.0 else 0.0
    scores["flat-graphic"] += 3.0 if uniq_ratio < 0.02 else 0.0
    scores["flat-graphic"] += 1.5 if entropy < 3.0 else 0.0
    scores["flat-graphic"] += 1.0 if features.grain < 0.35 else 0.0
    scores["illustration"] += 2.0 if 0.02 <= uniq_ratio < 0.2 else 0.0
    scores["illustration"] += 1.0 if features.grain < 0.8 else 0.0
    # Renders are smooth like illustration but have photographic tonal range.
    scores["3d-render"] += 1.5 if (features.grain < 0.6 and entropy > 4.5 and uniq_ratio > 0.15) else 0.0
    scores["screenshot"] += 2.0 if (features.edge_density > 0.05 and uniq_ratio < 0.1) else 0.0
    scores["screenshot"] += 1.0 if features.highlight_clipping > 0.25 else 0.0

    best = max(scores.items(), key=lambda kv: kv[1])
    total = sum(scores.values())
    confidence = round(best[1] / total, 3) if total > 0 else 0.0
    return best[0], confidence, signals


def perceptual_hash(rgb: NDArray[np.uint8]) -> str:
    """pHash for reuse detection. Robust to rescaling and mild recompression."""
    try:
        import imagehash
        from PIL import Image

        return str(imagehash.phash(Image.fromarray(np.asarray(rgb, dtype=np.uint8)), hash_size=8))
    except Exception:  # noqa: BLE001 - degrade to a DCT-free average hash
        small = resize_max_edge(np.asarray(rgb, dtype=np.uint8), 8)
        gray = small.reshape(-1, 3) @ np.array([0.2126, 0.7152, 0.0722])
        bits = (gray > gray.mean()).astype(np.uint8)
        return "".join(f"{int(''.join(map(str, bits[i : i + 4])), 2):x}" for i in range(0, len(bits) - 3, 4))


def hamming_hex(a: str, b: str) -> int:
    if not a or not b or len(a) != len(b):
        return 64
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


# ---------------------------------------------------------------------------
# imagery.style_conformance
# ---------------------------------------------------------------------------
def _features_for(ctx: AnalysisContext) -> StyleFeatures | None:
    img = ctx.image()
    if img is None:
        return None
    raw = ctx.measure("imagery.style", {"v": 1}, lambda: asdict(extract_style_features(img.rgb)))
    return StyleFeatures(**raw)


def check_style_conformance(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    features = _features_for(ctx)
    if features is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Style features need pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )

    profile = ctx.brand.image_style_profile
    measured: dict[str, Any] = {"features": features.as_dict()}
    if profile is None or not profile.centroid:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            observation=(
                "No image style profile has been induced for this brand yet, so there is no manifold "
                "to measure distance against. Run rule induction over the approved corpus first."
            ),
        )

    params = rule.check.params
    distance = style_distance(features.as_vector(), list(profile.centroid))
    # p95 is preferred as the ceiling: p50 would fail half the approved corpus.
    ceiling = params.get("maxDistance")
    basis = "rule.params.maxDistance"
    if ceiling is None and profile.distance_p5 is not None:
        # distanceP5 is the 5th percentile of *similarity*, i.e. the far tail of
        # distance in this schema; treat it as the outlier boundary.
        ceiling = float(profile.distance_p5)
        basis = "profile.distanceP5"
    if ceiling is None and profile.distance_p50 is not None:
        ceiling = float(profile.distance_p50) * 2.0
        basis = "2x profile.distanceP50"
    if ceiling is None:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={**measured, "distance": round(distance, 4)},
            observation="The style profile carries a centroid but no distance percentiles to threshold against.",
        )

    measured.update(
        {
            "distance": round(distance, 4),
            "centroidDim": len(profile.centroid),
            "profileP50": profile.distance_p50,
            "profileP5": profile.distance_p5,
        }
    )
    thresholds = {"maxDistance": round(float(ceiling), 4), "basis": basis}
    if distance > float(ceiling):
        deltas = {
            k: round(v - c, 3)
            for k, v, c in zip(FEATURE_KEYS, features.as_vector(), list(profile.centroid), strict=False)
        }
        worst = max(deltas.items(), key=lambda kv: abs(kv[1]))
        measured["featureDeltas"] = deltas
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"Style distance {distance:.2f} exceeds the {float(ceiling):.2f} ceiling "
                f"({basis}). Largest deviation is {worst[0]} ({worst[1]:+.2f} from the corpus centroid)."
            ),
            suggested_fix=f"Bring {worst[0]} back toward the approved corpus (grade, crop or re-shoot).",
            confidence=0.8,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Style distance {distance:.2f} is inside the {float(ceiling):.2f} corpus boundary.",
        confidence=0.8,
    )


# ---------------------------------------------------------------------------
# imagery.medium
# ---------------------------------------------------------------------------
def check_medium(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    img = ctx.image()
    features = _features_for(ctx)
    if img is None or features is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Medium classification needs pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )

    params = rule.check.params
    allowed = [str(m).lower() for m in (params.get("allowedMediums") or [])]
    if not allowed and ctx.brand.image_style_profile and ctx.brand.image_style_profile.allowed_mediums:
        allowed = [str(m).lower() for m in ctx.brand.image_style_profile.allowed_mediums]
    if not allowed:
        return build_result(
            rule,
            "not_applicable",
            observation="No allowed mediums are configured for this brand or rule.",
            measured={"allowedMediums": []},
        )

    medium, confidence, signals = classify_medium(features, img.rgb)
    min_confidence = float(params.get("minConfidence", 0.45))
    measured = {"medium": medium, "classifierConfidence": confidence, "signals": signals}
    thresholds = {"allowedMediums": allowed, "minConfidence": min_confidence}

    if confidence < min_confidence:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"Medium classifier is ambiguous (best guess {medium!r} at confidence {confidence:.2f}, "
                f"below {min_confidence}). Escalate to a human or a VLM rather than assert a violation."
            ),
        )
    if medium not in allowed:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=f"Imagery reads as {medium!r} (confidence {confidence:.2f}); allowed mediums are {allowed}.",
            suggested_fix=f"Replace with {allowed[0]} imagery.",
            confidence=confidence,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Imagery reads as {medium!r}, which is on the allowed list.",
        confidence=confidence,
    )


# ---------------------------------------------------------------------------
# imagery.prohibited_subject  (hybrid: T1 measures, T2 adjudicates)
# ---------------------------------------------------------------------------
def check_prohibited_subject(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    img = ctx.image()
    if img is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Subject screening needs pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )

    prohibited = list(rule.check.params.get("prohibitedSubjects") or [])
    if not prohibited and ctx.brand.image_style_profile:
        prohibited = list(ctx.brand.image_style_profile.prohibited_subjects or [])
    if not prohibited:
        return build_result(
            rule,
            "not_applicable",
            observation="No prohibited subjects are configured for this brand or rule.",
            measured={"prohibitedSubjects": []},
        )

    features = _features_for(ctx)
    medium, medium_conf, _signals = classify_medium(features, img.rgb) if features else ("unknown", 0.0, {})

    # Subject identification is irreducibly semantic — this is exactly what T2
    # is for. Everything measurable is handed over as context, and the model is
    # asked one closed question about a list it did not invent.
    return ctx.judge_criterion(
        rule=rule,
        question=(
            "Does this image depict any of the prohibited subjects listed below? "
            "Answer only about the listed subjects."
        ),
        measurements={
            "prohibitedSubjects": prohibited,
            "detectedMedium": medium,
            "mediumConfidence": medium_conf,
            "styleFeatures": features.as_dict() if features else {},
        },
        crop_to="full",
        fail_when="the image depicts one or more of the listed prohibited subjects",
    )


# ---------------------------------------------------------------------------
# imagery.reuse
# ---------------------------------------------------------------------------
def check_reuse(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Has this exact asset already run in this market/campaign?

    Perceptual hashing, not byte hashing: the same photo re-exported at another
    size or quality is the same photo for the purposes of a repetition rule.
    """
    img = ctx.image()
    if img is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Reuse detection needs pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )

    params = rule.check.params
    max_distance = int(params.get("maxHammingDistance", 8))
    known = params.get("knownHashes") or []
    known_uris = params.get("comparisonUris") or []

    phash = ctx.measure("imagery.phash", {"v": 1}, lambda: perceptual_hash(img.rgb))
    comparisons: list[dict[str, Any]] = []
    for entry in known:
        if isinstance(entry, dict):
            h, label = str(entry.get("hash", "")), str(entry.get("id", entry.get("label", "")))
        else:
            h, label = str(entry), ""
        if h:
            comparisons.append({"id": label, "hash": h, "distance": hamming_hex(phash, h)})
    for uri in known_uris:
        try:
            other = load_image(str(uri))
        except MediaError as exc:
            ctx.warn(f"reuse comparison asset {uri!r} could not be loaded: {exc}")
            continue
        h = perceptual_hash(other.rgb)
        comparisons.append({"id": str(uri), "hash": h, "distance": hamming_hex(phash, h)})

    measured = {
        "pHash": phash,
        "comparisons": sorted(comparisons, key=lambda c: int(c["distance"]))[:15],
        "comparisonCount": len(comparisons),
    }
    thresholds = {"maxHammingDistance": max_distance}

    if not comparisons:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation=(
                "No comparison hashes or URIs were supplied, so reuse cannot be determined. "
                f"This asset's pHash is {phash} — persist it to enable future comparisons."
            ),
        )
    matches = [c for c in comparisons if int(c["distance"]) <= max_distance]
    if matches:
        worst = min(matches, key=lambda c: int(c["distance"]))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"Perceptually identical to {worst['id'] or worst['hash']} "
                f"(Hamming distance {worst['distance']} <= {max_distance})."
            ),
            suggested_fix="Use fresh imagery, or clear the repetition with the channel owner.",
            confidence=0.9,
        )
    closest = min(comparisons, key=lambda c: int(c["distance"]))
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Closest known asset is Hamming distance {closest['distance']} away (limit {max_distance}).",
        confidence=0.9,
    )


__all__ = [
    "FEATURE_KEYS",
    "StyleFeatures",
    "check_medium",
    "check_prohibited_subject",
    "check_reuse",
    "check_style_conformance",
    "classify_medium",
    "extract_style_features",
    "hamming_hex",
    "perceptual_hash",
    "style_distance",
]
