"""Accessibility: contrast rollup, size floors, alt text.

Accessibility findings are unusual in this system in that they are *legally*
grounded (EAA, ADA, WCAG referenced in procurement), which is why they are
measured to the letter of WCAG 2.x and reported worst-case. Every other
dimension here tolerates an average; this one does not, because a single
unreadable line is a single unreadable line for the person who cannot read it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .contrast import (
    LocalContrast,
    apca_lc,
    contrast_ratio_hex,
    measure_local_contrast,
    wcag_threshold,
    worst_case,
)
from .media import denorm_bbox
from .models import RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext


def _hex(rgb: tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


# ---------------------------------------------------------------------------
# accessibility.contrast
# ---------------------------------------------------------------------------
def check_contrast(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Per-run local contrast, reported worst-first.

    When the structured source states both the text colour and a single covering
    fill we use those exact values; otherwise we sample the ring around the
    glyphs. Both paths report the same shape, and the `method` field says which
    one produced the number.
    """
    params = rule.check.params
    level = str(params.get("level", "AA")).upper()
    explicit_min = params.get("minRatio")
    img = ctx.image()
    doc = ctx.structured()

    runs: list[dict[str, Any]] = []

    # -- structured path: exact declared foreground colour -------------------
    # The text colour is always exact when a structured source exists. The
    # background is only exact when a solid fill demonstrably covers the run;
    # otherwise we take the foreground from the structure and sample the
    # background from pixels, which is strictly better than discarding a known
    # value in favour of an Otsu guess at both.
    if doc.available:
        for page in doc.pages:
            fills = sorted(
                (s for s in page.shapes if s.fill_hex and s.area_norm > 0.02),
                key=lambda s: -s.area_norm,
            )
            for el in page.text:
                if not el.text.strip() or not el.color_hex:
                    continue
                backdrop = next(
                    (
                        s.fill_hex
                        for s in fills
                        if s.bbox[0] <= el.bbox[0] and s.bbox[1] <= el.bbox[1]
                        and s.bbox[2] >= el.bbox[2] and s.bbox[3] >= el.bbox[3]
                    ),
                    None,
                )
                method = f"declared:{doc.kind}"
                reliable = True
                if backdrop is None and img is not None:
                    local = measure_local_contrast(img.rgb, denorm_bbox(el.bbox, img.width, img.height))
                    backdrop = _hex(local.bg_rgb)
                    method = f"declared-fg:{doc.kind}"
                    reliable = local.reliable
                elif backdrop is None and doc.kind == "pdf":
                    # An unpainted PDF page is paper white by definition.
                    backdrop = "#FFFFFF"
                    method = f"declared-fg+paper:{doc.kind}"
                if backdrop is None:
                    continue
                try:
                    ratio = round(contrast_ratio_hex(el.color_hex, backdrop), 4)
                except ValueError:
                    continue
                required = float(explicit_min) if explicit_min is not None else wcag_threshold(
                    el.font_size_pt, el.is_bold, level
                )
                runs.append(
                    {
                        "text": el.text[:60],
                        "ratio": ratio,
                        "required": required,
                        "fg": el.color_hex,
                        "bg": backdrop,
                        "sizePt": round(el.font_size_pt, 2),
                        "bold": el.is_bold,
                        "bbox": [round(v, 4) for v in el.bbox],
                        "method": method,
                        "reliable": reliable,
                    }
                )

    # -- pixel path: local ring sampling ------------------------------------
    if not runs and img is not None:
        spans = ctx.text_spans()
        if not spans and doc.available:
            spans = []
        measurements: list[tuple[LocalContrast, dict[str, Any]]] = []
        for span in spans[: int(params.get("maxRuns", 60))]:
            box_px = denorm_bbox(span.bbox, img.width, img.height)
            local = measure_local_contrast(img.rgb, box_px)
            size_pt = span.font_size_pt_estimate or ((span.bbox[3] - span.bbox[1]) * img.height * 72.0 / ctx.dpi)
            measurements.append(
                (
                    local,
                    {
                        "text": span.text[:60],
                        "ratio": local.ratio,
                        "required": float(explicit_min) if explicit_min is not None else wcag_threshold(size_pt, False, level),
                        "fg": _hex(local.fg_rgb),
                        "bg": _hex(local.bg_rgb),
                        "sizePt": round(size_pt, 2),
                        "bold": False,
                        "bbox": [round(v, 4) for v in span.bbox],
                        "method": f"local-ring:{span.source}",
                        "reliable": local.reliable,
                        "apcaLc": local.apca_lc,
                        "bgSupport": local.bg_support,
                        "note": local.note,
                    },
                )
            )
        runs = [record for _local, record in measurements]

    if not runs:
        driver = ctx.settings.ocr_driver
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"runs": 0, "structuredSource": doc.kind, "ocrDriver": driver},
            observation=(
                "No text run could be located with both a colour and a background to measure. "
                + (
                    f"OCR driver is {driver!r}, so text position is unavailable from pixels."
                    if driver == "none"
                    else "The asset has no structured text and OCR returned no spans."
                )
            ),
        )

    failures = [r for r in runs if float(r["ratio"]) + 1e-6 < float(r["required"])]
    reliable_runs = [r for r in runs if r.get("reliable", True)]
    pool = failures or (reliable_runs or runs)
    worst = min(pool, key=lambda r: float(r["ratio"]) / max(float(r["required"]), 1e-9))

    measured = {
        "runCount": len(runs),
        "failureCount": len(failures),
        "worstRatio": float(worst["ratio"]),
        "worstRequired": float(worst["required"]),
        "runs": sorted(runs, key=lambda r: float(r["ratio"]))[:25],
        "method": worst["method"],
        "advisoryApcaLc": worst.get("apcaLc"),
    }
    thresholds = {"level": level, "minRatio": explicit_min, "policy": "worst-case across runs"}

    if failures:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type]
            quoted_text=str(worst["text"]),
            observation=(
                f"{len(failures)} of {len(runs)} text run(s) fall below WCAG {level}. Worst is "
                f"{worst['ratio']}:1 against a required {worst['required']}:1 "
                f"({worst['fg']} on {worst['bg']}, {worst['sizePt']}pt)."
            ),
            suggested_fix=f"Darken or lighten {worst['fg']} until it reaches {worst['required']}:1 on {worst['bg']}.",
            confidence=0.95 if str(worst["method"]).startswith("declared") else 0.8,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        bbox=tuple(worst["bbox"]),  # type: ignore[arg-type]
        observation=(
            f"All {len(runs)} text run(s) meet WCAG {level}; the worst case is "
            f"{worst['ratio']}:1 against a required {worst['required']}:1."
        ),
        confidence=0.95 if str(worst["method"]).startswith("declared") else 0.8,
    )


# ---------------------------------------------------------------------------
# accessibility.font_size_floor
# ---------------------------------------------------------------------------
def check_font_size_floor(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """An absolute legibility floor, independent of the brand's type styles.

    Distinct from `typography.min_size`, which enforces the brand's own scale.
    This is the "nobody can read 6pt" floor and it applies even where the brand
    guidelines are silent.
    """
    params = rule.check.params
    floor_pt = float(params.get("minSizePt", 9.0))
    doc = ctx.structured()
    img = ctx.image()

    runs: list[dict[str, Any]] = []
    source = doc.kind
    for el in doc.all_text:
        if el.text.strip() and el.font_size_pt > 0:
            runs.append(
                {
                    "text": el.text[:60],
                    "sizePt": round(el.font_size_pt, 2),
                    "bbox": [round(v, 4) for v in el.bbox],
                    "exact": True,
                }
            )
    if not runs:
        spans = ctx.text_spans()
        source = spans[0].source if spans else "none"
        for span in spans:
            height_px = (span.bbox[3] - span.bbox[1]) * (img.height if img else 0)
            # A rendered glyph box is cap-height-ish, not em size; 0.72 is the
            # usual ratio and keeps the estimate from over-reporting failures.
            est_pt = (span.font_size_pt_estimate or (height_px * 72.0 / max(ctx.dpi, 1e-6))) / 0.72
            if est_pt > 0:
                runs.append(
                    {
                        "text": span.text[:60],
                        "sizePt": round(est_pt, 2),
                        "bbox": [round(v, 4) for v in span.bbox],
                        "exact": False,
                    }
                )

    if not runs:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"runs": 0, "source": source, "ocrDriver": ctx.settings.ocr_driver},
            observation="No text run with a measurable size was found in this asset.",
        )

    exact = all(bool(r["exact"]) for r in runs)
    offenders = [r for r in runs if float(r["sizePt"]) + 1e-6 < floor_pt]
    smallest = min(runs, key=lambda r: float(r["sizePt"]))
    measured = {
        "source": source,
        "exactSizes": exact,
        "runCount": len(runs),
        "smallestPt": float(smallest["sizePt"]),
        "offenderCount": len(offenders),
        "offenders": sorted(offenders, key=lambda r: float(r["sizePt"]))[:20],
    }
    thresholds = {"minSizePt": floor_pt}

    if offenders:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(smallest["bbox"]),  # type: ignore[arg-type]
            quoted_text=str(smallest["text"]),
            observation=(
                f"{len(offenders)} run(s) below the {floor_pt}pt accessibility floor; "
                f"smallest is {smallest['sizePt']}pt"
                + ("." if exact else " (estimated from pixel geometry).")
            ),
            suggested_fix=f"Raise all type to at least {floor_pt}pt.",
            confidence=0.95 if exact else 0.65,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Smallest type is {smallest['sizePt']}pt, at or above the {floor_pt}pt floor.",
        confidence=0.95 if exact else 0.65,
    )


# ---------------------------------------------------------------------------
# accessibility.alt_text
# ---------------------------------------------------------------------------
_LOW_VALUE_ALT = {
    "image", "photo", "picture", "graphic", "img", "logo", "icon", "banner",
    "spacer", "untitled", "screenshot", "dsc", "img_", "photograph",
}


def check_alt_text(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Present, and *adequate* — length, non-redundancy, no filename residue.

    "image" as alt text technically satisfies a presence check and helps nobody,
    so adequacy is scored rather than presence alone.
    """
    params = rule.check.params
    min_chars = int(params.get("minChars", 12))
    max_chars = int(params.get("maxChars", 250))

    alt_keys = ("alt", "alttext", "altattribute", "accessibilitylabel", "ariallabel", "arialabel")
    candidates: dict[str, str] = {}
    body_fields: list[str] = []
    for key, value in (ctx.asset.copy_fields or {}).items():
        k = key.lower().replace("-", "").replace("_", "").replace(" ", "")
        if k in alt_keys:
            candidates[key] = value
        else:
            body_fields.append(value)
    structured_alt = (ctx.asset.structured_source or {}).get("altText")
    if isinstance(structured_alt, str) and structured_alt.strip():
        candidates["structuredSource.altText"] = structured_alt

    if not candidates:
        needs_alt = ctx.asset.kind in ("image", "pdf", "figma", "pptx", "psd", "html")
        return build_result(
            rule,
            "fail" if needs_alt else "not_applicable",
            measured={"altFields": 0, "assetKind": ctx.asset.kind},
            threshold={"minChars": min_chars, "maxChars": max_chars},
            observation=(
                "No alt text was supplied for a visual asset."
                if needs_alt
                else f"Asset kind {ctx.asset.kind!r} does not require alt text."
            ),
            suggested_fix="Add descriptive alt text conveying the information the image carries."
            if needs_alt
            else None,
            confidence=0.9,
        )

    problems: list[dict[str, Any]] = []
    evaluated: list[dict[str, Any]] = []
    # The alt fields themselves are excluded, or every alt text trivially
    # "duplicates the body copy" and the redundancy check fires on everything.
    body_text = " ".join(body_fields).strip().lower()

    for key, raw in candidates.items():
        alt = (raw or "").strip()
        issues: list[str] = []
        words = [w for w in alt.split() if w]
        low = alt.lower().rstrip(".").strip()
        if len(alt) < min_chars:
            issues.append(f"too short ({len(alt)} chars, minimum {min_chars})")
        if len(alt) > max_chars:
            issues.append(f"too long ({len(alt)} chars, maximum {max_chars})")
        if low in _LOW_VALUE_ALT or (len(words) <= 2 and any(w.lower() in _LOW_VALUE_ALT for w in words)):
            issues.append("generic placeholder text conveys no information")
        if any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg")):
            issues.append("looks like a filename")
        if low.startswith(("image of", "picture of", "photo of", "graphic of")):
            issues.append("redundant 'image of' prefix (screen readers already announce the role)")
        if body_text and low and low in body_text and len(low) > 15:
            issues.append("duplicates visible body copy, so it adds nothing for a screen-reader user")
        record = {"field": key, "text": alt[:200], "chars": len(alt), "issues": issues}
        evaluated.append(record)
        if issues:
            problems.append(record)

    measured = {"altFields": len(candidates), "evaluated": evaluated, "problemCount": len(problems)}
    thresholds = {"minChars": min_chars, "maxChars": max_chars}
    if problems:
        first = problems[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            quoted_text=str(first["text"])[:200],
            observation=f"Alt text on {first['field']!r} is inadequate: {'; '.join(first['issues'])}.",
            suggested_fix="Describe the information the image conveys, in one sentence, without 'image of'.",
            confidence=0.9,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        quoted_text=str(evaluated[0]["text"])[:200],
        observation=f"{len(evaluated)} alt-text field(s) present and adequate.",
        confidence=0.9,
    )


__all__ = ["apca_lc", "check_alt_text", "check_contrast", "check_font_size_floor", "worst_case"]
