"""Layout geometry: ink extent, margins, safe zones, grid residuals, overlap.

The element list comes from the structured source when there is one and from
connected components of the ink mask when there is not. Both produce the same
normalized boxes, so `layout.*` findings read identically whether the asset was
a Figma frame or a JPEG somebody exported to Instagram.

`layout.text_density` is the one analyzer here that is *advisory by
construction*: the 5x5 20%-per-cell heuristic is a legacy ad-platform rule of
thumb, not a brand rule and not a real legibility model. It is reported as a
number with a warning attached, never as a blocker.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import numpy as np
from numpy.typing import NDArray

from .channel_spec import resolve_spec, safe_zone_rects
from .color import rgb_to_lab
from .media import bbox_iou
from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

ElementKind = Literal["text", "shape", "image", "ink"]


@dataclass(slots=True)
class LayoutElement:
    bbox: tuple[float, float, float, float]
    kind: ElementKind
    label: str = ""
    area: float = 0.0

    def __post_init__(self) -> None:
        self.area = max(0.0, self.bbox[2] - self.bbox[0]) * max(0.0, self.bbox[3] - self.bbox[1])


# ---------------------------------------------------------------------------
# Ink extraction
# ---------------------------------------------------------------------------
def background_color(rgb: NDArray[np.uint8], border: int = 4) -> NDArray[np.float64]:
    """Median of the outer frame. The median resists a logo that touches the edge."""
    a = np.asarray(rgb, dtype=np.float64)[..., :3]
    h, w = a.shape[:2]
    b = max(1, min(border, h // 2, w // 2))
    ring = np.concatenate(
        [
            a[:b, :, :].reshape(-1, 3),
            a[-b:, :, :].reshape(-1, 3),
            a[:, :b, :].reshape(-1, 3),
            a[:, -b:, :].reshape(-1, 3),
        ]
    )
    return np.median(ring, axis=0) if ring.size else np.array([255.0, 255.0, 255.0])


def ink_mask(rgb: NDArray[np.uint8], delta_e_threshold: float = 6.0) -> NDArray[np.bool_]:
    """Pixels perceptibly different from the background.

    Threshold in dE2000-ish Lab distance rather than RGB: a 6-unit RGB step is
    invisible on a light background and obvious on a dark one, which would make
    the measured margin depend on the artwork's brightness.
    """
    a = np.asarray(rgb, dtype=np.float64)[..., :3]
    h, w = a.shape[:2]
    if h == 0 or w == 0:
        return np.zeros((h, w), dtype=bool)
    bg_lab = rgb_to_lab(background_color(a.astype(np.uint8)))
    # Downsample large canvases: margin precision beyond ~1500px is noise.
    step = max(1, int(max(h, w) / 1500))
    small = a[::step, ::step]
    lab = rgb_to_lab(small.reshape(-1, 3)).reshape(small.shape[0], small.shape[1], 3)
    dist = np.sqrt(((lab - bg_lab) ** 2).sum(axis=-1))
    mask_small = dist > delta_e_threshold
    if step == 1:
        return mask_small
    mask = np.zeros((h, w), dtype=bool)
    ys = np.arange(h) // step
    xs = np.arange(w) // step
    ys = np.clip(ys, 0, mask_small.shape[0] - 1)
    xs = np.clip(xs, 0, mask_small.shape[1] - 1)
    mask[:, :] = mask_small[np.ix_(ys, xs)]
    return mask


def ink_bbox(rgb: NDArray[np.uint8], delta_e_threshold: float = 6.0) -> tuple[float, float, float, float] | None:
    """Normalized bbox of everything that is not background."""
    mask = ink_mask(rgb, delta_e_threshold)
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    h, w = mask.shape
    return (
        float(xs.min()) / w,
        float(ys.min()) / h,
        float(xs.max() + 1) / w,
        float(ys.max() + 1) / h,
    )


def connected_elements(
    rgb: NDArray[np.uint8], min_area_frac: float = 0.0008, max_elements: int = 60
) -> list[LayoutElement]:
    """Element boxes from connected components of the ink mask (pixel path)."""
    mask = ink_mask(rgb)
    if not mask.any():
        return []
    try:
        import cv2

        # Close first so a word's letters become one element rather than 30.
        h, w = mask.shape
        k = max(3, int(round(min(h, w) / 120)) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k * 2, k))
        closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
        count, labels, stats, _centroids = cv2.connectedComponentsWithStats(closed, connectivity=8)
    except Exception:  # noqa: BLE001 - fall back to a single ink box
        box = ink_bbox(rgb)
        return [LayoutElement(bbox=box, kind="ink", label="ink")] if box else []

    h, w = mask.shape
    total = float(h * w)
    out: list[LayoutElement] = []
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if area / total < min_area_frac:
            continue
        out.append(
            LayoutElement(
                bbox=(x / w, y / h, (x + bw) / w, (y + bh) / h),
                kind="ink",
                label=f"component-{i}",
            )
        )
    out.sort(key=lambda e: e.area, reverse=True)
    del labels
    return out[:max_elements]


def collect_elements(ctx: AnalysisContext, min_area_frac: float = 0.0008) -> tuple[list[LayoutElement], str]:
    """Structured elements when available, CV components otherwise."""
    doc = ctx.structured()
    if doc.available:
        page = doc.page(0)
        if page is not None:
            elements: list[LayoutElement] = []
            for t in page.text:
                if t.text.strip():
                    elements.append(LayoutElement(bbox=t.bbox, kind="text", label=t.text[:40]))
            for s in page.shapes:
                # Full-bleed background panels are not layout elements; they are
                # the canvas, and counting them makes every overlap test fail.
                if s.area_norm < 0.9:
                    elements.append(LayoutElement(bbox=s.bbox, kind="shape", label=s.kind))
            for im in page.images:
                elements.append(LayoutElement(bbox=im.bbox, kind="image", label=im.name or "image"))
            elements = [e for e in elements if e.area >= min_area_frac]
            if elements:
                return elements, doc.kind

    img = ctx.image()
    if img is None:
        return [], "none"
    return connected_elements(img.rgb, min_area_frac=min_area_frac), "pixels"


# ---------------------------------------------------------------------------
# layout.margins
# ---------------------------------------------------------------------------
def measure_margins(box: tuple[float, float, float, float]) -> dict[str, float]:
    return {
        "left": round(box[0], 5),
        "top": round(box[1], 5),
        "right": round(1.0 - box[2], 5),
        "bottom": round(1.0 - box[3], 5),
    }


def check_margins(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    img = ctx.image()
    if img is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Margin measurement needs a rasterisable asset; none could be loaded.",
            measured={"assetKind": ctx.asset.kind},
        )
    box = ink_bbox(img.rgb)
    if box is None:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="The canvas is uniform — no content edges to measure margins against.",
            measured={"inkPixels": 0},
        )

    params = rule.check.params
    min_pct = float(params.get("minMarginPct", params.get("minPct", 4.0))) / 100.0
    per_edge = {k: float(v) / 100.0 for k, v in (params.get("perEdgePct") or {}).items()}
    margins = measure_margins(box)
    violations = {
        edge: round(value, 5)
        for edge, value in margins.items()
        if value + 1e-9 < per_edge.get(edge, min_pct)
    }

    measured = {
        "marginsPct": {k: round(v * 100, 2) for k, v in margins.items()},
        "inkBBox": [round(v, 4) for v in box],
        "violations": {k: round(v * 100, 2) for k, v in violations.items()},
        "canvasPx": [img.width, img.height],
    }
    thresholds = {
        "minMarginPct": min_pct * 100,
        "perEdgePct": {k: v * 100 for k, v in per_edge.items()},
    }
    if violations:
        worst_edge = min(violations, key=lambda k: violations[k])
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=box,
            observation=(
                f"Content reaches within {violations[worst_edge] * 100:.2f}% of the {worst_edge} edge, "
                f"below the {per_edge.get(worst_edge, min_pct) * 100:.2f}% minimum."
            ),
            suggested_fix=f"Pull content in from the {worst_edge} edge.",
            confidence=0.97,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=box,
        observation="All four margins meet the minimum.",
        confidence=0.97,
    )


# ---------------------------------------------------------------------------
# layout.safe_zone
# ---------------------------------------------------------------------------
def check_safe_zone(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Nothing important may sit inside a reserved region.

    Safe zones are where the *channel* will put its own furniture — a TikTok
    caption bar, a CTV lower third, a print bleed. Content there is not merely
    ugly, it is invisible or trimmed off.
    """
    params = rule.check.params
    zones_param = params.get("zones") or params.get("safeZones")
    zone_source = "rule.params"
    if not zones_param:
        # The registry knows the real zones, and they are per placement and
        # asymmetric — TikTok's caption bar is 310px up from the bottom of a
        # 1920px canvas while its action rail is 120px in from the right. A
        # rule cannot carry those without pinning itself to one placement, so
        # the spec for whatever channel THIS asset declares is the right
        # source, and an `insetPct` on the rule is the fallback for a brand
        # whose placements are not in the registry.
        spec, spec_key = resolve_spec(ctx.brand.channel_spec, ctx.asset.channel, ctx.asset.asset_type)
        zones_param = safe_zone_rects(spec)
        zone_source = f"channelSpec[{spec_key}]"

    if not zones_param:
        inset = params.get("insetPct")
        if inset is None:
            return build_result(
                rule,
                "not_applicable",
                observation=(
                    "No safe zones are configured on this rule and none are published for this asset's "
                    "channel. Set `insetPct` for a uniform band, or add the placement to the channel spec "
                    "registry to get its real asymmetric zones."
                ),
                measured={"zones": 0, "zoneSource": "none"},
            )
        i = float(inset) / 100.0
        zone_source = "rule.params.insetPct"
        zones_param = [
            {"name": "edge-inset", "bbox": [0, 0, 1, i]},
            {"name": "edge-inset", "bbox": [0, 1 - i, 1, 1]},
            {"name": "edge-inset", "bbox": [0, 0, i, 1]},
            {"name": "edge-inset", "bbox": [1 - i, 0, 1, 1]},
        ]

    elements, source = collect_elements(ctx)
    if not elements:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="No layout elements could be located, so safe-zone intrusion cannot be assessed.",
            measured={"source": source, "elements": 0},
        )

    tolerance = float(params.get("intrusionToleranceFrac", 0.02))
    intrusions: list[dict[str, object]] = []
    for zone in zones_param:
        if not isinstance(zone, dict):
            continue
        zb = zone.get("bbox")
        if not isinstance(zb, (list, tuple)) or len(zb) < 4:
            continue
        zbox = tuple(float(v) for v in zb[:4])
        for el in elements:
            ix0, iy0 = max(el.bbox[0], zbox[0]), max(el.bbox[1], zbox[1])
            ix1, iy1 = min(el.bbox[2], zbox[2]), min(el.bbox[3], zbox[3])
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            overlap = (ix1 - ix0) * (iy1 - iy0)
            frac = overlap / max(el.area, 1e-9)
            if frac > tolerance:
                intrusions.append(
                    {
                        "zone": str(zone.get("name", "safe-zone")),
                        "element": el.label[:40],
                        "kind": el.kind,
                        "overlapFracOfElement": round(frac, 4),
                        "bbox": [round(v, 4) for v in el.bbox],
                    }
                )

    measured = {
        "source": source,
        "zoneSource": zone_source,
        "elementCount": len(elements),
        "intrusionCount": len(intrusions),
        "intrusions": sorted(intrusions, key=lambda i: -float(i["overlapFracOfElement"]))[:15],  # type: ignore[arg-type]
    }
    thresholds = {"zones": zones_param, "intrusionToleranceFrac": tolerance, "zoneSource": zone_source}
    if intrusions:
        worst = measured["intrusions"][0]  # type: ignore[index]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type,index]
            observation=(
                f"{len(intrusions)} element(s) intrude into a safe zone; worst is "
                f"{worst['element']!r} with {float(worst['overlapFracOfElement']):.0%} of its area "  # type: ignore[index]
                f"inside {worst['zone']!r}."  # type: ignore[index]
            ),
            suggested_fix="Move the flagged elements out of the reserved region.",
            confidence=0.95,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"No element intrudes into the {len(zones_param)} safe zone(s) from {zone_source}.",
        confidence=0.95,
    )


# ---------------------------------------------------------------------------
# layout.grid_alignment
# ---------------------------------------------------------------------------
def grid_lines(columns: int, margin: float, gutter: float) -> list[float]:
    """Normalized x positions of every column edge."""
    if columns <= 0:
        return [margin, 1.0 - margin]
    usable = max(1e-6, 1.0 - 2 * margin)
    col_w = (usable - gutter * (columns - 1)) / columns
    lines: list[float] = []
    x = margin
    for i in range(columns):
        lines.append(x)
        x += col_w
        lines.append(x)
        if i < columns - 1:
            x += gutter
    return lines


def check_grid_alignment(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Residual distance from each element edge to the nearest grid line."""
    params = rule.check.params
    columns = int(params.get("columns", 0) or 0)
    if columns <= 0:
        return build_result(
            rule,
            "not_applicable",
            observation="No column grid is configured on this rule.",
            measured={"columns": 0},
        )
    margin = float(params.get("marginPct", 5.0)) / 100.0
    gutter = float(params.get("gutterPct", 2.0)) / 100.0
    tolerance = float(params.get("tolerancePct", 1.0)) / 100.0
    max_off_ratio = float(params.get("maxOffGridRatio", 0.25))

    elements, source = collect_elements(ctx)
    if not elements:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="No layout elements could be located, so grid conformance cannot be assessed.",
            measured={"source": source, "elements": 0},
        )

    lines = grid_lines(columns, margin, gutter)
    residuals: list[float] = []
    off_grid: list[dict[str, object]] = []
    for el in elements:
        for edge_name, edge in (("left", el.bbox[0]), ("right", el.bbox[2])):
            r = min(abs(edge - g) for g in lines)
            residuals.append(r)
            if r > tolerance:
                off_grid.append(
                    {
                        "element": el.label[:40],
                        "edge": edge_name,
                        "residualPct": round(r * 100, 3),
                        "bbox": [round(v, 4) for v in el.bbox],
                    }
                )

    arr = np.asarray(residuals, dtype=np.float64)
    off_ratio = len(off_grid) / max(len(residuals), 1)
    measured = {
        "source": source,
        "elementCount": len(elements),
        "residualPct": {
            "p50": round(float(np.percentile(arr, 50)) * 100, 3),
            "p90": round(float(np.percentile(arr, 90)) * 100, 3),
            "max": round(float(arr.max()) * 100, 3),
        },
        "offGridEdgeRatio": round(off_ratio, 4),
        "offGrid": sorted(off_grid, key=lambda o: -float(o["residualPct"]))[:15],  # type: ignore[arg-type]
    }
    thresholds = {
        "columns": columns,
        "marginPct": margin * 100,
        "gutterPct": gutter * 100,
        "tolerancePct": tolerance * 100,
        "maxOffGridRatio": max_off_ratio,
    }
    if off_ratio > max_off_ratio:
        worst = measured["offGrid"][0]  # type: ignore[index]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type,index]
            observation=(
                f"{off_ratio:.0%} of element edges miss the {columns}-column grid "
                f"(ceiling {max_off_ratio:.0%}); worst residual {worst['residualPct']}% of canvas width."  # type: ignore[index]
            ),
            suggested_fix="Snap the flagged element edges to the nearest column line.",
            confidence=0.85,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=(
            f"{(1 - off_ratio):.0%} of element edges sit on the {columns}-column grid "
            f"(median residual {measured['residualPct']['p50']}%)."  # type: ignore[index]
        ),
        confidence=0.85,
    )


# ---------------------------------------------------------------------------
# layout.element_overlap
# ---------------------------------------------------------------------------
def check_element_overlap(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    params = rule.check.params
    max_iou = float(params.get("maxIou", 0.08))
    kinds = set(params.get("kinds") or ["text", "image", "shape", "ink"])

    elements, source = collect_elements(ctx)
    elements = [e for e in elements if e.kind in kinds]
    if len(elements) < 2:
        return build_result(
            rule,
            "not_applicable" if source != "none" else "insufficient_evidence",
            observation=f"Only {len(elements)} qualifying element(s); overlap needs at least two.",
            measured={"source": source, "elements": len(elements)},
        )

    pairs: list[dict[str, object]] = []
    for i in range(len(elements)):
        for j in range(i + 1, len(elements)):
            a, b = elements[i], elements[j]
            iou = bbox_iou(a.bbox, b.bbox)
            if iou > max_iou:
                # Containment is usually intentional (text inside its own panel);
                # report it separately so reviewers can weigh it differently.
                inter_w = min(a.bbox[2], b.bbox[2]) - max(a.bbox[0], b.bbox[0])
                inter_h = min(a.bbox[3], b.bbox[3]) - max(a.bbox[1], b.bbox[1])
                inter = max(0.0, inter_w) * max(0.0, inter_h)
                contained = inter >= 0.95 * min(a.area, b.area)
                pairs.append(
                    {
                        "a": a.label[:30],
                        "b": b.label[:30],
                        "kinds": [a.kind, b.kind],
                        "iou": round(iou, 4),
                        "containment": contained,
                        "bbox": [
                            round(min(a.bbox[0], b.bbox[0]), 4),
                            round(min(a.bbox[1], b.bbox[1]), 4),
                            round(max(a.bbox[2], b.bbox[2]), 4),
                            round(max(a.bbox[3], b.bbox[3]), 4),
                        ],
                    }
                )

    collisions = [p for p in pairs if not p["containment"]]
    measured = {
        "source": source,
        "elementCount": len(elements),
        "collisionCount": len(collisions),
        "containmentCount": len(pairs) - len(collisions),
        "worstPairs": sorted(pairs, key=lambda p: -float(p["iou"]))[:10],  # type: ignore[arg-type]
    }
    thresholds = {"maxIou": max_iou, "kinds": sorted(kinds)}
    if collisions:
        worst = max(collisions, key=lambda p: float(p["iou"]))  # type: ignore[arg-type]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type]
            observation=(
                f"{len(collisions)} element pair(s) overlap beyond IoU {max_iou}; worst is "
                f"{worst['a']!r} vs {worst['b']!r} at IoU {worst['iou']}."
            ),
            suggested_fix="Separate the colliding elements or reflow the layout.",
            confidence=0.9,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"No element pair overlaps beyond IoU {max_iou}.",
        confidence=0.9,
    )


# ---------------------------------------------------------------------------
# layout.text_density  (ADVISORY)
# ---------------------------------------------------------------------------
def text_density_grid(
    text_boxes: list[tuple[float, float, float, float]], cells: int = 5
) -> tuple[int, list[list[int]]]:
    """Legacy 5x5 ad-platform heuristic: count cells >=20% covered by text."""
    grid = [[0 for _ in range(cells)] for _ in range(cells)]
    occupied = 0
    for gy in range(cells):
        for gx in range(cells):
            cx0, cy0 = gx / cells, gy / cells
            cx1, cy1 = (gx + 1) / cells, (gy + 1) / cells
            cell_area = (cx1 - cx0) * (cy1 - cy0)
            covered = 0.0
            for b in text_boxes:
                ix0, iy0 = max(b[0], cx0), max(b[1], cy0)
                ix1, iy1 = min(b[2], cx1), min(b[3], cy1)
                if ix1 > ix0 and iy1 > iy0:
                    covered += (ix1 - ix0) * (iy1 - iy0)
            frac = min(1.0, covered / max(cell_area, 1e-9))
            if frac >= 0.2:
                grid[gy][gx] = 1
                occupied += 1
    return occupied, grid


def check_text_density(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Report the 5x5 text-cell count.

    Kept explicitly advisory: the original 20%-text rule was withdrawn by the
    platform that invented it, applies to one ad format, and has no bearing on
    brand compliance. It is reported because clients still ask for the number —
    and downgraded to `advisory` severity so it can never block a release.
    """
    params = rule.check.params
    cells = int(params.get("cells", 5))
    max_cells = int(params.get("maxOccupiedCells", 5))

    elements, source = collect_elements(ctx)
    text_boxes = [e.bbox for e in elements if e.kind in ("text", "ink")]
    if not text_boxes:
        return build_result(
            rule,
            "insufficient_evidence",
            severity="advisory",
            observation="No text elements were located, so the density heuristic has nothing to count.",
            measured={"source": source, "textElements": 0},
        )

    occupied, grid = text_density_grid(text_boxes, cells)
    total_frac = sum(
        max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1]) for b in text_boxes
    )
    measured = {
        "source": source,
        "occupiedCells": occupied,
        "gridCells": cells * cells,
        "grid": grid,
        "textAreaFraction": round(min(1.0, total_frac), 4),
        "heuristic": "legacy 5x5 / 20%-per-cell ad heuristic",
    }
    thresholds = {"maxOccupiedCells": max_cells, "cells": cells, "advisoryOnly": True}
    verdict = "fail" if occupied > max_cells else "pass"
    return build_result(
        rule,
        verdict,
        # Forced to advisory regardless of the rule's configured severity: this
        # heuristic is not evidence strong enough to block anyone's campaign.
        severity="advisory",
        measured=measured,
        threshold=thresholds,
        observation=(
            f"{occupied} of {cells * cells} grid cells are at least 20% text "
            f"(advisory heuristic; text covers {measured['textAreaFraction']:.1%} of the canvas)."
        ),
        suggested_fix="Reduce on-image copy if the placement is a legacy ad unit." if verdict == "fail" else None,
        confidence=0.6,
    )


# ---------------------------------------------------------------------------
# Crop rules (used by channel_spec + assemble)
# ---------------------------------------------------------------------------
def evaluate_crop(
    src_aspect: float, target_aspect: float, focal: tuple[float, float] = (0.5, 0.5)
) -> dict[str, float]:
    """How much of the source is lost re-cropping to a target aspect, and where."""
    if src_aspect <= 0 or target_aspect <= 0:
        return {"lossFraction": 1.0, "scale": 0.0, "cropAxis": 0.0}
    if math.isclose(src_aspect, target_aspect, rel_tol=1e-3):
        return {"lossFraction": 0.0, "scale": 1.0, "cropAxis": 0.0}
    if src_aspect > target_aspect:  # source is wider -> crop the sides
        keep = target_aspect / src_aspect
        axis = 0.0
    else:
        keep = src_aspect / target_aspect
        axis = 1.0
    fx, fy = focal
    off_center = abs((fx if axis == 0.0 else fy) - 0.5) * 2.0
    return {
        "lossFraction": round(1.0 - keep, 4),
        "scale": round(keep, 4),
        "cropAxis": axis,
        "focalOffCenter": round(off_center, 4),
    }


__all__ = [
    "LayoutElement",
    "background_color",
    "check_element_overlap",
    "check_grid_alignment",
    "check_margins",
    "check_safe_zone",
    "check_text_density",
    "collect_elements",
    "connected_elements",
    "evaluate_crop",
    "grid_lines",
    "ink_bbox",
    "ink_mask",
    "measure_margins",
    "text_density_grid",
]
