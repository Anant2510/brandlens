"""WCAG 2.x contrast, measured locally per glyph.

Two decisions worth defending:

1. **Local background, not page background.** Text sits on hero images,
   gradients and duotones far more often than on a flat fill. Averaging the
   whole backdrop produces a comfortable ratio that no human ever experiences.
   We dilate the glyph mask, sample the annulus immediately around the strokes,
   and cluster that ring into fg/bg.

2. **Worst case, not average.** Accessibility is a floor, not an expectation:
   one illegible word in a headline is a failed headline. We report the minimum
   ratio across sampled glyph runs and cite the offending run's bbox, so the
   designer fixes the specific word rather than nudging a global average.

APCA (WCAG 3 draft) Lc is computed as an *advisory* signal only. It models thin
light-on-dark text far better than WCAG 2 does, but it is not normative and no
regulator accepts it yet, so it never drives a verdict.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .color import parse_hex, srgb_to_linear

FloatArray = NDArray[np.float64]


# ---------------------------------------------------------------------------
# WCAG 2.x
# ---------------------------------------------------------------------------
def relative_luminance(rgb: tuple[float, float, float] | NDArray[np.floating]) -> float:
    """WCAG 2.x relative luminance for an 0..255 sRGB triple."""
    lin = srgb_to_linear(np.asarray(rgb, dtype=np.float64)[:3] / 255.0)
    return float(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2])


def contrast_ratio(
    fg: tuple[float, float, float] | NDArray[np.floating],
    bg: tuple[float, float, float] | NDArray[np.floating],
) -> float:
    """(L_lighter + 0.05) / (L_darker + 0.05); range 1.0 .. 21.0."""
    l1 = relative_luminance(fg)
    l2 = relative_luminance(bg)
    hi, lo = (l1, l2) if l1 >= l2 else (l2, l1)
    return (hi + 0.05) / (lo + 0.05)


def contrast_ratio_hex(fg_hex: str, bg_hex: str) -> float:
    return contrast_ratio(parse_hex(fg_hex), parse_hex(bg_hex))


def wcag_threshold(font_size_pt: float, bold: bool = False, level: str = "AA") -> float:
    """WCAG 1.4.3/1.4.6 thresholds. "Large" is >=18pt, or >=14pt bold."""
    large = font_size_pt >= 18.0 or (bold and font_size_pt >= 14.0)
    if level.upper() == "AAA":
        return 4.5 if large else 7.0
    return 3.0 if large else 4.5


# ---------------------------------------------------------------------------
# APCA (advisory)
# ---------------------------------------------------------------------------
_APCA_S_TRC = 2.4
_APCA_N_BG = 0.56
_APCA_N_TXT = 0.57
_APCA_R_BG = 0.65
_APCA_R_TXT = 0.62
_APCA_SCALE_BOW = 1.14
_APCA_SCALE_WOB = 1.14
_APCA_LO_CLIP = 0.1
_APCA_LO_OFFSET = 0.027
_APCA_BLK_THRS = 0.022
_APCA_BLK_CLMP = 1.414


def _apca_y(rgb: NDArray[np.floating]) -> float:
    c = np.asarray(rgb, dtype=np.float64)[:3] / 255.0
    y = float(0.2126729 * c[0] ** _APCA_S_TRC + 0.7151522 * c[1] ** _APCA_S_TRC + 0.0721750 * c[2] ** _APCA_S_TRC)
    return y if y >= _APCA_BLK_THRS else y + (_APCA_BLK_THRS - y) ** _APCA_BLK_CLMP


def apca_lc(
    text_rgb: tuple[float, float, float] | NDArray[np.floating],
    bg_rgb: tuple[float, float, float] | NDArray[np.floating],
) -> float:
    """APCA lightness contrast Lc. Sign encodes polarity (negative = light on dark)."""
    y_txt = _apca_y(np.asarray(text_rgb, dtype=np.float64))
    y_bg = _apca_y(np.asarray(bg_rgb, dtype=np.float64))
    if abs(y_bg - y_txt) < 0.0005:
        return 0.0
    if y_bg > y_txt:  # black on white
        s = (y_bg**_APCA_N_BG - y_txt**_APCA_N_TXT) * _APCA_SCALE_BOW
        out = 0.0 if s < _APCA_LO_CLIP else s - _APCA_LO_OFFSET
    else:  # white on black
        s = (y_bg**_APCA_R_BG - y_txt**_APCA_R_TXT) * _APCA_SCALE_WOB
        out = 0.0 if s > -_APCA_LO_CLIP else s + _APCA_LO_OFFSET
    return round(out * 100.0, 2)


# ---------------------------------------------------------------------------
# Local sampling
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class LocalContrast:
    ratio: float
    fg_rgb: tuple[int, int, int]
    bg_rgb: tuple[int, int, int]
    #: Fraction of ring pixels assigned to the background cluster. Very low
    #: values mean the ring was mostly ink — the estimate is unreliable.
    bg_support: float
    apca_lc: float
    #: (x0,y0,x1,y1) in pixels, of the region measured.
    box_px: tuple[int, int, int, int]
    reliable: bool = True
    note: str | None = None


def _dilate(mask: NDArray[np.bool_], radius: int) -> NDArray[np.bool_]:
    """Binary dilation without a SciPy/OpenCV round trip (mask is tiny)."""
    out = mask.copy()
    for _ in range(max(0, radius)):
        p = np.pad(out, 1, mode="constant", constant_values=False)
        out = (
            p[1:-1, 1:-1]
            | p[:-2, 1:-1]
            | p[2:, 1:-1]
            | p[1:-1, :-2]
            | p[1:-1, 2:]
            | p[:-2, :-2]
            | p[:-2, 2:]
            | p[2:, :-2]
            | p[2:, 2:]
        )
    return out


def glyph_mask_from_region(region: NDArray[np.uint8]) -> NDArray[np.bool_]:
    """Otsu split of a text crop into ink vs paper; ink is the minority class.

    Assuming ink is the minority is safe for text — a glyph run that covers more
    than half its own bbox is not text, it is a filled shape.
    """
    a = np.asarray(region, dtype=np.float64)
    if a.ndim == 3:
        gray = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722])
    else:
        gray = a
    if gray.size == 0:
        return np.zeros(gray.shape, dtype=bool)

    hist, edges = np.histogram(gray, bins=64, range=(0.0, 255.0))
    total = hist.sum()
    if total == 0:
        return np.zeros(gray.shape, dtype=bool)
    centers = 0.5 * (edges[:-1] + edges[1:])
    w0 = np.cumsum(hist) / total
    m_total = float((hist * centers).sum() / total)
    m0 = np.cumsum(hist * centers) / total
    with np.errstate(divide="ignore", invalid="ignore"):
        between = ((m_total * w0 - m0) ** 2) / (w0 * (1.0 - w0))
    between = np.nan_to_num(between, nan=-1.0, posinf=-1.0, neginf=-1.0)
    thr = float(centers[int(np.argmax(between))])

    dark = gray <= thr
    return dark if dark.mean() <= 0.5 else ~dark


def measure_local_contrast(
    rgb: NDArray[np.uint8],
    box_px: tuple[int, int, int, int],
    ring_radius: int = 3,
    pad: int | None = None,
) -> LocalContrast:
    """Contrast of one text run against the background immediately around it.

    The ink/paper split is computed on the *tight* run box and only then dilated
    into the padded surround. Thresholding the padded region instead would let
    whatever happens to sit just outside the run — a dark panel edge, the next
    element — become the "ink", and the reported ratio would describe a
    boundary the reader never looks at.
    """
    h, w = rgb.shape[:2]
    tx0, ty0, tx1, ty1 = (int(v) for v in box_px)
    tx0, ty0 = max(0, tx0), max(0, ty0)
    tx1, ty1 = min(w, tx1), min(h, ty1)
    if tx1 <= tx0 or ty1 <= ty0:
        return LocalContrast(1.0, (0, 0, 0), (0, 0, 0), 0.0, 0.0, (tx0, ty0, tx1, ty1), False, "empty region")

    # Padding scales with the run's own height: a 12px caption needs 3px of
    # surround, a 120px headline needs 30.
    effective_pad = pad if pad is not None else max(2, min(24, int(round((ty1 - ty0) * 0.25))))
    x0 = max(0, tx0 - effective_pad)
    y0 = max(0, ty0 - effective_pad)
    x1 = min(w, tx1 + effective_pad)
    y1 = min(h, ty1 + effective_pad)

    region = np.asarray(rgb[y0:y1, x0:x1, :3], dtype=np.uint8)
    tight = np.asarray(rgb[ty0:ty1, tx0:tx1, :3], dtype=np.uint8)
    tight_ink = glyph_mask_from_region(tight)

    ink = np.zeros(region.shape[:2], dtype=bool)
    ink[ty0 - y0 : ty0 - y0 + tight_ink.shape[0], tx0 - x0 : tx0 - x0 + tight_ink.shape[1]] = tight_ink

    if not ink.any() or ink.all():
        flat = region.reshape(-1, 3).mean(axis=0)
        return LocalContrast(
            1.0,
            tuple(int(v) for v in flat),  # type: ignore[arg-type]
            tuple(int(v) for v in flat),  # type: ignore[arg-type]
            0.0,
            0.0,
            (x0, y0, x1, y1),
            False,
            "no glyph/background separation in region",
        )

    # The ring is the dilated mask minus the ink itself: the pixels a reader's
    # eye actually contrasts the stroke against.
    ring = _dilate(ink, ring_radius) & ~_dilate(ink, 1)
    if ring.sum() < 8:
        ring = ~ink

    fg = region[ink].astype(np.float64)
    bg = region[ring].astype(np.float64)
    if bg.size == 0:
        bg = region[~ink].astype(np.float64)

    # Anti-aliased edge pixels sit between fg and bg and would flatter the
    # ratio; take robust extremes by luminance instead of plain means.
    fg_lum = fg @ np.array([0.2126, 0.7152, 0.0722])
    bg_lum = bg @ np.array([0.2126, 0.7152, 0.0722])
    if float(np.median(fg_lum)) <= float(np.median(bg_lum)):
        fg_c = fg[fg_lum <= np.percentile(fg_lum, 35)].mean(axis=0)
        bg_c = bg[bg_lum >= np.percentile(bg_lum, 65)].mean(axis=0)
    else:
        fg_c = fg[fg_lum >= np.percentile(fg_lum, 65)].mean(axis=0)
        bg_c = bg[bg_lum <= np.percentile(bg_lum, 35)].mean(axis=0)

    fg_t = tuple(int(round(float(v))) for v in fg_c)
    bg_t = tuple(int(round(float(v))) for v in bg_c)
    support = float(ring.sum()) / float(ring.size)
    return LocalContrast(
        ratio=round(contrast_ratio(fg_c, bg_c), 4),
        fg_rgb=fg_t,  # type: ignore[arg-type]
        bg_rgb=bg_t,  # type: ignore[arg-type]
        bg_support=round(support, 4),
        apca_lc=apca_lc(fg_c, bg_c),
        box_px=(x0, y0, x1, y1),
        reliable=support > 0.02,
        note=None if support > 0.02 else "background ring too small to sample confidently",
    )


def worst_case(measurements: list[LocalContrast]) -> LocalContrast | None:
    """The floor across runs. Unreliable estimates are preferred *last* so a
    bad sample never becomes the headline number when a good one exists."""
    if not measurements:
        return None
    reliable = [m for m in measurements if m.reliable]
    pool = reliable or measurements
    return min(pool, key=lambda m: m.ratio)


def contrast_grid(rgb: NDArray[np.uint8], cells: int = 8) -> list[list[float]]:
    """Coarse luminance map, used to reason about where text *could* legibly go."""
    h, w = rgb.shape[:2]
    a = np.asarray(rgb, dtype=np.float64)[..., :3]
    out: list[list[float]] = []
    for gy in range(cells):
        row: list[float] = []
        for gx in range(cells):
            y0, y1 = int(gy * h / cells), int((gy + 1) * h / cells)
            x0, x1 = int(gx * w / cells), int((gx + 1) * w / cells)
            tile = a[y0:y1, x0:x1].reshape(-1, 3)
            row.append(round(relative_luminance(tile.mean(axis=0)) if tile.size else 0.0, 5))
        out.append(row)
    return out


def points_to_px(pt: float, dpi: float = 96.0) -> float:
    return pt * dpi / 72.0


def px_to_points(px: float, dpi: float = 96.0) -> float:
    return px * 72.0 / max(dpi, 1e-6)


def mm_to_px(mm: float, dpi: float) -> float:
    return mm / 25.4 * dpi


def px_to_mm(px: float, dpi: float) -> float:
    return px * 25.4 / max(dpi, 1e-6)


def ratio_gap(measured: float, required: float) -> float:
    """How far short we are, in ratio units. Negative means passing."""
    return round(required - measured, 4) if not math.isnan(measured) else math.inf


__all__ = [
    "LocalContrast",
    "apca_lc",
    "contrast_grid",
    "contrast_ratio",
    "contrast_ratio_hex",
    "glyph_mask_from_region",
    "measure_local_contrast",
    "mm_to_px",
    "points_to_px",
    "px_to_mm",
    "px_to_points",
    "ratio_gap",
    "relative_luminance",
    "wcag_threshold",
    "worst_case",
]
