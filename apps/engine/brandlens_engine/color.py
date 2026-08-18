"""Colour science: sRGB <-> linear <-> XYZ <-> CIE L*a*b*, CIEDE2000, and
Lab-space palette extraction.

Why Lab and not RGB: brand tolerance is a *perceptual* question ("is this close
enough to our red that nobody notices?"). Euclidean distance in sRGB is not
perceptually uniform — the same numeric distance is invisible in one region of
the cube and glaring in another — so both the clustering and the tolerance test
happen in Lab with CIEDE2000, which is the only metric brand teams' own printers
and colour managers use.

CIEDE2000 here is the full CIE 142-2001 formulation including the hue-rotation
term for blues; the common `sqrt(dL^2+dC^2+dH^2)` CIE94 shortcut is NOT used
because it disagrees with the full formula by >1.5 dE in exactly the blue/violet
region where corporate palettes cluster.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np
from numpy.typing import NDArray

from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

Float = np.float64
FloatArray = NDArray[np.float64]

# D65, 2-degree standard observer — the reference white for sRGB.
D65_WHITE: tuple[float, float, float] = (95.047, 100.000, 108.883)

# sRGB (IEC 61966-2-1) primaries -> CIE XYZ, scaled to Y=100.
_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)

_LAB_EPS = 216.0 / 24389.0  # (6/29)^3
_LAB_KAPPA = 24389.0 / 27.0  # (29/3)^3


# ---------------------------------------------------------------------------
# hex / tuple helpers
# ---------------------------------------------------------------------------
def parse_hex(value: str) -> tuple[int, int, int]:
    """Accept `#RGB`, `#RRGGBB`, `RRGGBB`, `#RRGGBBAA` (alpha dropped)."""
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) == 8:
        s = s[:6]
    if len(s) != 6:
        raise ValueError(f"not a hex colour: {value!r}")
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ValueError(f"not a hex colour: {value!r}") from exc


def to_hex(rgb: tuple[float, float, float] | NDArray[np.floating]) -> str:
    r, g, b = (int(round(float(np.clip(c, 0, 255)))) for c in tuple(rgb)[:3])
    return f"#{r:02X}{g:02X}{b:02X}"


def safe_parse_hex(value: str) -> tuple[int, int, int] | None:
    try:
        return parse_hex(value)
    except (ValueError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# sRGB <-> linear <-> XYZ <-> Lab (vectorised, arrays of shape (..., 3))
# ---------------------------------------------------------------------------
def srgb_to_linear(srgb: FloatArray) -> FloatArray:
    """sRGB electro-optical transfer function. Input 0..1, output 0..1."""
    a = np.asarray(srgb, dtype=np.float64)
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: FloatArray) -> FloatArray:
    a = np.asarray(linear, dtype=np.float64)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(np.clip(a, 0, None), 1 / 2.4) - 0.055)


def rgb_to_xyz(rgb: FloatArray) -> FloatArray:
    """rgb in 0..255 -> XYZ scaled so Y of white == 100."""
    a = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = srgb_to_linear(a)
    return lin @ _RGB_TO_XYZ.T * 100.0


def xyz_to_rgb(xyz: FloatArray) -> FloatArray:
    a = np.asarray(xyz, dtype=np.float64) / 100.0
    lin = a @ _XYZ_TO_RGB.T
    return np.clip(linear_to_srgb(lin), 0.0, 1.0) * 255.0


def _f_lab(t: FloatArray) -> FloatArray:
    return np.where(t > _LAB_EPS, np.cbrt(t), (_LAB_KAPPA * t + 16.0) / 116.0)


def xyz_to_lab(xyz: FloatArray, white: tuple[float, float, float] = D65_WHITE) -> FloatArray:
    a = np.asarray(xyz, dtype=np.float64)
    wp = np.asarray(white, dtype=np.float64)
    fx, fy, fz = np.moveaxis(_f_lab(a / wp), -1, 0)
    return np.stack([116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], axis=-1)


def lab_to_xyz(lab: FloatArray, white: tuple[float, float, float] = D65_WHITE) -> FloatArray:
    a = np.asarray(lab, dtype=np.float64)
    L, aa, bb = np.moveaxis(a, -1, 0)
    fy = (L + 16.0) / 116.0
    fx = fy + aa / 500.0
    fz = fy - bb / 200.0

    def inv(f: FloatArray, is_y: bool = False) -> FloatArray:
        f3 = f**3
        if is_y:
            return np.where(L > _LAB_KAPPA * _LAB_EPS, f3, L / _LAB_KAPPA)
        return np.where(f3 > _LAB_EPS, f3, (116.0 * f - 16.0) / _LAB_KAPPA)

    xyz = np.stack([inv(fx), inv(fy, is_y=True), inv(fz)], axis=-1)
    return xyz * np.asarray(white, dtype=np.float64)


def rgb_to_lab(rgb: FloatArray) -> FloatArray:
    return xyz_to_lab(rgb_to_xyz(rgb))


def lab_to_rgb(lab: FloatArray) -> FloatArray:
    return xyz_to_rgb(lab_to_xyz(lab))


def hex_to_lab(value: str) -> tuple[float, float, float]:
    lab = rgb_to_lab(np.array(parse_hex(value), dtype=np.float64))
    return float(lab[0]), float(lab[1]), float(lab[2])


def lab_to_hex(lab: tuple[float, float, float]) -> str:
    return to_hex(lab_to_rgb(np.asarray(lab, dtype=np.float64)))


# ---------------------------------------------------------------------------
# CIEDE2000
# ---------------------------------------------------------------------------
def ciede2000(
    lab1: FloatArray,
    lab2: FloatArray,
    k_l: float = 1.0,
    k_c: float = 1.0,
    k_h: float = 1.0,
) -> FloatArray:
    """Full CIE 142-2001 colour difference. Broadcasts over leading axes.

    Implemented from the standard rather than borrowed from skimage so that the
    hue-difference branch cuts and the R_T rotation term are auditable — this
    number is what a brand team will argue about in a review meeting.
    """
    a1 = np.atleast_2d(np.asarray(lab1, dtype=np.float64))
    a2 = np.atleast_2d(np.asarray(lab2, dtype=np.float64))
    L1, A1, B1 = a1[..., 0], a1[..., 1], a1[..., 2]
    L2, A2, B2 = a2[..., 0], a2[..., 1], a2[..., 2]

    C1 = np.hypot(A1, B1)
    C2 = np.hypot(A2, B2)
    C_bar = 0.5 * (C1 + C2)

    # G compensates the a* axis so that near-neutral colours are not treated as
    # having meaningful hue.
    C_bar7 = C_bar**7
    G = 0.5 * (1.0 - np.sqrt(C_bar7 / (C_bar7 + 25.0**7)))

    a1p = (1.0 + G) * A1
    a2p = (1.0 + G) * A2
    C1p = np.hypot(a1p, B1)
    C2p = np.hypot(a2p, B2)

    def _hp(b: FloatArray, ap: FloatArray) -> FloatArray:
        # Undefined hue for achromatic samples must be 0, not atan2(0,0)'s 0
        # coincidence — make it explicit so the mean-hue branch below is right.
        h = np.degrees(np.arctan2(b, ap))
        h = np.where(h < 0, h + 360.0, h)
        return np.where((np.abs(b) < 1e-12) & (np.abs(ap) < 1e-12), 0.0, h)

    h1p = _hp(B1, a1p)
    h2p = _hp(B2, a2p)

    dLp = L2 - L1
    dCp = C2p - C1p

    chroma_zero = (C1p * C2p) == 0
    dhp = h2p - h1p
    dhp = np.where(dhp > 180.0, dhp - 360.0, dhp)
    dhp = np.where(dhp < -180.0, dhp + 360.0, dhp)
    dhp = np.where(chroma_zero, 0.0, dhp)
    dHp = 2.0 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp) / 2.0)

    Lp_bar = 0.5 * (L1 + L2)
    Cp_bar = 0.5 * (C1p + C2p)

    h_sum = h1p + h2p
    h_absdiff = np.abs(h1p - h2p)
    hp_bar = np.where(
        chroma_zero,
        h_sum,
        np.where(
            h_absdiff <= 180.0,
            0.5 * h_sum,
            np.where(h_sum < 360.0, 0.5 * (h_sum + 360.0), 0.5 * (h_sum - 360.0)),
        ),
    )

    T = (
        1.0
        - 0.17 * np.cos(np.radians(hp_bar - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * hp_bar))
        + 0.32 * np.cos(np.radians(3.0 * hp_bar + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * hp_bar - 63.0))
    )

    d_theta = 30.0 * np.exp(-(((hp_bar - 275.0) / 25.0) ** 2))
    Cp_bar7 = Cp_bar**7
    R_C = 2.0 * np.sqrt(Cp_bar7 / (Cp_bar7 + 25.0**7))
    # R_T is the blue-region rotation: without it, navy-vs-violet errors are
    # under-reported by roughly a full dE unit.
    R_T = -R_C * np.sin(np.radians(2.0 * d_theta))

    Lp_bar_m50_sq = (Lp_bar - 50.0) ** 2
    S_L = 1.0 + (0.015 * Lp_bar_m50_sq) / np.sqrt(20.0 + Lp_bar_m50_sq)
    S_C = 1.0 + 0.045 * Cp_bar
    S_H = 1.0 + 0.015 * Cp_bar * T

    term_L = dLp / (k_l * S_L)
    term_C = dCp / (k_c * S_C)
    term_H = dHp / (k_h * S_H)

    de = np.sqrt(term_L**2 + term_C**2 + term_H**2 + R_T * term_C * term_H)
    return np.asarray(de, dtype=np.float64)


def delta_e_hex(hex_a: str, hex_b: str) -> float:
    return float(ciede2000(np.array([hex_to_lab(hex_a)]), np.array([hex_to_lab(hex_b)]))[0])


def delta_e_lab(lab_a: tuple[float, float, float], lab_b: tuple[float, float, float]) -> float:
    return float(ciede2000(np.array([lab_a]), np.array([lab_b]))[0])


def nearest_token(
    lab: tuple[float, float, float], token_labs: list[tuple[float, float, float]]
) -> tuple[int, float]:
    """Index of the closest token and its dE2000. (-1, inf) when no tokens."""
    if not token_labs:
        return -1, math.inf
    d = ciede2000(np.array([lab] * len(token_labs)), np.array(token_labs))
    idx = int(np.argmin(d))
    return idx, float(d[idx])


# ---------------------------------------------------------------------------
# Palette extraction
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class PaletteEntry:
    hex: str
    lab: tuple[float, float, float]
    share: float
    pixel_count: int
    #: Cluster spread in Lab; a wide cluster means a gradient, not a flat fill.
    spread: float = 0.0


@dataclass(slots=True)
class PaletteResult:
    entries: list[PaletteEntry] = field(default_factory=list)
    sampled_pixels: int = 0
    excluded_photo_fraction: float = 0.0
    total_pixels: int = 0

    def flats(self, max_spread: float = 6.0) -> list[PaletteEntry]:
        """Entries tight enough in Lab to be a deliberate flat brand fill."""
        return [e for e in self.entries if e.spread <= max_spread]


def _kmeans_lab(samples: FloatArray, k: int, seed: int = 7, iters: int = 40) -> tuple[FloatArray, NDArray[np.int64]]:
    """k-means++ in Lab. Deterministic: the same bytes must always produce the
    same palette or measurement caching and audit replay both break."""
    rng = np.random.default_rng(seed)
    n = samples.shape[0]
    k = max(1, min(k, n))

    centers = np.empty((k, samples.shape[1]), dtype=np.float64)
    centers[0] = samples[rng.integers(0, n)]
    closest = np.sum((samples - centers[0]) ** 2, axis=1)
    for i in range(1, k):
        total = float(closest.sum())
        if total <= 0:
            centers[i] = samples[rng.integers(0, n)]
        else:
            centers[i] = samples[int(np.searchsorted(np.cumsum(closest / total), rng.random()))]
        closest = np.minimum(closest, np.sum((samples - centers[i]) ** 2, axis=1))

    labels = np.zeros(n, dtype=np.int64)
    for _ in range(iters):
        d = np.sum((samples[:, None, :] - centers[None, :, :]) ** 2, axis=2)
        new_labels = np.argmin(d, axis=1).astype(np.int64)
        if np.array_equal(new_labels, labels) and _ > 0:
            break
        labels = new_labels
        for i in range(k):
            m = labels == i
            if bool(m.any()):
                centers[i] = samples[m].mean(axis=0)
    return centers, labels


def photo_region_mask(rgb: NDArray[np.uint8], block: int = 16, edge_threshold: float = 0.06) -> NDArray[np.bool_]:
    """True where the image looks photographic rather than a flat brand fill.

    Palette conformance must not be judged against a photograph: a sunset in the
    hero image is not a palette violation. We flag blocks with high local
    gradient energy AND high local colour variance — flat vector art has neither,
    a gradient mesh has variance but low edge energy, a photo has both.
    """
    a = np.asarray(rgb, dtype=np.float64)
    if a.ndim != 3:
        return np.zeros(a.shape[:2], dtype=bool)
    h, w = a.shape[:2]
    gray = a @ np.array([0.2126, 0.7152, 0.0722])
    gy, gx = np.gradient(gray / 255.0)
    energy = np.hypot(gx, gy)

    mask = np.zeros((h, w), dtype=bool)
    for y0 in range(0, h, block):
        for x0 in range(0, w, block):
            tile_e = energy[y0 : y0 + block, x0 : x0 + block]
            tile_c = a[y0 : y0 + block, x0 : x0 + block]
            if tile_e.size == 0:
                continue
            if float(tile_e.mean()) > edge_threshold and float(tile_c.reshape(-1, 3).std(axis=0).mean()) > 8.0:
                mask[y0 : y0 + block, x0 : x0 + block] = True
    return mask


def extract_palette(
    rgb: NDArray[np.uint8],
    k: int = 8,
    max_samples: int = 20_000,
    exclude_photo_regions: bool = True,
    alpha: NDArray[np.uint8] | None = None,
    seed: int = 7,
) -> PaletteResult:
    """Lab k-means palette with photographic regions optionally excluded."""
    a = np.asarray(rgb)
    if a.ndim == 2:
        a = np.stack([a] * 3, axis=-1)
    a = a[..., :3]
    h, w = a.shape[:2]
    total = h * w
    if total == 0:
        return PaletteResult()

    keep = np.ones((h, w), dtype=bool)
    if alpha is not None:
        keep &= np.asarray(alpha) > 16
    photo_frac = 0.0
    if exclude_photo_regions:
        photo = photo_region_mask(a.astype(np.uint8))
        photo_frac = float(photo.mean())
        # If the asset is essentially all photograph there is nothing flat left
        # to test; keep everything and let the caller weigh `excluded_photo_fraction`.
        if photo_frac < 0.95:
            keep &= ~photo

    pixels = a[keep].reshape(-1, 3).astype(np.float64)
    if pixels.shape[0] == 0:
        return PaletteResult(sampled_pixels=0, excluded_photo_fraction=photo_frac, total_pixels=total)

    rng = np.random.default_rng(seed)
    if pixels.shape[0] > max_samples:
        idx = rng.choice(pixels.shape[0], size=max_samples, replace=False)
        pixels = pixels[idx]

    lab = rgb_to_lab(pixels)
    centers, labels = _kmeans_lab(lab, k=k, seed=seed)

    entries: list[PaletteEntry] = []
    n = lab.shape[0]
    for i in range(centers.shape[0]):
        m = labels == i
        count = int(m.sum())
        if count == 0:
            continue
        c = centers[i]
        spread = float(np.sqrt(((lab[m] - c) ** 2).sum(axis=1)).mean())
        entries.append(
            PaletteEntry(
                hex=lab_to_hex((float(c[0]), float(c[1]), float(c[2]))),
                lab=(float(c[0]), float(c[1]), float(c[2])),
                share=count / n,
                pixel_count=count,
                spread=spread,
            )
        )
    entries.sort(key=lambda e: e.share, reverse=True)
    return PaletteResult(
        entries=entries,
        sampled_pixels=n,
        excluded_photo_fraction=photo_frac,
        total_pixels=total,
    )


# ---------------------------------------------------------------------------
# Tint / shade segment test
# ---------------------------------------------------------------------------
def tint_shade_distance(
    sample_lab: tuple[float, float, float],
    token_lab: tuple[float, float, float],
    allowed_tints: list[float] | None = None,
) -> tuple[float, float | None]:
    """Distance to the legal tint/shade family of a token.

    Brand systems almost always permit "40% of brand blue on white". A naive
    dE-to-the-token test flags every one of those, so we test the sample against
    the *segment* from white through the token to black, returning the dE at the
    best point on that segment and the mix fraction that produced it.

    Both mixing models are evaluated and the nearer one wins, because real assets
    come from both worlds: CSS/Figma/Photoshop composite on the gamma-encoded
    values by default, while a physically-linear blend is what you get from
    correctly colour-managed print output. Testing only one produces false
    failures on roughly half of all legitimately-tinted artwork — the encoded
    and linear 40% stops of a saturated blue are more than 6 dE apart.

    When `allowed_tints` is given we only evaluate those discrete stops, because
    a brand that lists 20/40/60 does not thereby permit 37.
    """
    token_rgb = np.asarray(lab_to_rgb(np.asarray(token_lab, dtype=np.float64)), dtype=np.float64)
    token_srgb = token_rgb / 255.0
    token_lin = srgb_to_linear(token_srgb)

    if allowed_tints:
        fractions = sorted({float(t) for t in allowed_tints})
        fractions = [f / 100.0 if f > 1.0 else f for f in fractions]
    else:
        fractions = [i / 40.0 for i in range(41)]

    best_de = math.inf
    best_f: float | None = None
    for f in fractions:
        # f<=1 tints toward white; the shade half of the family is f in (1,2].
        if f <= 1.0:
            candidates = (
                np.clip(linear_to_srgb(token_lin * f + 1.0 * (1.0 - f)), 0, 1) * 255.0,
                np.clip(token_srgb * f + 1.0 * (1.0 - f), 0, 1) * 255.0,
            )
        else:
            candidates = (
                np.clip(linear_to_srgb(token_lin * (2.0 - f)), 0, 1) * 255.0,
                np.clip(token_srgb * (2.0 - f), 0, 1) * 255.0,
            )
        for mixed_rgb in candidates:
            mixed_lab = rgb_to_lab(mixed_rgb)
            de = delta_e_lab(sample_lab, (float(mixed_lab[0]), float(mixed_lab[1]), float(mixed_lab[2])))
            if de < best_de:
                best_de, best_f = de, f
    return best_de, best_f


def is_neutral(lab: tuple[float, float, float], chroma_threshold: float = 4.0) -> bool:
    """Near-greys are exempt from palette conformance: white paper, black text
    and 50% grey rules are ubiquitous and never listed as brand tokens."""
    return math.hypot(lab[1], lab[2]) <= chroma_threshold


# ---------------------------------------------------------------------------
# Analyzers
#
# These live beside the colour science on purpose: every threshold below is a
# dE2000 number, and keeping the metric and its consumers in one file makes the
# tolerance story auditable in a single read.
# ---------------------------------------------------------------------------
def _observed_colors(ctx: AnalysisContext, rule: RuleDefinition) -> tuple[list[dict[str, object]], str, dict[str, object]]:
    """Colours actually used, structured-first.

    A PDF states `fill #0B5FFF`; a JPEG only implies it after JPEG ringing,
    resampling and anti-aliasing have each shifted it a couple of dE. When the
    exact value is available we use it, and we say which path produced the
    number so a reviewer can weigh it.
    """
    params = rule.check.params
    doc = ctx.structured()
    meta: dict[str, object] = {}

    if doc.available and not params.get("forcePixels"):
        weights: dict[str, float] = {}
        for page in doc.pages:
            for shape in page.shapes:
                if shape.fill_hex and shape.area_norm > 0:
                    weights[shape.fill_hex.upper()] = weights.get(shape.fill_hex.upper(), 0.0) + shape.area_norm
            for el in page.text:
                if el.color_hex:
                    area = max(1e-6, (el.bbox[2] - el.bbox[0]) * (el.bbox[3] - el.bbox[1]))
                    weights[el.color_hex.upper()] = weights.get(el.color_hex.upper(), 0.0) + area
        total = sum(weights.values())
        if total > 0:
            out: list[dict[str, object]] = []
            for hx, weight in sorted(weights.items(), key=lambda kv: -kv[1]):
                lab = safe_parse_hex(hx)
                if lab is None:
                    continue
                out.append(
                    {
                        "hex": hx,
                        "lab": hex_to_lab(hx),
                        "share": weight / total,
                        "spread": 0.0,  # a declared fill is exact by definition
                    }
                )
            meta = {"declaredFills": len(out)}
            return out, doc.kind, meta

    img = ctx.image()
    if img is None:
        return [], "none", {}
    k = int(params.get("k", 8))
    exclude_photo = bool(params.get("excludePhotoRegions", True))

    def _compute() -> dict[str, object]:
        palette = extract_palette(img.rgb, k=k, exclude_photo_regions=exclude_photo, alpha=img.alpha)
        return {
            "entries": [
                {"hex": e.hex, "lab": list(e.lab), "share": e.share, "spread": e.spread}
                for e in palette.entries
            ],
            "excludedPhotoFraction": palette.excluded_photo_fraction,
            "sampledPixels": palette.sampled_pixels,
        }

    raw = ctx.measure("color.palette", {"k": k, "excludePhotoRegions": exclude_photo}, _compute)
    entries = [
        {"hex": e["hex"], "lab": tuple(e["lab"]), "share": e["share"], "spread": e["spread"]}
        for e in raw.get("entries", [])
    ]
    meta = {
        "excludedPhotoFraction": raw.get("excludedPhotoFraction"),
        "sampledPixels": raw.get("sampledPixels"),
    }
    return entries, "pixels", meta


def _token_labs(ctx: AnalysisContext) -> list[tuple[str, tuple[float, float, float], list[float] | None]]:
    out: list[tuple[str, tuple[float, float, float], list[float] | None]] = []
    for token in ctx.brand.color_tokens:
        lab = tuple(token.lab) if token.lab else None  # type: ignore[assignment]
        if lab is None:
            try:
                lab = hex_to_lab(token.hex)
            except ValueError:
                ctx.warn(f"colour token {token.path!r} has an invalid hex {token.hex!r}")
                continue
        out.append((token.hex.upper(), lab, token.allowed_tints))  # type: ignore[arg-type]
    return out


def check_palette_conformance(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    params = rule.check.params
    max_de = float(params.get("maxDeltaE", 3.0))
    min_share = float(params.get("minShare", 0.03))
    ignore_neutrals = bool(params.get("ignoreNeutrals", True))
    allow_tints = bool(params.get("allowTints", True))
    max_offending_share = float(params.get("maxOffendingShare", 0.05))
    max_spread = float(params.get("maxClusterSpread", 12.0))

    tokens = _token_labs(ctx)
    if not tokens:
        return build_result(
            rule,
            "not_applicable",
            observation="No colour tokens are defined for this brand.",
            measured={"tokens": 0},
        )

    observed, source, meta = _observed_colors(ctx, rule)
    if not observed:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="No colours could be sampled: the asset has neither a structured source nor loadable pixels.",
            measured={"source": source, **meta},
        )

    token_lab_list = [t[1] for t in tokens]
    conforming: list[dict[str, object]] = []
    offending: list[dict[str, object]] = []
    for entry in observed:
        share = float(entry["share"])
        lab = tuple(float(v) for v in entry["lab"])  # type: ignore[arg-type]
        if share < min_share:
            continue
        if ignore_neutrals and is_neutral(lab):  # type: ignore[arg-type]
            continue
        # A wide Lab cluster is a gradient or a photo region, not a flat fill;
        # judging it against a point token would be measuring the wrong thing.
        if float(entry.get("spread", 0.0)) > max_spread:
            continue

        idx, de = nearest_token(lab, token_lab_list)  # type: ignore[arg-type]
        record: dict[str, object] = {
            "hex": entry["hex"],
            "share": round(share, 4),
            "nearestToken": tokens[idx][0] if idx >= 0 else None,
            "deltaE": round(de, 3),
        }
        if de > max_de and allow_tints:
            best_tint_de, best_f = math.inf, None
            for token_hex, token_lab, tints in tokens:
                tint_de, f = tint_shade_distance(lab, token_lab, tints)  # type: ignore[arg-type]
                if tint_de < best_tint_de:
                    best_tint_de, best_f = tint_de, f
                    record["nearestTokenViaTint"] = token_hex
            record["tintDeltaE"] = round(best_tint_de, 3)
            record["tintFraction"] = round(best_f, 3) if best_f is not None else None
            if best_tint_de <= max_de:
                record["resolvedAs"] = "tint"
                conforming.append(record)
                continue
        if de <= max_de:
            record["resolvedAs"] = "token"
            conforming.append(record)
        else:
            offending.append(record)

    offending_share = round(sum(float(o["share"]) for o in offending), 4)
    measured = {
        "source": source,
        "conforming": conforming[:20],
        "offending": offending[:20],
        "offendingShare": offending_share,
        "evaluatedClusters": len(conforming) + len(offending),
        **meta,
    }
    thresholds = {
        "maxDeltaE": max_de,
        "minShare": min_share,
        "maxOffendingShare": max_offending_share,
        "allowTints": allow_tints,
        "ignoreNeutrals": ignore_neutrals,
        "tokens": [t[0] for t in tokens],
    }

    if not conforming and not offending:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation=(
                "Every sampled region was neutral, photographic or a gradient, so there is no flat "
                "brand fill to test against the palette."
            ),
        )
    if offending_share > max_offending_share:
        worst = max(offending, key=lambda o: float(o["share"]))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"{offending_share:.1%} of the measured area uses off-palette colour. Worst is "
                f"{worst['hex']} at {float(worst['share']):.1%}, dE2000 {worst['deltaE']} from "
                f"the nearest token {worst['nearestToken']}."
            ),
            suggested_fix=f"Replace {worst['hex']} with {worst['nearestToken']}.",
            confidence=0.95 if source != "pixels" else 0.85,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=(
            f"{len(conforming)} colour cluster(s) resolve to brand tokens within dE2000 {max_de}; "
            f"off-palette area is {offending_share:.1%}."
        ),
        confidence=0.95 if source != "pixels" else 0.85,
    )


def check_forbidden(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Colours the brand may not use — usually a competitor's equity colour."""
    params = rule.check.params
    max_de = float(params.get("maxDeltaE", 6.0))
    min_share = float(params.get("minShare", 0.02))

    forbidden = list(ctx.brand.forbidden_colors)
    extra = params.get("forbiddenHexes") or []
    labs: list[tuple[str, tuple[float, float, float], str | None]] = []
    for entry in forbidden:
        try:
            labs.append((entry.hex.upper(), hex_to_lab(entry.hex), entry.reason))
        except ValueError:
            ctx.warn(f"forbidden colour {entry.hex!r} is not valid hex")
    for hx in extra:
        try:
            labs.append((str(hx).upper(), hex_to_lab(str(hx)), None))
        except ValueError:
            ctx.warn(f"forbidden colour {hx!r} is not valid hex")

    if not labs:
        return build_result(
            rule,
            "not_applicable",
            observation="No forbidden colours are configured for this brand.",
            measured={"forbiddenColors": 0},
        )

    observed, source, meta = _observed_colors(ctx, rule)
    if not observed:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="No colours could be sampled from this asset.",
            measured={"source": source, **meta},
        )

    hits: list[dict[str, object]] = []
    closest = math.inf
    for entry in observed:
        share = float(entry["share"])
        if share < min_share:
            continue
        lab = tuple(float(v) for v in entry["lab"])  # type: ignore[arg-type]
        d = ciede2000(np.array([lab] * len(labs)), np.array([f[1] for f in labs]))
        idx = int(np.argmin(d))
        closest = min(closest, float(d[idx]))
        if float(d[idx]) <= max_de:
            hits.append(
                {
                    "hex": entry["hex"],
                    "share": round(share, 4),
                    "forbiddenHex": labs[idx][0],
                    "deltaE": round(float(d[idx]), 3),
                    "reason": labs[idx][2],
                }
            )

    measured = {
        "source": source,
        "hits": hits,
        "hitCount": len(hits),
        "closestDeltaE": round(closest, 3) if closest != math.inf else None,
        **meta,
    }
    thresholds = {"maxDeltaE": max_de, "minShare": min_share, "forbiddenHexes": [f[0] for f in labs]}
    if hits:
        worst = max(hits, key=lambda h: float(h["share"]))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"Forbidden colour {worst['forbiddenHex']} appears as {worst['hex']} over "
                f"{float(worst['share']):.1%} of the asset (dE2000 {worst['deltaE']})."
                + (f" Reason: {worst['reason']}." if worst["reason"] else "")
            ),
            suggested_fix="Remove or replace the forbidden colour.",
            confidence=0.95,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"No forbidden colour appears within dE2000 {max_de} (closest {measured['closestDeltaE']}).",
        confidence=0.95,
    )


def check_dominance_ratio(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Is the palette balanced the way the brand says it should be?

    Guidelines say things like "primary 60%, secondary 30%, accent 10%". This
    attributes measured area to the nearest token and compares the resulting
    role mix against the declared ratio.
    """
    params = rule.check.params
    max_de = float(params.get("maxDeltaE", 8.0))
    tolerance = float(params.get("tolerancePct", 15.0)) / 100.0
    target = params.get("roleRatios") or {}

    tokens = _token_labs(ctx)
    roles = {t.hex.upper(): (t.role or "unassigned").lower() for t in ctx.brand.color_tokens}
    if not tokens:
        return build_result(
            rule,
            "not_applicable",
            observation="No colour tokens are defined for this brand.",
            measured={"tokens": 0},
        )
    if not target:
        target = {
            role: value
            for role, value in (("primary", 0.6), ("secondary", 0.3), ("accent", 0.1))
            if role in set(roles.values())
        }
    if not target:
        return build_result(
            rule,
            "not_applicable",
            observation="No role ratios are configured and no token carries a role.",
            measured={"roles": sorted(set(roles.values()))},
        )

    observed, source, meta = _observed_colors(ctx, rule)
    if not observed:
        return build_result(
            rule,
            "insufficient_evidence",
            observation="No colours could be sampled from this asset.",
            measured={"source": source, **meta},
        )

    token_lab_list = [t[1] for t in tokens]
    by_role: dict[str, float] = {}
    unattributed = 0.0
    for entry in observed:
        share = float(entry["share"])
        lab = tuple(float(v) for v in entry["lab"])  # type: ignore[arg-type]
        if is_neutral(lab):  # type: ignore[arg-type]
            continue
        idx, de = nearest_token(lab, token_lab_list)  # type: ignore[arg-type]
        if idx < 0 or de > max_de:
            unattributed += share
            continue
        role = roles.get(tokens[idx][0], "unassigned")
        by_role[role] = by_role.get(role, 0.0) + share

    branded_total = sum(by_role.values())
    normalized = {r: round(v / branded_total, 4) for r, v in by_role.items()} if branded_total > 0 else {}
    deviations = {
        role: round(normalized.get(role, 0.0) - float(want), 4)
        for role, want in target.items()
    }
    breaches = {r: d for r, d in deviations.items() if abs(d) > tolerance}

    measured = {
        "source": source,
        "roleShare": normalized,
        "rawRoleShare": {r: round(v, 4) for r, v in by_role.items()},
        "unattributedShare": round(unattributed, 4),
        "deviations": deviations,
        **meta,
    }
    thresholds = {"roleRatios": target, "tolerancePct": tolerance * 100, "maxDeltaE": max_de}

    if branded_total <= 0:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation="No measured area could be attributed to a brand token, so the mix cannot be computed.",
        )
    if breaches:
        worst = max(breaches.items(), key=lambda kv: abs(kv[1]))
        direction = "over" if worst[1] > 0 else "under"
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"Palette mix is off: {worst[0]} is {abs(worst[1]):.0%} {direction}-represented "
                f"({normalized.get(worst[0], 0):.0%} against a target of {float(target[worst[0]]):.0%})."
            ),
            suggested_fix=f"Rebalance toward the declared {worst[0]} share.",
            confidence=0.75,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Role mix {normalized} is within {tolerance:.0%} of the declared ratios.",
        confidence=0.75,
    )


__all__ = [
    "D65_WHITE",
    "PaletteEntry",
    "PaletteResult",
    "check_dominance_ratio",
    "check_forbidden",
    "check_palette_conformance",
    "ciede2000",
    "delta_e_hex",
    "delta_e_lab",
    "extract_palette",
    "hex_to_lab",
    "is_neutral",
    "lab_to_hex",
    "lab_to_rgb",
    "lab_to_xyz",
    "linear_to_srgb",
    "nearest_token",
    "parse_hex",
    "photo_region_mask",
    "rgb_to_lab",
    "rgb_to_xyz",
    "safe_parse_hex",
    "srgb_to_linear",
    "tint_shade_distance",
    "to_hex",
    "xyz_to_lab",
    "xyz_to_rgb",
]
