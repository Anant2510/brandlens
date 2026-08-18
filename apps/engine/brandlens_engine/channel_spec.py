"""Declarative channel-spec validation.

The cheapest and most valuable check in the product: an asset that is 1080x1080
when the placement needs 1080x1920 will be rejected by the ad platform no matter
how on-brand it is. It is pure arithmetic over `brand.channelSpec`, costs
nothing, and catches a large share of real-world rework — which is exactly why
it runs at T0, before a single token is spent.

`channelSpec` shape (all keys optional):

    {
      "instagram-story": {
        "width": 1080, "height": 1920,
        "aspectRatio": 0.5625, "aspectTolerance": 0.02,
        "minWidth": 1080, "maxWidth": 2160,
        "maxFileSizeKb": 4096, "minDpi": 72,
        "allowedFormats": ["jpg", "png"],
        "safeZones": [{"name": "caption", "bbox": [0, 0.86, 1, 1]}]
      },
      "_default": { ... }
    }
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from .media import file_size_bytes
from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

_EXT_ALIASES = {"jpeg": "jpg", "tif": "tiff", "svg+xml": "svg"}


def resolve_spec(channel_spec: dict[str, Any] | None, channel: str | None, asset_type: str | None) -> tuple[dict[str, Any] | None, str]:
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
    # A flat spec (no channel keys at all) is a valid, common shape.
    if any(k in channel_spec for k in ("width", "height", "aspectRatio", "maxFileSizeKb", "allowedFormats")):
        return dict(channel_spec), "flat"
    return None, "none"


def _extension(asset_uri: str, mime_type: str | None) -> str:
    if mime_type and "/" in mime_type:
        ext = mime_type.split("/")[-1].lower()
        return _EXT_ALIASES.get(ext, ext)
    path = urlparse(asset_uri).path or asset_uri
    ext = Path(path).suffix.lstrip(".").lower()
    return _EXT_ALIASES.get(ext, ext)


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

    img = ctx.image()
    width = int(ctx.asset.width or (img.width if img else 0) or 0)
    height = int(ctx.asset.height or (img.height if img else 0) or 0)
    dpi = ctx.dpi
    size_bytes = file_size_bytes(ctx.asset.uri)
    ext = _extension(ctx.asset.uri, ctx.asset.mime_type)
    aspect = (width / height) if height else None

    measured: dict[str, Any] = {
        "specKey": spec_key,
        "width": width or None,
        "height": height or None,
        "aspectRatio": round(aspect, 5) if aspect else None,
        "dpi": dpi,
        "fileSizeKb": round(size_bytes / 1024, 1) if size_bytes is not None else None,
        "format": ext or None,
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

    violations: list[dict[str, Any]] = []

    def _flag(name: str, actual: Any, required: Any, detail: str) -> None:
        violations.append({"constraint": name, "actual": actual, "required": required, "detail": detail})

    if (want := spec.get("width")) is not None and width != int(want):
        _flag("width", width, int(want), f"width is {width}px, spec requires exactly {int(want)}px")
    if (want := spec.get("height")) is not None and height != int(want):
        _flag("height", height, int(want), f"height is {height}px, spec requires exactly {int(want)}px")
    if (want := spec.get("minWidth")) is not None and width < int(want):
        _flag("minWidth", width, int(want), f"width {width}px is below the {int(want)}px minimum")
    if (want := spec.get("minHeight")) is not None and height < int(want):
        _flag("minHeight", height, int(want), f"height {height}px is below the {int(want)}px minimum")
    if (want := spec.get("maxWidth")) is not None and width > int(want):
        _flag("maxWidth", width, int(want), f"width {width}px exceeds the {int(want)}px maximum")
    if (want := spec.get("maxHeight")) is not None and height > int(want):
        _flag("maxHeight", height, int(want), f"height {height}px exceeds the {int(want)}px maximum")

    if (want := spec.get("aspectRatio")) is not None and aspect is not None:
        tolerance = float(spec.get("aspectTolerance", 0.01))
        if not math.isclose(aspect, float(want), abs_tol=tolerance):
            _flag(
                "aspectRatio",
                round(aspect, 5),
                float(want),
                f"aspect ratio {aspect:.4f} differs from {float(want):.4f} by more than {tolerance}",
            )

    if (want := spec.get("maxFileSizeKb")) is not None:
        if size_bytes is None:
            ctx.warn("file size could not be determined for a remote asset; maxFileSizeKb not enforced")
        elif size_bytes / 1024 > float(want):
            _flag(
                "maxFileSizeKb",
                round(size_bytes / 1024, 1),
                float(want),
                f"file is {size_bytes / 1024:.0f}KB against a {float(want):.0f}KB ceiling",
            )

    if (want := spec.get("minDpi")) is not None and dpi < float(want):
        _flag("minDpi", dpi, float(want), f"{dpi}dpi is below the {float(want)}dpi minimum")

    allowed_formats = spec.get("allowedFormats")
    if allowed_formats:
        normalized = [_EXT_ALIASES.get(str(f).lower().lstrip("."), str(f).lower().lstrip(".")) for f in allowed_formats]
        if ext and ext not in normalized:
            _flag("allowedFormats", ext, normalized, f"format {ext!r} is not in {normalized}")

    if (want := spec.get("maxDurationSec")) is not None and ctx.asset.kind == "video":
        # Duration is not measurable here without a video decoder, and adding
        # one would break the no-compiler constraint. Say so rather than pass.
        ctx.warn("video duration cannot be measured by this engine; maxDurationSec was not enforced")
        measured["maxDurationSecEnforced"] = False
        del want

    measured["violations"] = violations
    measured["violationCount"] = len(violations)

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
            f"{width}x{height} ({ext or 'unknown format'}) conforms to the {spec_key!r} channel spec."
        ),
        confidence=1.0,
    )


__all__ = ["check_conformance", "resolve_spec"]
