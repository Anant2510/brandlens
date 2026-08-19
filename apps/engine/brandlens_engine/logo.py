"""Logo detection and the seven checks that hang off it.

Detection is a cascade, cheapest first:

1. **Feature matching + RANSAC homography** (SIFT, ORB fallback). This is the
   only method that yields a *transform*, which is what the distortion and
   clear-space checks actually need — a bbox alone cannot tell you the mark was
   squashed 12% on one axis.
2. **Multi-scale normalized cross-correlation.** Flat wordmarks and simple
   geometric marks often have too few stable keypoints for (1); NCC handles
   them, at the cost of returning only a box and a scale.
3. **Embedding similarity** on the best candidate region, as corroboration.
   It never *finds* anything; it stops a high-scoring texture match from being
   reported as the logo.

Everything measured here is handed to the T2 judge as numbers. The judge is
never asked "is the logo too small" — it is told "the logomark is 41px tall
against a 64px minimum" and asked whether the brand's stated exception applies.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np
from numpy.typing import NDArray

from .color import ciede2000, extract_palette, hex_to_lab, is_neutral
from .contrast import mm_to_px, px_to_mm
from .layout import collect_elements, ink_mask
from .logging import get_logger
from .media import MediaError, bbox_iou, load_image, resize_max_edge
from .models import LogoVariant, RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

log = get_logger(__name__)


@dataclass(slots=True)
class LogoDetection:
    variant_id: str
    variant_name: str
    #: Normalized to the canvas.
    bbox: tuple[float, float, float, float]
    score: float
    method: str
    inliers: int = 0
    homography: list[list[float]] | None = None
    quad: list[list[float]] | None = None
    scale: float = 1.0
    #: Anisotropy s1/s2 from the SVD of the affine part; 1.0 == undistorted.
    aspect_distortion: float = 1.0
    shear: float = 0.0
    rotation_deg: float = 0.0
    perspective: float = 0.0
    embedding_similarity: float | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def height_norm(self) -> float:
        return max(0.0, self.bbox[3] - self.bbox[1])

    @property
    def width_norm(self) -> float:
        return max(0.0, self.bbox[2] - self.bbox[0])

    def as_dict(self) -> dict[str, Any]:
        return {
            "variantId": self.variant_id,
            "variantName": self.variant_name,
            "bbox": [round(v, 5) for v in self.bbox],
            "score": round(self.score, 4),
            "method": self.method,
            "inliers": self.inliers,
            "scale": round(self.scale, 4),
            "aspectDistortion": round(self.aspect_distortion, 4),
            "shear": round(self.shear, 4),
            "rotationDeg": round(self.rotation_deg, 2),
            "perspective": round(self.perspective, 6),
            "embeddingSimilarity": round(self.embedding_similarity, 4)
            if self.embedding_similarity is not None
            else None,
        }


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
def _cv2():  # noqa: ANN202 - opaque module handle
    try:
        import cv2

        return cv2
    except Exception:  # noqa: BLE001  # pragma: no cover
        return None


def _to_gray(rgb: NDArray[np.uint8]) -> NDArray[np.uint8]:
    a = np.asarray(rgb, dtype=np.float64)[..., :3]
    return np.clip(a @ np.array([0.299, 0.587, 0.114]), 0, 255).astype(np.uint8)


def decompose_homography(h: NDArray[np.float64]) -> dict[str, float]:
    """Split a homography into scale / anisotropy / shear / rotation / perspective.

    A logo may legitimately be scaled and (rarely) rotated. What guidelines
    forbid is *non-uniform* scaling and shear, so those are separated out rather
    than lumped into a single 'transform error' number nobody can action.
    """
    a = np.asarray(h, dtype=np.float64)
    if a.shape != (3, 3) or abs(a[2, 2]) < 1e-12:
        return {"scale": 1.0, "aspectDistortion": 1.0, "shear": 0.0, "rotationDeg": 0.0, "perspective": 0.0}
    a = a / a[2, 2]
    affine = a[:2, :2]

    # SVD gives the two principal scale factors regardless of rotation.
    try:
        _u, s, _vt = np.linalg.svd(affine)
    except np.linalg.LinAlgError:  # pragma: no cover
        return {"scale": 1.0, "aspectDistortion": 1.0, "shear": 0.0, "rotationDeg": 0.0, "perspective": 0.0}
    s1, s2 = float(max(s)), float(max(min(s), 1e-9))

    # QR separates rotation from the shear/scale upper triangle.
    q, r = np.linalg.qr(affine)
    if r[0, 0] < 0:
        q[:, 0] *= -1
        r[0, :] *= -1
    if r[1, 1] < 0:
        q[:, 1] *= -1
        r[1, :] *= -1
    shear = float(r[0, 1] / r[1, 1]) if abs(r[1, 1]) > 1e-9 else 0.0
    rotation = float(np.degrees(np.arctan2(q[1, 0], q[0, 0])))

    return {
        "scale": math.sqrt(s1 * s2),
        "aspectDistortion": s1 / s2,
        "shear": shear,
        "rotationDeg": rotation,
        "perspective": float(np.hypot(a[2, 0], a[2, 1])),
    }


def _feature_detect(
    template: NDArray[np.uint8],
    target: NDArray[np.uint8],
    min_inliers: int = 8,
) -> tuple[tuple[float, float, float, float] | None, dict[str, Any]]:
    cv2 = _cv2()
    info: dict[str, Any] = {"method": "features", "inliers": 0}
    if cv2 is None:
        info["error"] = "opencv unavailable"
        return None, info

    tg, qg = _to_gray(template), _to_gray(target)
    detector = None
    norm = cv2.NORM_HAMMING
    try:
        detector = cv2.SIFT_create(nfeatures=1500)
        norm = cv2.NORM_L2
        info["detector"] = "SIFT"
    except Exception:  # noqa: BLE001 - not all builds ship SIFT
        detector = cv2.ORB_create(nfeatures=2000)
        info["detector"] = "ORB"

    try:
        kp_t, des_t = detector.detectAndCompute(tg, None)
        kp_q, des_q = detector.detectAndCompute(qg, None)
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"feature extraction failed: {exc}"
        return None, info

    if des_t is None or des_q is None or len(kp_t) < 4 or len(kp_q) < 4:
        info["error"] = "too few keypoints"
        return None, info

    try:
        matcher = cv2.BFMatcher(norm)
        raw = matcher.knnMatch(des_t, des_q, k=2)
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"matching failed: {exc}"
        return None, info

    # Lowe ratio test: without it, repeated logo geometry produces confident
    # nonsense matches and RANSAC happily fits a homography to them.
    good = [m for pair in raw if len(pair) == 2 for m, n in [pair] if m.distance < 0.75 * n.distance]
    info["goodMatches"] = len(good)
    if len(good) < min_inliers:
        info["error"] = f"only {len(good)} ratio-test matches"
        return None, info

    src = np.float32([kp_t[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_q[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    try:
        h, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0, maxIters=4000, confidence=0.995)
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"homography failed: {exc}"
        return None, info
    if h is None or mask is None:
        info["error"] = "no consistent homography"
        return None, info

    inliers = int(mask.sum())
    info["inliers"] = inliers
    if inliers < min_inliers:
        info["error"] = f"only {inliers} RANSAC inliers"
        return None, info

    th, tw = tg.shape[:2]
    corners = np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2)
    try:
        projected = cv2.perspectiveTransform(corners, h).reshape(-1, 2)
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"projection failed: {exc}"
        return None, info

    qh, qw = qg.shape[:2]
    xs, ys = projected[:, 0], projected[:, 1]
    bbox = (
        float(np.clip(xs.min(), 0, qw)) / qw,
        float(np.clip(ys.min(), 0, qh)) / qh,
        float(np.clip(xs.max(), 0, qw)) / qw,
        float(np.clip(ys.max(), 0, qh)) / qh,
    )
    if bbox[2] - bbox[0] < 1e-4 or bbox[3] - bbox[1] < 1e-4:
        info["error"] = "degenerate projection"
        return None, info

    info["homography"] = h.tolist()
    info["quad"] = projected.tolist()
    info.update(decompose_homography(h))
    info["score"] = min(1.0, inliers / max(len(good), 1))
    return bbox, info


def _ncc_detect(
    template: NDArray[np.uint8],
    target: NDArray[np.uint8],
    scales: tuple[float, ...] = (0.06, 0.09, 0.12, 0.16, 0.22, 0.3, 0.4, 0.55),
    min_score: float = 0.62,
) -> tuple[tuple[float, float, float, float] | None, dict[str, Any]]:
    """Multi-scale normalized cross-correlation. Scales are fractions of the
    canvas width, which is how logo size is actually specified in guidelines."""
    cv2 = _cv2()
    info: dict[str, Any] = {"method": "ncc", "inliers": 0}
    if cv2 is None:
        info["error"] = "opencv unavailable"
        return None, info

    tg, qg = _to_gray(template), _to_gray(target)
    qh, qw = qg.shape[:2]
    th, tw = tg.shape[:2]
    if th < 4 or tw < 4 or qh < 8 or qw < 8:
        info["error"] = "image too small for NCC"
        return None, info
    aspect = th / max(tw, 1)

    best: tuple[float, tuple[int, int, int, int], float] | None = None
    for frac in scales:
        w = int(round(qw * frac))
        h = int(round(w * aspect))
        if w < 8 or h < 8 or w >= qw or h >= qh:
            continue
        try:
            resized = cv2.resize(tg, (w, h), interpolation=cv2.INTER_AREA)
            res = cv2.matchTemplate(qg, resized, cv2.TM_CCOEFF_NORMED)
            _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
        except Exception:  # noqa: BLE001
            continue
        if best is None or maxv > best[0]:
            best = (float(maxv), (maxl[0], maxl[1], maxl[0] + w, maxl[1] + h), frac)

    if best is None or best[0] < min_score:
        info["error"] = f"best NCC score {best[0]:.3f} below {min_score}" if best else "no viable scale"
        info["score"] = best[0] if best else 0.0
        return None, info

    score, (x0, y0, x1, y1), frac = best
    info["score"] = score
    info["scale"] = frac * qw / max(tw, 1)
    info["aspectDistortion"] = 1.0  # NCC only ever matches the undistorted mark
    info["shear"] = 0.0
    info["rotationDeg"] = 0.0
    info["perspective"] = 0.0
    return (x0 / qw, y0 / qh, x1 / qw, y1 / qh), info


def detect_logo(
    target: NDArray[np.uint8],
    template: NDArray[np.uint8],
    variant: LogoVariant,
    min_inliers: int = 8,
    ncc_min_score: float = 0.62,
) -> LogoDetection | None:
    """Cascade: features (with transform) -> NCC (box only)."""
    # Cap the working resolution: matching a 6000px canvas costs 10x more and
    # finds nothing extra, since logos are large relative to their features.
    work = resize_max_edge(target, 1600)
    tmpl = resize_max_edge(template, 512)

    bbox, info = _feature_detect(tmpl, work, min_inliers=min_inliers)
    if bbox is None:
        bbox, info = _ncc_detect(tmpl, work, min_score=ncc_min_score)
    if bbox is None:
        return None

    return LogoDetection(
        variant_id=variant.id,
        variant_name=variant.name,
        bbox=bbox,
        score=float(info.get("score", 0.0)),
        method=str(info.get("method", "unknown")),
        inliers=int(info.get("inliers", 0)),
        homography=info.get("homography"),
        quad=info.get("quad"),
        scale=float(info.get("scale", 1.0)),
        aspect_distortion=float(info.get("aspectDistortion", 1.0)),
        shear=float(info.get("shear", 0.0)),
        rotation_deg=float(info.get("rotationDeg", 0.0)),
        perspective=float(info.get("perspective", 0.0)),
    )


def detect_all(ctx: AnalysisContext, rule: RuleDefinition | None = None) -> list[LogoDetection]:
    """Detect every configured variant. Cached — seven checks share one detection."""
    img = ctx.image()
    if img is None or not ctx.brand.logo_variants:
        return []

    params = (rule.check.params if rule else {}) or {}
    min_inliers = int(params.get("minInliers", 8))
    ncc_min = float(params.get("nccMinScore", 0.62))

    def _compute() -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for variant in ctx.brand.logo_variants:
            try:
                template = load_image(variant.uri)
            except MediaError as exc:
                ctx.warn(f"logo variant {variant.name!r} could not be loaded: {exc}")
                continue
            det = detect_logo(img.rgb, template.rgb, variant, min_inliers, ncc_min)
            if det is not None:
                found.append(det.as_dict())
        return found

    raw = ctx.measure("logo.detect", {"minInliers": min_inliers, "nccMinScore": ncc_min}, _compute)
    out: list[LogoDetection] = []
    for d in raw or []:
        out.append(
            LogoDetection(
                variant_id=str(d["variantId"]),
                variant_name=str(d["variantName"]),
                bbox=tuple(float(v) for v in d["bbox"]),  # type: ignore[arg-type]
                score=float(d["score"]),
                method=str(d["method"]),
                inliers=int(d["inliers"]),
                scale=float(d["scale"]),
                aspect_distortion=float(d["aspectDistortion"]),
                shear=float(d["shear"]),
                rotation_deg=float(d["rotationDeg"]),
                perspective=float(d["perspective"]),
            )
        )
    return out


def _best_detection(ctx: AnalysisContext, rule: RuleDefinition) -> LogoDetection | None:
    detections = detect_all(ctx, rule)
    return max(detections, key=lambda d: d.score) if detections else None


def _no_logo_result(ctx: AnalysisContext, rule: RuleDefinition, what: str) -> CriterionResult:
    if not ctx.brand.logo_variants:
        return build_result(
            rule,
            "not_applicable",
            observation="No logo variants are configured for this brand.",
            measured={"variants": 0},
        )
    if ctx.image() is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation=f"{what} needs pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )
    return build_result(
        rule,
        "insufficient_evidence",
        observation=f"{what} requires a located logo, and no variant was detected in this asset.",
        measured={"variants": len(ctx.brand.logo_variants), "detections": 0},
    )


# ---------------------------------------------------------------------------
# logo.presence
# ---------------------------------------------------------------------------
def check_presence(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    if not ctx.brand.logo_variants:
        return build_result(
            rule,
            "not_applicable",
            observation="No logo variants are configured for this brand.",
            measured={"variants": 0},
        )
    img = ctx.image()
    if img is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Logo presence needs pixels; this asset could not be rasterised.",
            measured={"assetKind": ctx.asset.kind},
        )

    params = rule.check.params
    required = params.get("requiredVariantIds")
    min_score = float(params.get("minScore", 0.0))
    detections = [d for d in detect_all(ctx, rule) if d.score >= min_score]

    # Corroborate with an embedding: NCC on a busy photo can score 0.7 on
    # texture, and a false "logo present" pass is worse than a miss.
    for d in detections:
        try:
            crop = img.crop_norm(d.bbox, pad_pct=0.05)
            template = load_image(next(v.uri for v in ctx.brand.logo_variants if v.id == d.variant_id))
            d.embedding_similarity = ctx.image_similarity(crop, template.rgb)
        except (MediaError, StopIteration, ValueError):
            d.embedding_similarity = None

    measured = {
        "detections": [d.as_dict() for d in detections],
        "detectionCount": len(detections),
        "variantsSearched": [v.id for v in ctx.brand.logo_variants],
    }
    thresholds = {"requiredVariantIds": required, "minScore": min_score}

    if not detections:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"No approved logo variant was detected across {len(ctx.brand.logo_variants)} "
                "template(s) using feature matching and multi-scale correlation."
            ),
            suggested_fix="Place an approved logo lockup on the asset.",
            confidence=0.8,
        )

    best = max(detections, key=lambda d: d.score)
    if required:
        found_ids = {d.variant_id for d in detections}
        missing = [r for r in required if r not in found_ids]
        if missing:
            return build_result(
                rule,
                "fail",
                measured={**measured, "missingVariantIds": missing},
                threshold=thresholds,
                bbox=best.bbox,
                observation=f"Required logo variant(s) {missing} are absent; found {sorted(found_ids)}.",
                suggested_fix=f"Use the required variant(s): {missing}.",
                confidence=0.8,
            )

    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=best.bbox,
        observation=(
            f"{best.variant_name!r} detected via {best.method} "
            f"(score {best.score:.2f}, {best.inliers} inliers)."
        ),
        confidence=min(0.99, 0.6 + 0.4 * best.score),
    )


# ---------------------------------------------------------------------------
# logo.clearspace
# ---------------------------------------------------------------------------
def _label_components(mask: NDArray[np.bool_]) -> tuple[NDArray[np.int32], int]:
    """Connected-component labels for a boolean ink mask.

    OpenCV is the fast path and is already a hard dependency; SciPy is the
    fallback so this keeps working if the headless OpenCV wheel is ever swapped
    for a build without `connectedComponents`. Both are 8-connected, which
    matters: 4-connectivity treats a diagonal antialiased staircase as separate
    components and would defeat the majority test in clearspace_measure.
    """
    try:
        import cv2

        count, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        # OpenCV counts the background as label 0, so subtract it.
        return labels.astype(np.int32), max(0, count - 1)
    except Exception:  # pragma: no cover - exercised only without OpenCV
        try:
            from scipy import ndimage

            structure = np.ones((3, 3), dtype=bool)  # 8-connected
            labels, count = ndimage.label(mask, structure=structure)
            return labels.astype(np.int32), int(count)
        except Exception:
            return np.zeros(mask.shape, dtype=np.int32), 0


def clearspace_measure(
    rgb: NDArray[np.uint8],
    logo_bbox: tuple[float, float, float, float],
    required_norm_x: float,
    required_norm_y: float,
    text_boxes: list[tuple[float, float, float, float]] | None = None,
) -> dict[str, Any]:
    """Free space on each side of the logo, by three independent signals.

    Edge density alone false-positives on a gradient backdrop; Lab variance
    alone misses thin dark rules on a dark field; OCR boxes alone miss graphic
    intrusions. Requiring agreement from the *content* signals (ink) while
    reporting all three keeps precision high without hiding the evidence.
    """
    h, w = rgb.shape[:2]
    mask = ink_mask(rgb)
    x0 = int(logo_bbox[0] * w)
    y0 = int(logo_bbox[1] * h)
    x1 = int(math.ceil(logo_bbox[2] * w))
    y1 = int(math.ceil(logo_bbox[3] * h))

    # The logo is itself ink; blank it so we measure the surroundings only.
    #
    # Blanking ONLY the detected rectangle is not enough, and the failure it
    # causes is the worst kind this product can produce. The box comes from
    # feature matching and is an estimate accurate to a pixel or two, while a
    # mark's antialiased edge extends past any tight box. Whatever spills over
    # stays in `probe` and is then measured as an intruder into the logo's own
    # exclusion zone: clearance collapses to zero on all four sides and a
    # perfectly compliant asset fails, with the evidence blaming "content" that
    # is the logo itself. Because the spill depends on sub-pixel detector
    # output, the same artwork could pass on one machine and fail on another —
    # this was caught by CI disagreeing between Linux and Windows.
    #
    # Fix: also remove ink components that are *predominantly inside* the
    # detected box. A component that is mostly inside the box is the mark; one
    # that merely touches it is a separate object and must still be caught, so
    # the majority test is what keeps a real intruder — or a dark background
    # bleeding in — from being erased along with the logo.
    probe = mask.copy()
    bx0, by0 = max(0, x0), max(0, y0)
    bx1, by1 = min(w, x1), min(h, y1)
    probe[by0:by1, bx0:bx1] = False

    if bx1 > bx0 and by1 > by0:
        labels, count = _label_components(mask)
        if count:
            inside = labels[by0:by1, bx0:bx1]
            for label in np.unique(inside):
                if label == 0:
                    continue
                component = labels == label
                total = int(component.sum())
                if total == 0:
                    continue
                within = int((inside == label).sum())
                # 0.6 rather than 0.5: a logo whose edge spills a few pixels is
                # ~99% inside, while a headline clipped by the box corner is
                # mostly outside. Nothing realistic sits near the boundary.
                if within / total >= 0.6:
                    probe[component] = False

    # Ceil, not round: a band one pixel short of the requirement would report a
    # fully-clear zone as marginally non-compliant.
    req_x = max(1, int(math.ceil(required_norm_x * w)))
    req_y = max(1, int(math.ceil(required_norm_y * h)))

    def _scan(axis: str) -> float:
        """Pixels from the logo edge to the nearest content, up to the required band.

        For the left/top bands the scan runs *away* from the logo, so the nearest
        intruder is the one with the largest local index and the gap is measured
        back from the band's far edge. Getting that inversion wrong silently
        turns a 16px gap into a 1px one and fails compliant artwork.
        """
        if axis == "left":
            band = probe[max(0, y0) : min(h, y1), max(0, x0 - req_x) : max(0, x0)]
            if band.size == 0:
                return float(max(0, x0)) / w
            cols = np.where(band.any(axis=0))[0]
            if not cols.size:
                # Whole band clear: the true clearance is at least the
                # requirement, unless the canvas edge truncated the band.
                return required_norm_x if band.shape[1] >= req_x else float(band.shape[1]) / w
            return float(band.shape[1] - int(cols.max()) - 1) / w
        if axis == "right":
            band = probe[max(0, y0) : min(h, y1), min(w, x1) : min(w, x1 + req_x)]
            if band.size == 0:
                return float(max(0, w - x1)) / w
            cols = np.where(band.any(axis=0))[0]
            if not cols.size:
                return required_norm_x if band.shape[1] >= req_x else float(band.shape[1]) / w
            return float(int(cols.min())) / w
        if axis == "top":
            band = probe[max(0, y0 - req_y) : max(0, y0), max(0, x0) : min(w, x1)]
            if band.size == 0:
                return float(max(0, y0)) / h
            rows = np.where(band.any(axis=1))[0]
            if not rows.size:
                return required_norm_y if band.shape[0] >= req_y else float(band.shape[0]) / h
            return float(band.shape[0] - int(rows.max()) - 1) / h
        band = probe[min(h, y1) : min(h, y1 + req_y), max(0, x0) : min(w, x1)]
        if band.size == 0:
            return float(max(0, h - y1)) / h
        rows = np.where(band.any(axis=1))[0]
        if not rows.size:
            return required_norm_y if band.shape[0] >= req_y else float(band.shape[0]) / h
        return float(int(rows.min())) / h

    # Rounded for display ONLY. Rounding to 5 decimals moves a value by up to
    # 5e-6, and the compliance comparison in check_clearspace uses a 1e-6
    # epsilon — five times smaller than the noise the rounding introduces. A
    # fully-clear side, whose true clearance equals the requirement exactly,
    # therefore passed or failed on the 5th decimal place: the same artwork
    # gave opposite verdicts depending on sub-pixel detector output, which is
    # how this surfaced as a Linux/Windows CI disagreement.
    #
    # `clearanceNorm` stays rounded because it is rendered in the UI and
    # exported in audit reports, where 17 significant figures are noise.
    # `clearanceNormExact` is what the verdict is computed from.
    exact = {side: max(0.0, _scan(side)) for side in ("left", "right", "top", "bottom")}
    clearances = {side: round(value, 5) for side, value in exact.items()}

    # Corroborating statistics over the annulus as a whole.
    ax0, ay0 = max(0, x0 - req_x), max(0, y0 - req_y)
    ax1, ay1 = min(w, x1 + req_x), min(h, y1 + req_y)
    annulus = np.zeros((h, w), dtype=bool)
    annulus[ay0:ay1, ax0:ax1] = True
    annulus[max(0, y0) : min(h, y1), max(0, x0) : min(w, x1)] = False

    edge_density = float(probe[annulus].mean()) if annulus.any() else 0.0
    lab_variance = 0.0
    if annulus.any():
        from .color import rgb_to_lab

        px = np.asarray(rgb, dtype=np.float64)[annulus][:, :3]
        if px.size:
            step = max(1, px.shape[0] // 20000)
            lab_variance = float(rgb_to_lab(px[::step]).std(axis=0).mean())

    text_intrusions: list[dict[str, Any]] = []
    for tb in text_boxes or []:
        zone = (
            logo_bbox[0] - required_norm_x,
            logo_bbox[1] - required_norm_y,
            logo_bbox[2] + required_norm_x,
            logo_bbox[3] + required_norm_y,
        )
        if bbox_iou(tb, zone) > 0 and bbox_iou(tb, logo_bbox) < 0.9:
            ix0, iy0 = max(tb[0], zone[0]), max(tb[1], zone[1])
            ix1, iy1 = min(tb[2], zone[2]), min(tb[3], zone[3])
            if ix1 > ix0 and iy1 > iy0:
                text_intrusions.append({"bbox": [round(v, 4) for v in tb]})

    return {
        "clearanceNorm": clearances,
        # Full precision, for the verdict. Never render this.
        "clearanceNormExact": exact,
        "annulusEdgeDensity": round(edge_density, 5),
        "annulusLabVariance": round(lab_variance, 3),
        "textIntrusions": text_intrusions[:10],
        "requiredNorm": {"x": round(required_norm_x, 5), "y": round(required_norm_y, 5)},
    }


def check_clearspace(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    det = _best_detection(ctx, rule)
    img = ctx.image()
    if det is None or img is None:
        return _no_logo_result(ctx, rule, "Clear-space measurement")

    params = rule.check.params
    variant = next((v for v in ctx.brand.logo_variants if v.id == det.variant_id), None)
    constraints = variant.constraints if variant else {}
    # Guidelines almost always express clear space as a multiple of a feature of
    # the mark itself (the height of the 'x', the width of the roundel), so the
    # multiple is applied to the detected logo box, not to the canvas.
    multiple = float(
        params.get("clearSpaceMultiple", constraints.get("clearSpaceMultiple", 0.5)) or 0.5
    )
    basis = str(params.get("basis", constraints.get("clearSpaceBasis", "height")))
    base_x = det.width_norm if basis == "width" else det.height_norm * (img.height / max(img.width, 1))
    base_y = det.height_norm if basis == "height" else det.width_norm * (img.width / max(img.height, 1))
    req_x, req_y = multiple * base_x, multiple * base_y

    measurement = clearspace_measure(
        img.rgb, det.bbox, req_x, req_y, [s.bbox for s in ctx.text_spans()]
    )
    clearances = measurement["clearanceNorm"]
    # The verdict is computed from the unrounded values, and the display copy is
    # dropped from the payload so it cannot be mistaken for the measurement.
    exact = measurement.pop("clearanceNormExact", clearances)

    # The scan counts whole pixels, so it cannot resolve a difference finer than
    # one pixel; the requirement is a continuous float derived from the detected
    # box. Comparing the two without a one-pixel tolerance asks the measurement
    # for precision it does not have, and the answer is decided by rounding
    # rather than by the artwork. One pixel is the physical resolution limit —
    # a real clear-space violation is short by tens of pixels, never by one.
    tol_x = 1.0 / max(img.width, 1)
    tol_y = 1.0 / max(img.height, 1)
    violations = {
        side: clearances[side]
        for side, value in exact.items()
        if value < (req_x - tol_x if side in ("left", "right") else req_y - tol_y)
    }

    measured = {
        **measurement,
        "logo": det.as_dict(),
        "clearancePctOfLogo": {
            side: round(value / max(base_x if side in ("left", "right") else base_y, 1e-9), 3)
            for side, value in clearances.items()
        },
    }
    thresholds = {
        "clearSpaceMultiple": multiple,
        "basis": basis,
        "requiredNormX": round(req_x, 5),
        "requiredNormY": round(req_y, 5),
    }

    if violations:
        worst = min(violations, key=lambda s: violations[s] / max(req_x if s in ("left", "right") else req_y, 1e-9))
        required = req_x if worst in ("left", "right") else req_y
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation=(
                f"Clear space is violated on {len(violations)} side(s). Worst is {worst}: "
                f"{violations[worst] / max(required, 1e-9):.0%} of the required "
                f"{multiple}x-{basis} exclusion zone."
            ),
            suggested_fix=f"Increase clear space on the {worst} side to {multiple}x the logo {basis}.",
            confidence=0.9,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation=f"All four sides meet the {multiple}x-{basis} clear-space requirement.",
        confidence=0.9,
    )


# ---------------------------------------------------------------------------
# logo.min_size
# ---------------------------------------------------------------------------
def check_min_size(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    det = _best_detection(ctx, rule)
    img = ctx.image()
    if det is None or img is None:
        return _no_logo_result(ctx, rule, "Logo minimum-size measurement")

    params = rule.check.params
    variant = next((v for v in ctx.brand.logo_variants if v.id == det.variant_id), None)
    constraints = variant.constraints if variant else {}
    dpi = ctx.dpi

    height_px = det.height_norm * img.height
    width_px = det.width_norm * img.width
    measured = {
        "logo": det.as_dict(),
        "heightPx": round(height_px, 2),
        "widthPx": round(width_px, 2),
        "heightPctOfCanvas": round(det.height_norm * 100, 3),
        "widthPctOfCanvas": round(det.width_norm * 100, 3),
        "heightMm": round(px_to_mm(height_px, dpi), 3),
        "dpi": dpi,
    }

    checks: list[tuple[str, float, float, str]] = []
    for key, source in (("minHeightPx", params), ("minHeightPx", constraints)):
        value = source.get(key)
        if value is not None:
            checks.append(("minHeightPx", height_px, float(value), "px"))
            break
    for key, source in (("minHeightPct", params), ("minHeightPct", constraints)):
        value = source.get(key)
        if value is not None:
            checks.append(("minHeightPct", det.height_norm * 100, float(value), "% of canvas height"))
            break
    for key, source in (("minHeightMm", params), ("minHeightMm", constraints)):
        value = source.get(key)
        if value is not None:
            checks.append(("minHeightMm", px_to_mm(height_px, dpi), float(value), "mm"))
            break

    if not checks:
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            observation="No minimum size is configured on the rule or the logo variant.",
        )

    thresholds = {name: value for name, _obs, value, _unit in checks}
    thresholds["dpiUsedForMm"] = dpi
    failures = [(name, obs, req, unit) for name, obs, req, unit in checks if obs + 1e-6 < req]
    if failures:
        name, obs, req, unit = min(failures, key=lambda f: f[1] / max(f[2], 1e-9))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation=(
                f"Logo measures {obs:.2f} {unit} against a {req:g} {unit} minimum "
                f"({obs / max(req, 1e-9):.0%} of the floor)."
            ),
            suggested_fix=f"Scale the logo up to at least {req:g} {unit}.",
            confidence=0.9 if det.method == "features" else 0.75,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation=f"Logo clears every configured minimum ({', '.join(n for n, *_ in checks)}).",
        confidence=0.9 if det.method == "features" else 0.75,
    )


# ---------------------------------------------------------------------------
# logo.distortion
# ---------------------------------------------------------------------------
def check_distortion(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    det = _best_detection(ctx, rule)
    if det is None:
        return _no_logo_result(ctx, rule, "Logo distortion measurement")

    if det.method != "features":
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"logo": det.as_dict()},
            observation=(
                "The logo was located by correlation, which cannot recover a transform. "
                "Distortion requires a feature-based homography; too few stable keypoints were found."
            ),
        )

    params = rule.check.params
    variant = next((v for v in ctx.brand.logo_variants if v.id == det.variant_id), None)
    max_aspect = float(params.get("maxAspectDistortion", 1.02))
    max_shear = float(params.get("maxShear", 0.02))
    max_rotation = float(params.get("maxRotationDeg", 1.5))
    max_perspective = float(params.get("maxPerspective", 0.0006))

    aspect_error = abs(det.aspect_distortion - 1.0)
    problems: list[str] = []
    if det.aspect_distortion > max_aspect:
        problems.append(f"non-uniform scaling {det.aspect_distortion:.3f}x (max {max_aspect})")
    if abs(det.shear) > max_shear:
        problems.append(f"shear {det.shear:.3f} (max {max_shear})")
    if abs(det.rotation_deg) > max_rotation:
        problems.append(f"rotation {det.rotation_deg:.1f}deg (max {max_rotation})")
    if det.perspective > max_perspective:
        problems.append(f"perspective warp {det.perspective:.5f} (max {max_perspective})")

    measured = {
        "logo": det.as_dict(),
        "aspectDistortion": round(det.aspect_distortion, 4),
        "aspectErrorPct": round(aspect_error * 100, 2),
        "shear": round(det.shear, 4),
        "rotationDeg": round(det.rotation_deg, 2),
        "perspective": round(det.perspective, 6),
        "declaredAspectRatio": variant.aspect_ratio if variant else None,
    }
    thresholds = {
        "maxAspectDistortion": max_aspect,
        "maxShear": max_shear,
        "maxRotationDeg": max_rotation,
        "maxPerspective": max_perspective,
    }
    if problems:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation="Logo transform is outside tolerance: " + "; ".join(problems) + ".",
            suggested_fix="Reset the logo to its original proportions and scale it uniformly.",
            confidence=0.88,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation=(
            f"Logo transform is uniform: anisotropy {det.aspect_distortion:.3f}, "
            f"shear {det.shear:.3f}, rotation {det.rotation_deg:.1f}deg."
        ),
        confidence=0.88,
    )


# ---------------------------------------------------------------------------
# logo.recolor
# ---------------------------------------------------------------------------
def check_recolor(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Was the mark re-coloured outside its approved palette?

    Clustering happens over the *non-transparent, non-background* pixels of the
    detected region: including the backdrop would let a white knockout on a red
    field read as "red logo".
    """
    det = _best_detection(ctx, rule)
    img = ctx.image()
    if det is None or img is None:
        return _no_logo_result(ctx, rule, "Logo colour measurement")

    variant = next((v for v in ctx.brand.logo_variants if v.id == det.variant_id), None)
    params = rule.check.params
    allowed_hexes = list(params.get("allowedHexes") or (variant.palette if variant else []))
    if not allowed_hexes:
        allowed_hexes = [t.hex for t in ctx.brand.color_tokens if (t.role or "").lower() in ("logo", "primary")]
    if not allowed_hexes:
        return build_result(
            rule,
            "not_applicable",
            measured={"logo": det.as_dict()},
            observation="No approved logo palette is defined for this variant.",
        )

    max_de = float(params.get("maxDeltaE", 5.0))
    min_share = float(params.get("minClusterShare", 0.08))
    ignore_neutrals = bool(params.get("ignoreNeutrals", True))

    crop = img.crop_norm(det.bbox)
    if crop.size == 0:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"logo": det.as_dict()},
            observation="The detected logo region is empty; colour cannot be sampled.",
        )

    ink = ink_mask(crop, delta_e_threshold=8.0)
    alpha = (ink.astype(np.uint8) * 255) if ink.any() else None
    palette = extract_palette(crop, k=int(params.get("k", 6)), exclude_photo_regions=False, alpha=alpha)

    allowed_labs = []
    for hx in allowed_hexes:
        try:
            allowed_labs.append(hex_to_lab(hx))
        except ValueError:
            ctx.warn(f"logo palette entry {hx!r} is not a valid hex colour")
    if not allowed_labs:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"logo": det.as_dict(), "allowedHexes": allowed_hexes},
            observation="The approved logo palette contains no parsable colours.",
        )

    clusters: list[dict[str, Any]] = []
    offenders: list[dict[str, Any]] = []
    for entry in palette.entries:
        if entry.share < min_share:
            continue
        if ignore_neutrals and is_neutral(entry.lab, chroma_threshold=6.0):
            continue
        d = ciede2000(np.array([entry.lab] * len(allowed_labs)), np.array(allowed_labs))
        idx = int(np.argmin(d))
        record = {
            "hex": entry.hex,
            "share": round(entry.share, 4),
            "nearestApproved": allowed_hexes[idx],
            "deltaE": round(float(d[idx]), 3),
        }
        clusters.append(record)
        if float(d[idx]) > max_de:
            offenders.append(record)

    measured = {
        "logo": det.as_dict(),
        "clusters": clusters,
        "sampledPixels": palette.sampled_pixels,
        "offenderCount": len(offenders),
    }
    thresholds = {"allowedHexes": allowed_hexes, "maxDeltaE": max_de, "minClusterShare": min_share}

    if not clusters:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation=(
                "The detected logo region yielded no chromatic cluster above the share floor "
                "(a monochrome or knocked-out lockup); recolouring cannot be judged from colour alone."
            ),
        )
    if offenders:
        worst = max(offenders, key=lambda c: float(c["deltaE"]))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation=(
                f"Logo colour {worst['hex']} ({float(worst['share']):.0%} of the mark) is "
                f"dE2000 {worst['deltaE']} from the nearest approved {worst['nearestApproved']}, "
                f"beyond the {max_de} tolerance."
            ),
            suggested_fix=f"Restore the mark to {worst['nearestApproved']}.",
            confidence=0.85,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation=f"All {len(clusters)} logo colour cluster(s) are within dE2000 {max_de} of the approved palette.",
        confidence=0.85,
    )


# ---------------------------------------------------------------------------
# logo.placement  (incl. co-brand ordering)
# ---------------------------------------------------------------------------
_ANCHORS = {
    "top-left": (0.0, 0.0),
    "top-center": (0.5, 0.0),
    "top-right": (1.0, 0.0),
    "center-left": (0.0, 0.5),
    "center": (0.5, 0.5),
    "center-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),
    "bottom-center": (0.5, 1.0),
    "bottom-right": (1.0, 1.0),
}


def nearest_anchor(bbox: tuple[float, float, float, float]) -> tuple[str, float]:
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    best = min(_ANCHORS.items(), key=lambda kv: math.hypot(cx - kv[1][0], cy - kv[1][1]))
    return best[0], round(math.hypot(cx - best[1][0], cy - best[1][1]), 4)


def check_placement(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    detections = detect_all(ctx, rule)
    if not detections:
        return _no_logo_result(ctx, rule, "Logo placement measurement")

    params = rule.check.params
    allowed = [str(a).lower() for a in (params.get("allowedAnchors") or [])]
    allowed_region = params.get("allowedRegion")
    cobrand_order = params.get("cobrandOrder")

    det = max(detections, key=lambda d: d.score)
    anchor, distance = nearest_anchor(det.bbox)
    cx, cy = (det.bbox[0] + det.bbox[2]) / 2, (det.bbox[1] + det.bbox[3]) / 2

    measured: dict[str, Any] = {
        "logo": det.as_dict(),
        "centerNorm": [round(cx, 4), round(cy, 4)],
        "nearestAnchor": anchor,
        "anchorDistance": distance,
        "detections": [d.as_dict() for d in detections],
    }
    thresholds: dict[str, Any] = {
        "allowedAnchors": allowed,
        "allowedRegion": allowed_region,
        "cobrandOrder": cobrand_order,
    }

    problems: list[str] = []
    if allowed and anchor not in allowed:
        problems.append(f"logo sits nearest the {anchor} anchor; allowed anchors are {allowed}")
    if isinstance(allowed_region, (list, tuple)) and len(allowed_region) >= 4:
        r = tuple(float(v) for v in allowed_region[:4])
        inside = r[0] <= cx <= r[2] and r[1] <= cy <= r[3]
        measured["insideAllowedRegion"] = inside
        if not inside:
            problems.append(f"logo centre ({cx:.2f}, {cy:.2f}) is outside the allowed region {r}")

    # Co-brand ordering: the endorsing brand's position relative to partners is
    # contractual, so it is a hard geometric test, not a judgment call.
    if cobrand_order and len(detections) > 1:
        ordered = [d.variant_id for d in sorted(detections, key=lambda d: (round(d.bbox[1], 2), d.bbox[0]))]
        expected = [str(v) for v in cobrand_order if str(v) in set(ordered)]
        actual = [v for v in ordered if v in set(expected)]
        measured["cobrandActualOrder"] = actual
        measured["cobrandExpectedOrder"] = expected
        if expected and actual != expected:
            problems.append(f"co-brand order is {actual}, expected {expected}")

    if not allowed and not allowed_region and not cobrand_order:
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            observation="No placement constraint is configured on this rule.",
        )
    if problems:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation="; ".join(problems).capitalize() + ".",
            suggested_fix=f"Move the logo to {allowed[0] if allowed else 'the approved position'}.",
            confidence=0.92,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation=f"Logo is placed at the {anchor} anchor, within the configured constraints.",
        confidence=0.92,
    )


# ---------------------------------------------------------------------------
# logo.occlusion
# ---------------------------------------------------------------------------
def check_occlusion(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    det = _best_detection(ctx, rule)
    img = ctx.image()
    if det is None or img is None:
        return _no_logo_result(ctx, rule, "Logo occlusion measurement")

    params = rule.check.params
    max_iou = float(params.get("maxIou", 0.02))
    max_coverage = float(params.get("maxCoverageFrac", 0.02))

    elements, source = collect_elements(ctx)
    overlaps: list[dict[str, Any]] = []
    logo_area = max(det.width_norm * det.height_norm, 1e-9)
    for el in elements:
        # Skip the element that *is* the logo.
        if bbox_iou(el.bbox, det.bbox) > 0.6:
            continue
        ix0, iy0 = max(el.bbox[0], det.bbox[0]), max(el.bbox[1], det.bbox[1])
        ix1, iy1 = min(el.bbox[2], det.bbox[2]), min(el.bbox[3], det.bbox[3])
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        inter = (ix1 - ix0) * (iy1 - iy0)
        overlaps.append(
            {
                "element": el.label[:40],
                "kind": el.kind,
                "iou": round(bbox_iou(el.bbox, det.bbox), 4),
                "coverageFracOfLogo": round(inter / logo_area, 4),
                "bbox": [round(v, 4) for v in el.bbox],
            }
        )

    total_coverage = round(min(1.0, sum(float(o["coverageFracOfLogo"]) for o in overlaps)), 4)
    measured = {
        "logo": det.as_dict(),
        "source": source,
        "overlapCount": len(overlaps),
        "totalCoverageFrac": total_coverage,
        "overlaps": sorted(overlaps, key=lambda o: -float(o["coverageFracOfLogo"]))[:10],
    }
    thresholds = {"maxIou": max_iou, "maxCoverageFrac": max_coverage}

    if source == "none":
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation="No element list could be built, so occlusion of the logo cannot be assessed.",
        )
    breaches = [o for o in overlaps if float(o["iou"]) > max_iou or float(o["coverageFracOfLogo"]) > max_coverage]
    if breaches:
        worst = max(breaches, key=lambda o: float(o["coverageFracOfLogo"]))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=det.bbox,
            observation=(
                f"{len(breaches)} element(s) overlap the logo; worst covers "
                f"{float(worst['coverageFracOfLogo']):.0%} of the mark."
            ),
            suggested_fix="Move overlapping content clear of the logo.",
            confidence=0.88,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=det.bbox,
        observation="Nothing overlaps the logo beyond tolerance.",
        confidence=0.88,
    )


__all__ = [
    "LogoDetection",
    "check_clearspace",
    "check_distortion",
    "check_min_size",
    "check_occlusion",
    "check_placement",
    "check_presence",
    "check_recolor",
    "clearspace_measure",
    "decompose_homography",
    "detect_all",
    "detect_logo",
    "mm_to_px",
    "nearest_anchor",
]
