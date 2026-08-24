"""Declarative channel-spec validation against the shipped registry.

The cheapest and most valuable check in the product: an asset that is 1080x1080
when the placement needs 1080x1920 will be rejected by the ad platform no matter
how on-brand it is. It is arithmetic over `brand.channelSpec`, costs nothing,
and catches a large share of real-world rework — which is why it runs at T0,
before a single token is spent.

WHAT A SPEC LOOKS LIKE
----------------------
The shape is the registry's, because the registry is the thing customers get:
`packages/db/src/seed/data/channel-specs.ts` ships fifteen placements and the
API hands one of them straight to the engine. An earlier version of this module
documented a shape of its own invention — `width`, `height`, `aspectRatio`,
`maxFileSizeKb` — that the registry has never produced. The two vocabularies
overlapped on three keys out of forty, so a blocker-severity rule looked at a
Meta Story spec, matched nothing it recognised, and returned `not_applicable`:
a silent pass on the one check that is pure arithmetic.

    {
      "referenceSize": {"width": 1080, "height": 1920},
      "aspectRatios": [{"w": 9, "h": 16, "tolerance": 0.01, "preferred": true}],
      "minWidth": 1080, "minHeight": 1920,
      "maxBytes": 31457280,
      "formats": ["jpg", "png"],
      "colorSpace": "sRGB",
      "safeZones": {"top": 250, "right": 0, "bottom": 340, "left": 0}
    }

A spec may still arrive keyed by channel (`{"meta-story": {...}, "_default":
{...}}`) — that is what a rule's inline `params.spec` and the assemble handler's
multi-target bundle look like. Both shapes resolve here.

EVERY KEY IS ACCOUNTED FOR
--------------------------
`SPEC_KEYS` is the vocabulary, and it is exhaustive by construction: the result
reports what each key in the resolved spec did, and a key that appears in no
role at all is reported as unrecognised. So a spec carrying `maxDurationSec`
does not quietly do nothing — the verdict says the engine ships no video
decoder and the constraint was not applied. Some keys are enforced by a
*different* analyzer (safe zones are a layout question, legal type size a
typography one); those say which, so nobody looks for the finding here.

The roles, in `SpecKey.role`:

    enforced     measured by this analyzer
    delegated    measured by another analyzer in the same run, automatically
    authorable   no analyzer does it automatically; a rule can be written that does
    unmeasurable the engine cannot measure it, and the detail says why
    reference    not a constraint — other keys are expressed relative to it
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import numpy as np

from .media import cmyk_planes, file_size_bytes, probe_page_geometry, probe_source
from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

_EXT_ALIASES = {"jpeg": "jpg", "tif": "tiff", "svg+xml": "svg"}
_MM_PER_INCH = 25.4

#: Half a percent. A physical size rounded to whole pixels cannot express a
#: resolution exactly — A4 plus 3mm bleed at 300dpi is 2551.18px, and the 2551px
#: file that results is 299.98dpi. Failing it would be arithmetically defensible
#: and, to the person who exported a correct file, indistinguishable from a bug.
_DPI_TOLERANCE = 0.005


# ---------------------------------------------------------------------------
# The vocabulary
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class SpecKey:
    role: str
    summary: str
    #: The analyzer that enforces it, for `delegated` and `authorable`.
    by: str = ""
    #: Why it is not enforced here. Required for every role but `enforced`.
    detail: str = ""


_VIDEO_DETAIL = (
    "a property of the video container. The engine decodes no video — every dependency has to "
    "resolve to a prebuilt wheel on the target VM, which rules out a decoder — so it reads one "
    "rasterised frame and cannot see the timeline."
)

SPEC_KEYS: dict[str, SpecKey] = {
    # -- reference ----------------------------------------------------------
    "referenceSize": SpecKey(
        "reference",
        "The resolution this spec's pixel figures are quoted at.",
        detail="Safe zones especially: they are published in pixels at this size and scaled from it.",
    ),
    "notes": SpecKey(
        "reference",
        "Prose for whoever reads the spec.",
        detail="Guidance for a human, deliberately not a constraint — nothing here is machine-checkable.",
    ),
    # -- dimensions ---------------------------------------------------------
    "exactSizes": SpecKey("enforced", "The asset must be one of these exact pixel sizes."),
    "minWidth": SpecKey("enforced", "Minimum width in pixels."),
    "minHeight": SpecKey("enforced", "Minimum height in pixels."),
    "maxWidth": SpecKey("enforced", "Maximum width in pixels."),
    "maxHeight": SpecKey("enforced", "Maximum height in pixels."),
    "recommendedWidth": SpecKey("enforced", "Advisory width. Reported, never failed."),
    "recommendedHeight": SpecKey("enforced", "Advisory height. Reported, never failed."),
    "aspectRatios": SpecKey("enforced", "The asset must match one ratio within its tolerance."),
    # -- file ---------------------------------------------------------------
    "maxBytes": SpecKey("enforced", "Maximum file size in bytes."),
    "formats": SpecKey("enforced", "Permitted file extensions."),
    "colorSpace": SpecKey("enforced", "The colour space the file must be delivered in."),
    "minDpi": SpecKey("enforced", "Minimum resolution, declared or implied by the trim size."),
    # -- print --------------------------------------------------------------
    "trimSize": SpecKey("enforced", "Finished page size in millimetres, after cutting."),
    "bleedMm": SpecKey("enforced", "Artwork must extend this far beyond the trim on every edge."),
    "totalInkCoverageMaxPct": SpecKey("enforced", "Ceiling on the sum of the four separations."),
    "requiresCropMarks": SpecKey("enforced", "Prepress marks must sit outside the trim box."),
    "requiresOutlinedFonts": SpecKey("enforced", "Type must be converted to outlines."),
    # -- delegated ----------------------------------------------------------
    "safeZones": SpecKey(
        "delegated",
        "Regions the channel covers with its own furniture.",
        by="layout.safe_zone",
        detail=(
            "Intrusion is a question about where elements sit, so it is measured where elements are "
            "located. That analyzer reads these zones from the channel spec when its rule names none."
        ),
    ),
    "safetyMarginMm": SpecKey(
        "delegated",
        "Print safe area, inside the trim.",
        by="layout.safe_zone",
        detail="Converted to a safe zone alongside the bleed and checked with the rest of them.",
    ),
    "minLegalFontPx": SpecKey(
        "delegated",
        "Floor on legal copy, in pixels at the reference size.",
        by="typography.min_size",
        detail="Applied as a floor on top of the brand's own per-style minimums, whichever is larger.",
    ),
    "minLegalFontPt": SpecKey(
        "delegated",
        "Floor on legal copy, in points.",
        by="typography.min_size",
        detail="Applied as a floor on top of the brand's own per-style minimums, whichever is larger.",
    ),
    "textDensityAdvisoryPct": SpecKey(
        "delegated",
        "Share of the canvas the platform prefers text not to exceed.",
        by="layout.text_density",
        detail="Advisory by construction — the platform suppresses delivery, it does not reject the upload.",
    ),
    # -- authorable ---------------------------------------------------------
    "prohibitedContent": SpecKey(
        "authorable",
        "Subject matter the platform rejects on review.",
        by="vlm.rubric",
        detail=(
            "A semantic judgement, not arithmetic. Author a rule on `vlm.rubric` whose question quotes "
            "these, and the judge adjudicates them against the asset with a citable rationale."
        ),
    ),
    # -- unmeasurable -------------------------------------------------------
    "textLimits": SpecKey(
        "unmeasurable",
        "Character ceilings on the ad's copy fields.",
        detail=(
            "Headline, primary text and description are typed into the ad platform's own form. They "
            "are not in the uploaded file, so nothing here can count them."
        ),
    ),
    "durationMs": SpecKey("unmeasurable", "Permitted clip length.", detail=_VIDEO_DETAIL),
    "maxDurationSec": SpecKey("unmeasurable", "Maximum clip length.", detail=_VIDEO_DETAIL),
    "fps": SpecKey("unmeasurable", "Permitted frame rate.", detail=_VIDEO_DETAIL),
    "bitrateKbps": SpecKey("unmeasurable", "Permitted bitrate.", detail=_VIDEO_DETAIL),
    "audio": SpecKey("unmeasurable", "Required audio codec and sample rate.", detail=_VIDEO_DETAIL),
    "videoCodec": SpecKey("unmeasurable", "Permitted video codecs.", detail=_VIDEO_DETAIL),
    "animation": SpecKey("unmeasurable", "Animation length and loop ceiling.", detail=_VIDEO_DETAIL),
    "captionsRequired": SpecKey(
        "unmeasurable",
        "Captions must be burned in or supplied as a sidecar.",
        detail="Captions appear across the timeline and the engine sees a single frame.",
    ),
    # -- legacy -------------------------------------------------------------
    # The vocabulary this module invented before the registry existed. Rules
    # written against it — including every rule `induce.py` generates from a
    # corpus — must keep working, so the names stay and map onto the same
    # measurements. New specs should use the registry's names.
    "width": SpecKey("enforced", "Exact width in pixels. Prefer `exactSizes`."),
    "height": SpecKey("enforced", "Exact height in pixels. Prefer `exactSizes`."),
    "aspectRatio": SpecKey("enforced", "Single permitted ratio as a decimal. Prefer `aspectRatios`."),
    "aspectTolerance": SpecKey("enforced", "Tolerance for `aspectRatio`."),
    "maxFileSizeKb": SpecKey("enforced", "Maximum file size in KB. Prefer `maxBytes`."),
    "allowedFormats": SpecKey("enforced", "Permitted file extensions. Prefer `formats`."),
}


def resolve_spec(
    channel_spec: dict[str, Any] | None, channel: str | None, asset_type: str | None
) -> tuple[dict[str, Any] | None, str]:
    """Most specific spec wins: `channel:assetType` > `channel` > `_default`."""
    if not channel_spec:
        return None, "none"
    for key in (
        f"{channel}:{asset_type}" if channel and asset_type else None,
        f"{channel}/{asset_type}" if channel and asset_type else None,
        channel,
        asset_type,
        "_default",
        "default",
    ):
        if key and isinstance(channel_spec.get(key), dict):
            return dict(channel_spec[key]), key
    # A flat spec — one placement, no channel keys — is what the API sends on
    # the analyze path, having already selected the row by platform/placement.
    # Recognising it by "does it speak the vocabulary" rather than by a list of
    # five key names is what stops the two drifting apart again: a channel-keyed
    # map's top-level keys are placement names, none of which are in SPEC_KEYS.
    if any(k in SPEC_KEYS for k in channel_spec):
        return dict(channel_spec), "flat"
    return None, "none"


def _extension(asset_uri: str, mime_type: str | None) -> str:
    if mime_type and "/" in mime_type:
        ext = mime_type.split("/")[-1].lower()
        return _EXT_ALIASES.get(ext, ext)
    path = urlparse(asset_uri).path or asset_uri
    ext = Path(path).suffix.lstrip(".").lower()
    return _EXT_ALIASES.get(ext, ext)


def _pair(value: Any, *names: str) -> tuple[float, float] | None:
    """A `{width,height}`-ish object as a tuple, under whichever names it uses."""
    if not isinstance(value, dict):
        return None
    keys = list(names) or ["width", "height"]
    try:
        return float(value[keys[0]]), float(value[keys[1]])
    except (KeyError, TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Geometry the delegating analyzers need
# ---------------------------------------------------------------------------
def safe_zone_rects(spec: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The spec's reserved regions as normalised `{name, bbox}` rectangles.

    Two sources, because the registry expresses the same idea two ways. Screen
    placements publish pixel insets at a reference resolution (TikTok's caption
    bar is 310px up from the bottom of a 1920px canvas); print expresses it in
    millimetres of bleed plus safety margin. Both reduce to a fraction of the
    canvas, which is what `layout.safe_zone` compares elements against, and
    neither needs the asset's own dimensions to do it.
    """
    if not spec:
        return []

    zones: list[dict[str, Any]] = []
    reference = _pair(spec.get("referenceSize"))
    insets = spec.get("safeZones")
    if isinstance(insets, dict) and reference:
        ref_w, ref_h = reference
        edges = {
            "top": (0.0, 0.0, 1.0, float(insets.get("top", 0) or 0) / max(ref_h, 1e-9)),
            "bottom": (0.0, 1.0 - float(insets.get("bottom", 0) or 0) / max(ref_h, 1e-9), 1.0, 1.0),
            "left": (0.0, 0.0, float(insets.get("left", 0) or 0) / max(ref_w, 1e-9), 1.0),
            "right": (1.0 - float(insets.get("right", 0) or 0) / max(ref_w, 1e-9), 0.0, 1.0, 1.0),
        }
        for name, box in edges.items():
            if box[2] > box[0] and box[3] > box[1]:
                zones.append({"name": f"{name} chrome", "bbox": [round(v, 6) for v in box], "source": "safeZones"})
    elif isinstance(insets, list):
        # Already-normalised zones, the shape `layout.safe_zone` takes directly.
        zones.extend([z for z in insets if isinstance(z, dict) and z.get("bbox")])

    if zones:
        return zones

    trim = _pair(spec.get("trimSize"), "widthMm", "heightMm")
    bleed = float(spec.get("bleedMm") or 0.0)
    margin = float(spec.get("safetyMarginMm") or 0.0)
    if trim and (bleed or margin):
        # The canvas is the trim plus bleed on all four edges; content must sit
        # inside the safety margin, measured in from the trim.
        canvas_w, canvas_h = trim[0] + 2 * bleed, trim[1] + 2 * bleed
        fx, fy = (bleed + margin) / max(canvas_w, 1e-9), (bleed + margin) / max(canvas_h, 1e-9)
        for name, box in {
            "top": (0.0, 0.0, 1.0, fy),
            "bottom": (0.0, 1.0 - fy, 1.0, 1.0),
            "left": (0.0, 0.0, fx, 1.0),
            "right": (1.0 - fx, 0.0, 1.0, 1.0),
        }.items():
            zones.append(
                {"name": f"{name} bleed + safety margin", "bbox": [round(v, 6) for v in box], "source": "trimSize"}
            )
    return zones


def spec_dimensions(spec: dict[str, Any] | None) -> tuple[int, int] | None:
    """The pixel size to design at, and where it came from.

    A spec states its size four different ways depending on the placement, and
    the assemble planner used to read only `width`/`height` — a pair the
    registry has never published — so every plan it produced carried a null
    canvas size and the candidate ranking had no target aspect to score
    against. Most specific first: an exact size is a hard requirement, the
    recommended size is what the platform asks for, and the reference size is
    at least the resolution the rest of the spec is quoted at.
    """
    if not spec:
        return None
    sizes = spec.get("exactSizes")
    if isinstance(sizes, list) and sizes and (pair := _pair(sizes[0])):
        return int(pair[0]), int(pair[1])
    if spec.get("recommendedWidth") and spec.get("recommendedHeight"):
        return int(spec["recommendedWidth"]), int(spec["recommendedHeight"])
    if pair := _pair(spec.get("referenceSize")):
        return int(pair[0]), int(pair[1])
    if spec.get("width") and spec.get("height"):
        return int(spec["width"]), int(spec["height"])
    return None


def legal_font_floor_pt(spec: dict[str, Any] | None, dpi: float) -> tuple[float, str] | None:
    """The channel's floor on legal copy in points, and where it came from."""
    if not spec:
        return None
    if (pt := spec.get("minLegalFontPt")) is not None:
        return float(pt), "channelSpec.minLegalFontPt"
    if (px := spec.get("minLegalFontPx")) is not None:
        # A pixel figure is quoted at the reference resolution, so converting it
        # needs that resolution, not the asset's. `minLegalFontPx: 10` on a
        # 300x250 banner means ten of that banner's pixels.
        return float(px) * 72.0 / max(float(dpi or 96.0), 1e-6), "channelSpec.minLegalFontPx"
    return None


# ---------------------------------------------------------------------------
# Resolution, which the print checks all depend on
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Resolution:
    dpi: float | None
    basis: str
    #: True when there is no resolution to fall short of. Vector artwork is
    #: resolution-independent, so a dpi floor is a question about its placed
    #: rasters, and a page with none satisfies any floor by construction.
    unconstrained: bool = False


def _resolution(spec: dict[str, Any], width_px: int, probe: Any, page: Any) -> Resolution:
    """Effective dpi and its basis.

    Four sources in descending order of authority, and the first version of
    this got the order wrong in a way that would have failed every correct
    print PDF: it took `ctx.dpi`, which for a PDF is the resolution the page was
    *rasterised* at for the pixel checks — 150 by default — and compared that
    against a 300dpi print minimum. What a printer means by a file's resolution
    is the lowest-resolution image placed in it.
    """
    if page is not None:
        if page.min_image_dpi is None:
            return Resolution(None, "vector artwork with no placed rasters", unconstrained=True)
        return Resolution(float(page.min_image_dpi), "the lowest-resolution image placed in the PDF")
    if probe is not None and probe.dpi:
        return Resolution(float(probe.dpi), "declared by the file")
    trim = _pair(spec.get("trimSize"), "widthMm", "heightMm")
    if trim and width_px:
        # The file says nothing, but the spec gives a physical size, so the
        # pixels imply a resolution: 2551px across 216mm of A4-plus-bleed is
        # 300dpi, which is the number a prepress operator works out by hand.
        canvas_mm = trim[0] + 2 * float(spec.get("bleedMm") or 0.0)
        if canvas_mm > 0:
            return Resolution(width_px / (canvas_mm / _MM_PER_INCH), "implied by the trim size")
    # Never the 96dpi default: a PNG with no pHYs chunk is not a 96dpi file, it
    # is a file that declares nothing, and the two must not read the same.
    return Resolution(None, "unknown")


# ---------------------------------------------------------------------------
# The analyzer
# ---------------------------------------------------------------------------
def check_conformance(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    spec, spec_key = resolve_spec(
        rule.check.params.get("spec") or ctx.brand.channel_spec,
        ctx.asset.channel,
        ctx.asset.asset_type,
    )
    if not spec:
        return build_result(
            rule,
            "not_applicable",
            measured={"channel": ctx.asset.channel, "assetType": ctx.asset.asset_type},
            observation="No channel spec matches this asset's channel/assetType.",
        )

    violations: list[dict[str, Any]] = []
    advisories: list[str] = []
    #: Keys present in the spec that this run did not measure, and why.
    unapplied: list[dict[str, str]] = []
    #: Keys this analyzer would enforce but could not on this particular asset.
    unmeasured: list[dict[str, str]] = []

    def flag(name: str, actual: Any, required: Any, detail: str) -> None:
        violations.append({"constraint": name, "actual": actual, "required": required, "detail": detail})

    def skip(name: str, why: str) -> None:
        unmeasured.append({"constraint": name, "reason": why})
        ctx.warn(f"{name} could not be measured on this asset: {why}")

    img = ctx.image()
    raw = ctx.raw_bytes()
    probe = probe_source(raw) if raw else None
    page = probe_page_geometry(raw) if raw else None
    width = int(ctx.asset.width or (img.width if img else 0) or 0)
    height = int(ctx.asset.height or (img.height if img else 0) or 0)
    size_bytes = file_size_bytes(ctx.asset.uri)
    if size_bytes is None and raw is not None:
        size_bytes = len(raw)
    ext = _extension(ctx.asset.uri, ctx.asset.mime_type)
    aspect = (width / height) if height else None
    res = _resolution(spec, width, probe, page)

    measured: dict[str, Any] = {
        "specKey": spec_key,
        "width": width or None,
        "height": height or None,
        "aspectRatio": round(aspect, 5) if aspect else None,
        "dpi": round(res.dpi, 1) if res.dpi else None,
        "dpiBasis": res.basis,
        "fileSizeKb": round(size_bytes / 1024, 1) if size_bytes is not None else None,
        "format": ext or None,
        "sourceMode": probe.mode if probe else None,
    }
    thresholds = dict(spec)

    if not width or not height:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation="Asset dimensions are unknown and the file could not be rasterised to measure them.",
        )

    # -- dimensions ---------------------------------------------------------
    if (sizes := spec.get("exactSizes")) and isinstance(sizes, list):
        allowed = [p for p in (_pair(s) for s in sizes) if p]
        if allowed and not any(width == int(w) and height == int(h) for w, h in allowed):
            offered = ", ".join(f"{int(w)}x{int(h)}" for w, h in allowed)
            flag("exactSizes", f"{width}x{height}", offered, f"{width}x{height} is not one of {offered}")

    for key, actual, label in (("width", width, "width"), ("height", height, "height")):
        if (want := spec.get(key)) is not None and actual != int(want):
            flag(key, actual, int(want), f"{label} is {actual}px, spec requires exactly {int(want)}px")
    for key, actual, label in (("minWidth", width, "width"), ("minHeight", height, "height")):
        if (want := spec.get(key)) is not None and actual < int(want):
            flag(key, actual, int(want), f"{label} {actual}px is below the {int(want)}px minimum")
    for key, actual, label in (("maxWidth", width, "width"), ("maxHeight", height, "height")):
        if (want := spec.get(key)) is not None and actual > int(want):
            flag(key, actual, int(want), f"{label} {actual}px exceeds the {int(want)}px maximum")
    for key, actual, label in (("recommendedWidth", width, "width"), ("recommendedHeight", height, "height")):
        if (want := spec.get(key)) is not None and actual < int(want):
            advisories.append(f"{label} {actual}px is under the {int(want)}px the platform recommends")

    # -- aspect ratio -------------------------------------------------------
    ratios = spec.get("aspectRatios")
    if isinstance(ratios, list) and ratios and aspect is not None:
        options: list[tuple[float, float, bool]] = []
        for entry in ratios:
            if not isinstance(entry, dict):
                continue
            try:
                w, h = float(entry["w"]), float(entry["h"])
            except (KeyError, TypeError, ValueError):
                continue
            if h > 0:
                options.append((w / h, float(entry.get("tolerance", 0.01)), bool(entry.get("preferred"))))
        if options:
            matched = [o for o in options if math.isclose(aspect, o[0], abs_tol=o[1])]
            if not matched:
                offered = ", ".join(f"{r:.4f}" for r, _, _ in options)
                flag("aspectRatios", round(aspect, 5), offered, f"aspect ratio {aspect:.4f} matches none of {offered}")
            elif any(o[2] for o in options) and not any(o[2] for o in matched):
                preferred = next(o[0] for o in options if o[2])
                advisories.append(f"{aspect:.4f} is permitted but {preferred:.4f} is the placement's preferred ratio")

    if (want := spec.get("aspectRatio")) is not None and aspect is not None:
        tolerance = float(spec.get("aspectTolerance", 0.01))
        if not math.isclose(aspect, float(want), abs_tol=tolerance):
            flag(
                "aspectRatio",
                round(aspect, 5),
                float(want),
                f"aspect ratio {aspect:.4f} differs from {float(want):.4f} by more than {tolerance}",
            )

    # -- file size ----------------------------------------------------------
    for key, divisor, unit in (("maxBytes", 1.0, "B"), ("maxFileSizeKb", 1024.0, "KB")):
        if (want := spec.get(key)) is None:
            continue
        if size_bytes is None:
            skip(key, "the asset is remote and its bytes could not be sized")
        elif size_bytes / divisor > float(want):
            actual_mb, want_mb = size_bytes / 1_048_576, float(want) * divisor / 1_048_576
            flag(
                key,
                round(size_bytes / divisor, 1),
                float(want),
                f"file is {actual_mb:.2f}MB against a {want_mb:.2f}MB ceiling"
                if unit == "B"
                else f"file is {size_bytes / 1024:.0f}KB against a {float(want):.0f}KB ceiling",
            )

    # -- format -------------------------------------------------------------
    for key in ("formats", "allowedFormats"):
        allowed_formats = spec.get(key)
        if not allowed_formats:
            continue
        normalized = sorted(
            {_EXT_ALIASES.get(str(f).lower().lstrip("."), str(f).lower().lstrip(".")) for f in allowed_formats}
        )
        if not ext:
            skip(key, "the asset URI carries no extension and no MIME type was supplied")
        elif ext not in normalized:
            flag(key, ext, normalized, f"format {ext!r} is not in {normalized}")

    # -- resolution ---------------------------------------------------------
    if (want := spec.get("minDpi")) is not None:
        if res.unconstrained:
            advisories.append(f"resolution is not constrained here: {res.basis}")
        elif res.dpi is None:
            skip(
                "minDpi",
                "the file declares no resolution and the spec gives no physical size to imply one from",
            )
        elif res.dpi < float(want) * (1 - _DPI_TOLERANCE):
            flag(
                "minDpi",
                round(res.dpi, 1),
                float(want),
                f"{res.dpi:.0f}dpi ({res.basis}) is below the {float(want):.0f}dpi minimum",
            )

    # -- colour space -------------------------------------------------------
    if (want := spec.get("colorSpace")) is not None:
        actual_space = _colour_space(probe)
        if actual_space is None:
            skip("colorSpace", "the file's colour model could not be read")
        elif actual_space.lower() != str(want).lower():
            flag(
                "colorSpace",
                actual_space,
                str(want),
                f"delivered as {actual_space} where the spec requires {want}",
            )

    # -- print geometry -----------------------------------------------------
    _check_print(spec, raw, page, width, height, res, measured, flag, skip)

    # -- everything else ----------------------------------------------------
    unrecognised: list[str] = []
    for key in spec:
        entry = SPEC_KEYS.get(key)
        if entry is None:
            unrecognised.append(key)
        elif entry.role in ("delegated", "authorable", "unmeasurable"):
            unapplied.append({"key": key, "role": entry.role, "by": entry.by, "why": entry.detail})

    if unrecognised:
        ctx.warn(
            f"channel spec {spec_key!r} carries unrecognised key(s) {sorted(unrecognised)}; they constrain "
            "nothing. Add them to SPEC_KEYS in channel_spec.py or remove them from the registry."
        )
    for item in unapplied:
        if item["role"] == "unmeasurable":
            ctx.warn(f"{item['key']} was not enforced: {item['why']}")

    measured.update(
        {
            "violations": violations,
            "violationCount": len(violations),
            "advisories": advisories,
            "notEnforcedHere": unapplied,
            "notMeasurable": unmeasured,
            "unrecognisedKeys": sorted(unrecognised),
        }
    )

    delegated = [i["key"] for i in unapplied if i["role"] == "delegated"]
    tail = f" {len(delegated)} key(s) are checked elsewhere: {', '.join(sorted(delegated))}." if delegated else ""
    if unmeasured:
        tail += f" {len(unmeasured)} could not be measured on this asset."

    if violations:
        first = violations[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"{len(violations)} channel-spec violation(s) for {spec_key!r}: "
                + "; ".join(str(v["detail"]) for v in violations[:3])
                + ("..." if len(violations) > 3 else ".")
                + tail
            ),
            suggested_fix=str(first["detail"]).capitalize() + " — re-export to the required spec.",
            confidence=1.0,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=(
            f"{width}x{height} ({ext or 'unknown format'}) conforms to the {spec_key!r} channel spec"
            + (f"; advisory: {advisories[0]}" if advisories else "")
            + "."
            + tail
        ),
        confidence=1.0,
    )


def _colour_space(probe: Any) -> str | None:
    """The file's colour model in the registry's vocabulary, or None."""
    if probe is None:
        return None
    if probe.is_pdf:
        # A PDF carries a colour space per object, not per file. Reporting one
        # would be a guess, and the ink-coverage check is the honest version of
        # the question a print spec is really asking.
        return None
    return {"CMYK": "CMYK", "RGB": "sRGB", "RGBA": "sRGB", "P": "sRGB", "L": "Greyscale", "LA": "Greyscale"}.get(
        probe.mode or ""
    )


def _check_print(
    spec: dict[str, Any],
    raw: bytes | None,
    page: Any,
    width: int,
    height: int,
    res: Resolution,
    measured: dict[str, Any],
    flag: Any,
    skip: Any,
) -> None:
    """Trim, bleed, ink coverage, crop marks and outlined type.

    The checks a printer runs before quoting, and the reason a job comes back:
    artwork supplied at trim size with no bleed leaves a white hairline down one
    edge after cutting, and 400% ink on coated stock will not dry.
    """
    trim = _pair(spec.get("trimSize"), "widthMm", "heightMm")
    bleed_required = spec.get("bleedMm")
    wants_geometry = trim is not None or bleed_required is not None
    wants_ink = spec.get("totalInkCoverageMaxPct") is not None
    wants_marks = bool(spec.get("requiresCropMarks"))
    wants_outlines = bool(spec.get("requiresOutlinedFonts"))
    if not (wants_geometry or wants_ink or wants_marks or wants_outlines):
        return
    if raw is None:
        for key in ("trimSize", "bleedMm", "totalInkCoverageMaxPct", "requiresCropMarks", "requiresOutlinedFonts"):
            if spec.get(key) is not None:
                skip(key, "the asset bytes could not be read")
        return

    measured["print"] = {}

    # -- trim and bleed -----------------------------------------------------
    if wants_geometry:
        if page is not None:
            measured["print"].update(
                {
                    "mediaMm": [round(v, 2) for v in page.media_mm],
                    "trimMm": [round(v, 2) for v in page.trim_mm],
                    "bleedMm": round(page.bleed_mm, 2),
                    "trimBoxDeclared": page.trim_declared,
                    "basis": "PDF page boxes",
                }
            )
            if trim and not _close_mm(page.trim_mm, trim):
                flag(
                    "trimSize",
                    f"{page.trim_mm[0]:.0f}x{page.trim_mm[1]:.0f}mm",
                    f"{trim[0]:.0f}x{trim[1]:.0f}mm",
                    f"trim box is {page.trim_mm[0]:.0f}x{page.trim_mm[1]:.0f}mm, spec requires "
                    f"{trim[0]:.0f}x{trim[1]:.0f}mm",
                )
            if bleed_required is not None:
                want = float(bleed_required)
                if not page.trim_declared:
                    flag(
                        "bleedMm",
                        0.0,
                        want,
                        f"the PDF declares no trim box, so there is no bleed — the page is "
                        f"{page.media_mm[0]:.0f}x{page.media_mm[1]:.0f}mm edge to edge and "
                        f"{want}mm of artwork will be cut into the design",
                    )
                elif page.bleed_mm + 0.15 < want:
                    flag(
                        "bleedMm",
                        round(page.bleed_mm, 2),
                        want,
                        f"bleed is {page.bleed_mm:.1f}mm against the {want}mm required; a cutting "
                        "tolerance of half a millimetre will show white on the trimmed edge",
                    )
        elif res.dpi and res.basis == "declared by the file" and trim:
            dpi = res.dpi
            want_bleed = float(bleed_required or 0.0)
            expect = (
                (trim[0] + 2 * want_bleed) * dpi / _MM_PER_INCH,
                (trim[1] + 2 * want_bleed) * dpi / _MM_PER_INCH,
            )
            actual_mm = (width * _MM_PER_INCH / dpi, height * _MM_PER_INCH / dpi)
            measured["print"].update(
                {"actualMm": [round(v, 2) for v in actual_mm], "expectedPx": [round(v) for v in expect],
                 "basis": f"{dpi:.0f}dpi declared by the file"}
            )
            if not _close_px((width, height), expect):
                at_trim = _close_px((width, height), (trim[0] * dpi / _MM_PER_INCH, trim[1] * dpi / _MM_PER_INCH))
                flag(
                    "bleedMm" if at_trim or want_bleed else "trimSize",
                    f"{actual_mm[0]:.0f}x{actual_mm[1]:.0f}mm",
                    f"{trim[0] + 2 * want_bleed:.0f}x{trim[1] + 2 * want_bleed:.0f}mm",
                    (
                        f"supplied at trim size ({trim[0]:.0f}x{trim[1]:.0f}mm) with no bleed; "
                        f"{want_bleed}mm is required on every edge"
                    )
                    if at_trim
                    else (
                        f"at {dpi:.0f}dpi the artwork measures {actual_mm[0]:.0f}x{actual_mm[1]:.0f}mm, "
                        f"not the {trim[0] + 2 * want_bleed:.0f}x{trim[1] + 2 * want_bleed:.0f}mm the trim "
                        "plus bleed requires"
                    ),
                )
        else:
            for key in ("trimSize", "bleedMm"):
                if spec.get(key) is not None:
                    skip(
                        key,
                        "physical size needs either a PDF page box or a resolution the file declares; "
                        f"this asset has neither ({res.basis})",
                    )

    # -- total ink coverage -------------------------------------------------
    if wants_ink:
        planes = cmyk_planes(raw, dpi=min(150.0, float(res.dpi or 150.0)))
        if planes is None:
            skip(
                "totalInkCoverageMaxPct",
                "ink coverage is the sum of the four separations and this asset is not CMYK, so it has "
                "none. Converting from RGB would invent the black generation and report a comfortable "
                "figure for artwork that may carry 320% on press",
            )
        else:
            total = planes.astype(np.float32).sum(axis=2) / 255.0 * 100.0
            peak = float(total.max())
            # The 99.9th percentile, not the maximum: one antialiased pixel on a
            # rule is not a drying problem, a solid panel is. Both are reported.
            bulk = float(np.percentile(total, 99.9))
            over = float((total > float(spec["totalInkCoverageMaxPct"])).mean() * 100.0)
            measured["print"].update(
                {"inkCoverageP999Pct": round(bulk, 1), "inkCoveragePeakPct": round(peak, 1),
                 "inkOverLimitAreaPct": round(over, 3)}
            )
            want = float(spec["totalInkCoverageMaxPct"])
            if bulk > want:
                flag(
                    "totalInkCoverageMaxPct",
                    round(bulk, 1),
                    want,
                    f"total ink coverage reaches {bulk:.0f}% over {over:.2f}% of the artwork against a "
                    f"{want:.0f}% ceiling; it will not dry on coated stock and will set off",
                )

    # -- prepress marks and outlined type -----------------------------------
    if wants_marks:
        if page is None:
            skip("requiresCropMarks", "crop marks live outside a PDF trim box and this asset is not a PDF")
        else:
            measured["print"]["marksOutsideTrim"] = page.marks_outside_trim
            if not page.trim_declared:
                flag(
                    "requiresCropMarks",
                    "no trim box",
                    "marks outside the trim box",
                    "the PDF declares no trim box, so crop marks have nowhere to sit",
                )
            elif page.marks_outside_trim == 0:
                flag(
                    "requiresCropMarks",
                    0,
                    "at least one mark outside the trim box",
                    "no artwork sits outside the trim box, so the file carries no crop marks",
                )

    if wants_outlines:
        if page is None:
            skip("requiresOutlinedFonts", "outlined type can only be confirmed on a PDF")
        else:
            measured["print"]["extractableTextChars"] = page.extractable_text_chars
            if page.extractable_text_chars > 0:
                flag(
                    "requiresOutlinedFonts",
                    f"{page.extractable_text_chars} characters of live text",
                    "0",
                    f"{page.extractable_text_chars} characters are still live text; outlined type extracts "
                    "as nothing, so this file will substitute fonts if the RIP lacks them",
                )


def _close_mm(actual: tuple[float, float], want: tuple[float, float], tol: float = 0.6) -> bool:
    return abs(actual[0] - want[0]) <= tol and abs(actual[1] - want[1]) <= tol


def _close_px(actual: tuple[float, float], want: tuple[float, float]) -> bool:
    # Half a percent, floored at two pixels: rounding a millimetre figure to
    # whole pixels moves it by one, and no exporter agrees on which way.
    return all(abs(a - w) <= max(2.0, w * 0.005) for a, w in zip(actual, want, strict=True))


__all__ = [
    "SPEC_KEYS",
    "SpecKey",
    "check_conformance",
    "legal_font_floor_pt",
    "resolve_spec",
    "safe_zone_rects",
    "spec_dimensions",
]
