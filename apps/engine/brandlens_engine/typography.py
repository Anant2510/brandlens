"""Typography checks.

All five analyzers here are `deterministic` when a structured source exists,
because a PDF/PPTX/Figma file *states* its fonts and sizes. Without one they
degrade to `insufficient_evidence` rather than guessing a family from pixels:
"looks like Helvetica" is exactly the kind of confident-but-wrong finding that
makes a reviewer stop trusting the tool.

Family matching is fuzzy on purpose. The same face legitimately appears as
"Helvetica Neue", "HelveticaNeue-Roman", "TT0011M_" (subset) and "Helvetica
Neue LT Std"; an exact-match rule fails all but one and generates noise.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from rapidfuzz import fuzz, process

from .models import RuleDefinition, TypeStyle, build_result
from .structured import TextElement, normalize_font_name

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

#: Substituted when the requested family is missing. Seeing one of these in an
#: asset that *specifies* a brand face means the reader saw the fallback.
GENERIC_FALLBACKS = {
    "arial", "helvetica", "times new roman", "times", "courier", "courier new",
    "sans serif", "sans-serif", "serif", "monospace", "system ui", "system-ui",
    "segoe ui", "calibri", "cambria", "verdana", "tahoma", "geneva", "georgia",
    "liberation sans", "liberation serif", "dejavu sans", "nimbus sans",
    "roboto", "noto sans", "-apple-system", "blinkmacsystemfont",
}

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def canonical_family(name: str) -> str:
    """Lowercase, punctuation-free family key used for all comparisons."""
    return _NON_ALNUM.sub(" ", normalize_font_name(name).lower()).strip()


@dataclass(slots=True)
class FamilyMatch:
    style: TypeStyle | None
    score: float
    matched_alias: str | None = None
    exact: bool = False


def resolve_family(
    observed: str, styles: list[TypeStyle], threshold: float = 88.0
) -> FamilyMatch:
    """Map an observed font name onto an approved type style.

    RapidFuzz `token_set_ratio` handles the reorderings and extra words real
    font names carry ("Neue Haas Grotesk Display Pro" vs "Neue Haas Grotesk").
    """
    key = canonical_family(observed)
    if not key or not styles:
        return FamilyMatch(style=None, score=0.0)

    candidates: dict[str, tuple[TypeStyle, str]] = {}
    for style in styles:
        for name in [style.font_family, *style.font_aliases]:
            ck = canonical_family(name)
            if ck:
                candidates.setdefault(ck, (style, name))

    if key in candidates:
        style, alias = candidates[key]
        return FamilyMatch(style=style, score=100.0, matched_alias=alias, exact=True)

    best = process.extractOne(key, list(candidates.keys()), scorer=fuzz.token_set_ratio)
    if best and best[1] >= threshold:
        style, alias = candidates[best[0]]
        return FamilyMatch(style=style, score=float(best[1]), matched_alias=alias)
    return FamilyMatch(style=None, score=float(best[1]) if best else 0.0)


def is_generic_fallback(name: str) -> bool:
    key = canonical_family(name)
    return any(key == g or key.startswith(f"{g} ") for g in (canonical_family(x) for x in GENERIC_FALLBACKS))


def effective_min_size_pt(style: TypeStyle, canvas_height_px: float, dpi: float) -> tuple[float | None, str]:
    """Resolve a style's size floor into points, whichever unit it was authored in."""
    if style.min_size_pt is not None:
        return float(style.min_size_pt), "minSizePt"
    if style.min_size_px is not None:
        return float(style.min_size_px) * 72.0 / max(dpi, 1e-6), "minSizePx"
    if style.min_size_pct_of_canvas is not None and canvas_height_px > 0:
        px = float(style.min_size_pct_of_canvas) / 100.0 * canvas_height_px
        return px * 72.0 / max(dpi, 1e-6), "minSizePctOfCanvas"
    return None, "none"


def _elements(ctx: AnalysisContext) -> list[TextElement]:
    return [e for e in ctx.structured().all_text if e.text.strip()]


def _no_structure(ctx: AnalysisContext, rule: RuleDefinition, what: str) -> CriterionResult:
    return build_result(
        rule,
        "insufficient_evidence",
        observation=(
            f"{what} requires a structured source (PDF/PPTX/Figma/HTML). This asset is "
            f"{ctx.asset.kind!r} with no parsable structure, and inferring font identity from "
            "pixels is not reliable enough to assert a violation."
        ),
        measured={"structuredSource": ctx.structured().kind, "textElements": 0},
    )


# ---------------------------------------------------------------------------
# typography.approved_family
# ---------------------------------------------------------------------------
def check_approved_family(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    elements = _elements(ctx)
    if not elements:
        return _no_structure(ctx, rule, "Font family verification")

    params = rule.check.params
    threshold = float(params.get("fuzzyThreshold", 88.0))
    min_chars = int(params.get("minChars", 3))
    styles = ctx.brand.type_styles
    forbidden = {canonical_family(f.font_family): f for f in ctx.brand.forbidden_fonts}

    observed: dict[str, dict[str, object]] = {}
    violations: list[dict[str, object]] = []
    for el in elements:
        if len(el.text.strip()) < min_chars or not el.font_family:
            continue
        key = canonical_family(el.font_family)
        entry = observed.setdefault(key, {"name": el.font_family, "chars": 0, "sizes": []})
        entry["chars"] = int(entry["chars"]) + len(el.text)  # type: ignore[arg-type]
        sizes = entry["sizes"]
        assert isinstance(sizes, list)
        sizes.append(round(el.font_size_pt, 1))

        if key in forbidden:
            violations.append(
                {
                    "font": el.font_family,
                    "reason": forbidden[key].reason or "explicitly forbidden",
                    "bbox": [round(v, 4) for v in el.bbox],
                    "sample": el.text[:60],
                    "kind": "forbidden",
                }
            )
            continue
        match = resolve_family(el.font_family, styles, threshold)
        if match.style is None:
            violations.append(
                {
                    "font": el.font_family,
                    "bestScore": round(match.score, 1),
                    "bbox": [round(v, 4) for v in el.bbox],
                    "sample": el.text[:60],
                    "kind": "unapproved",
                }
            )

    measured = {
        "observedFamilies": [
            {"family": v["name"], "chars": v["chars"], "sizesPt": sorted(set(v["sizes"]))}  # type: ignore[index]
            for v in observed.values()
        ],
        "violationCount": len(violations),
        "violations": violations[:20],
        "source": ctx.structured().kind,
    }
    thresholds = {
        "approvedFamilies": [s.font_family for s in styles],
        "aliases": {s.font_family: s.font_aliases for s in styles if s.font_aliases},
        "forbiddenFamilies": [f.font_family for f in ctx.brand.forbidden_fonts],
        "fuzzyThreshold": threshold,
    }

    if not styles and not forbidden:
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            threshold=thresholds,
            observation="No approved or forbidden type styles are defined for this brand.",
        )
    if violations:
        worst = violations[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type]
            quoted_text=str(worst["sample"]),
            observation=(
                f"{len(violations)} text run(s) use a font outside the approved set; "
                f"first offender is {worst['font']!r}."
            ),
            suggested_fix=(
                f"Replace {worst['font']!r} with "
                f"{styles[0].font_family if styles else 'an approved family'}."
            ),
            confidence=0.99,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"All {len(observed)} observed families resolve to approved type styles.",
        confidence=0.99,
    )


# ---------------------------------------------------------------------------
# typography.min_size
# ---------------------------------------------------------------------------
def check_min_size(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    elements = _elements(ctx)
    if not elements:
        return _no_structure(ctx, rule, "Font size verification")

    params = rule.check.params
    explicit_floor = params.get("minSizePt")
    styles = ctx.brand.type_styles
    canvas_h = float(ctx.asset.height or (ctx.image().height if ctx.image() else 0) or 0)
    dpi = ctx.dpi

    offenders: list[dict[str, object]] = []
    smallest: tuple[float, TextElement] | None = None
    for el in elements:
        if el.font_size_pt <= 0:
            continue
        if smallest is None or el.font_size_pt < smallest[0]:
            smallest = (el.font_size_pt, el)

        if explicit_floor is not None:
            floor, basis = float(explicit_floor), "rule.params.minSizePt"
        else:
            match = resolve_family(el.font_family, styles)
            if match.style is None:
                continue
            resolved, basis = effective_min_size_pt(match.style, canvas_h, dpi)
            if resolved is None:
                continue
            floor = resolved
        if el.font_size_pt + 1e-6 < floor:
            offenders.append(
                {
                    "text": el.text[:60],
                    "sizePt": round(el.font_size_pt, 2),
                    "floorPt": round(floor, 2),
                    "basis": basis,
                    "bbox": [round(v, 4) for v in el.bbox],
                }
            )

    measured = {
        "smallestPt": round(smallest[0], 2) if smallest else None,
        "smallestText": smallest[1].text[:60] if smallest else None,
        "offenderCount": len(offenders),
        "offenders": offenders[:20],
        "source": ctx.structured().kind,
        "dpi": dpi,
    }
    thresholds = {
        "minSizePt": explicit_floor,
        "perStyle": {
            s.name: effective_min_size_pt(s, canvas_h, dpi)[0] for s in styles
        },
    }

    if explicit_floor is None and not any(v is not None for v in thresholds["perStyle"].values()):  # type: ignore[union-attr]
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            threshold=thresholds,
            observation="No size floor is defined on the rule or on any approved type style.",
        )
    if offenders:
        worst = min(offenders, key=lambda o: float(o["sizePt"]))  # type: ignore[arg-type]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["bbox"]),  # type: ignore[arg-type]
            quoted_text=str(worst["text"]),
            observation=(
                f"{len(offenders)} run(s) below the size floor; smallest is "
                f"{worst['sizePt']}pt against a floor of {worst['floorPt']}pt."
            ),
            suggested_fix=f"Raise the smallest type to at least {worst['floorPt']}pt.",
            confidence=0.99,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Smallest type is {measured['smallestPt']}pt, at or above every applicable floor.",
        confidence=0.99,
    )


# ---------------------------------------------------------------------------
# typography.hierarchy
# ---------------------------------------------------------------------------
def check_hierarchy(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Does the type scale actually separate the levels it claims to?

    Two failures matter: a rank inversion (body set larger than the headline)
    and insufficient contrast between adjacent ranks, which reads as "everything
    is the same size" even when the numbers technically differ.
    """
    elements = _elements(ctx)
    if not elements:
        return _no_structure(ctx, rule, "Type hierarchy verification")

    params = rule.check.params
    min_ratio = float(params.get("minStepRatio", 1.15))
    ranked = [s for s in ctx.brand.type_styles if s.scale_rank is not None]
    if not ranked:
        return build_result(
            rule,
            "not_applicable",
            measured={"rankedStyles": 0},
            observation="No type styles carry a scaleRank, so there is no declared hierarchy to verify.",
        )

    by_rank: dict[float, list[float]] = {}
    for el in elements:
        match = resolve_family(el.font_family, ranked)
        if match.style is None or match.style.scale_rank is None:
            continue
        # Weight matters: a 24pt regular and a 24pt bold are different levels.
        if match.style.font_weight and abs(match.style.font_weight - el.font_weight) > 250:
            continue
        by_rank.setdefault(float(match.style.scale_rank), []).append(el.font_size_pt)

    observed = {r: round(float(sum(v) / len(v)), 2) for r, v in sorted(by_rank.items()) if v}
    if len(observed) < 2:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"observedByRank": observed, "source": ctx.structured().kind},
            observation="Fewer than two ranked levels appear in this asset; hierarchy cannot be assessed.",
        )

    ranks = sorted(observed.keys())
    problems: list[dict[str, object]] = []
    for lower, higher in zip(ranks, ranks[1:], strict=False):
        # Convention: rank 1 is the largest, so size must be non-increasing.
        big, small = observed[lower], observed[higher]
        if small >= big:
            problems.append({"kind": "inversion", "ranks": [lower, higher], "sizesPt": [big, small]})
        elif big / max(small, 1e-6) < min_ratio:
            problems.append(
                {
                    "kind": "insufficient-step",
                    "ranks": [lower, higher],
                    "sizesPt": [big, small],
                    "ratio": round(big / max(small, 1e-6), 3),
                }
            )

    measured = {"observedByRank": observed, "problems": problems, "source": ctx.structured().kind}
    thresholds = {"minStepRatio": min_ratio, "declaredRanks": ranks}
    if problems:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"{len(problems)} hierarchy problem(s): "
                + "; ".join(f"{p['kind']} between ranks {p['ranks']}" for p in problems[:3])
            ),
            suggested_fix=f"Separate adjacent levels by at least {min_ratio}x in point size.",
            confidence=0.9,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"Type scale is monotonic across {len(ranks)} ranks with steps of at least {min_ratio}x.",
        confidence=0.9,
    )


# ---------------------------------------------------------------------------
# typography.fallback_font
# ---------------------------------------------------------------------------
def check_fallback_font(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Did the reader actually see the brand face?

    Three independent signals, any of which means "no": a generic system family
    in use, a non-embedded font in a print-bound PDF, or synthesised bold/italic
    (faux styling), which is what a renderer does when the real cut is missing.
    """
    doc = ctx.structured()
    elements = _elements(ctx)
    if not elements:
        return _no_structure(ctx, rule, "Fallback-font detection")

    generic: list[dict[str, object]] = []
    non_embedded: list[str] = []
    faux: list[dict[str, object]] = []
    seen: set[str] = set()

    for el in elements:
        if not el.font_family:
            continue
        key = canonical_family(el.font_family)
        if is_generic_fallback(el.font_family) and key not in seen:
            approved = resolve_family(el.font_family, ctx.brand.type_styles)
            if approved.style is None:  # a brand that *approves* Arial is not failing
                generic.append({"font": el.font_family, "sample": el.text[:50],
                                "bbox": [round(v, 4) for v in el.bbox]})
                seen.add(key)
        if el.is_faux_bold or el.is_faux_italic:
            faux.append(
                {
                    "font": el.font_family,
                    "fauxBold": el.is_faux_bold,
                    "fauxItalic": el.is_faux_italic,
                    "sample": el.text[:50],
                    "bbox": [round(v, 4) for v in el.bbox],
                }
            )

    if doc.kind == "pdf":
        non_embedded = [fam for fam, embedded in doc.fonts.items() if not embedded]

    measured = {
        "genericFallbacks": generic[:10],
        "nonEmbeddedFonts": non_embedded[:10],
        "fauxStyling": faux[:10],
        "source": doc.kind,
        "fontInventory": doc.fonts,
    }
    thresholds = {"allowGenericFallback": False, "requireEmbedded": doc.kind == "pdf", "allowFauxStyling": False}

    problems = len(generic) + len(non_embedded) + len(faux)
    if problems == 0:
        return build_result(
            rule,
            "pass",
            measured=measured,
            threshold=thresholds,
            observation="No generic substitutions, missing embeds or synthesised styles detected.",
            confidence=0.95,
        )

    parts: list[str] = []
    if generic:
        parts.append(f"{len(generic)} generic system font(s) in use ({generic[0]['font']})")
    if non_embedded:
        parts.append(f"{len(non_embedded)} font(s) not embedded ({', '.join(non_embedded[:3])})")
    if faux:
        parts.append(f"{len(faux)} run(s) using synthesised bold/italic")
    first_bbox = (generic or faux or [{}])[0].get("bbox")
    return build_result(
        rule,
        "fail",
        measured=measured,
        threshold=thresholds,
        bbox=tuple(first_bbox) if first_bbox else None,  # type: ignore[arg-type]
        observation="; ".join(parts) + ".",
        suggested_fix="Embed the brand faces and use their real bold/italic cuts instead of synthesised styling.",
        confidence=0.95,
    )


# ---------------------------------------------------------------------------
# typography.casing
# ---------------------------------------------------------------------------
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _casing_of(text: str) -> str:
    stripped = text.strip()
    letters = [c for c in stripped if c.isalpha()]
    if not letters:
        return "none"
    if all(c.isupper() for c in letters):
        return "upper"
    if all(c.islower() for c in letters):
        return "lower"
    words = [w for w in re.split(r"\s+", stripped) if any(c.isalpha() for c in w)]
    if len(words) > 1 and all(w[0].isupper() for w in words if w[0].isalpha()):
        return "title"
    if stripped[0].isupper():
        return "sentence"
    return "mixed"


def check_casing(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Enforce per-style casing rules (e.g. headlines are sentence case)."""
    elements = _elements(ctx)
    if not elements:
        return _no_structure(ctx, rule, "Casing verification")

    params = rule.check.params
    forced = params.get("casing")
    min_chars = int(params.get("minChars", 8))
    max_upper_ratio = params.get("maxAllCapsRatio")

    offenders: list[dict[str, object]] = []
    counts: dict[str, int] = {}
    total_chars = 0
    upper_chars = 0

    for el in elements:
        text = el.text.strip()
        if len(text) < min_chars:
            continue
        casing = _casing_of(text)
        counts[casing] = counts.get(casing, 0) + 1
        total_chars += len(text)
        if casing == "upper":
            upper_chars += len(text)

        expected = forced
        if expected is None:
            match = resolve_family(el.font_family, ctx.brand.type_styles)
            if match.style is not None:
                expected = match.style.casing_rules.get("casing") or match.style.casing_rules.get("case")
        if expected and casing != "none" and str(expected).lower() != casing:
            offenders.append(
                {
                    "text": text[:60],
                    "observed": casing,
                    "expected": str(expected).lower(),
                    "bbox": [round(v, 4) for v in el.bbox],
                }
            )

    upper_ratio = round(upper_chars / total_chars, 4) if total_chars else 0.0
    measured = {
        "casingCounts": counts,
        "allCapsCharRatio": upper_ratio,
        "offenderCount": len(offenders),
        "offenders": offenders[:15],
        "source": ctx.structured().kind,
    }
    thresholds = {"casing": forced, "maxAllCapsRatio": max_upper_ratio}

    if forced is None and max_upper_ratio is None and not any(
        s.casing_rules for s in ctx.brand.type_styles
    ):
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            threshold=thresholds,
            observation="No casing rule is configured on the rule or on any type style.",
        )

    if max_upper_ratio is not None and upper_ratio > float(max_upper_ratio):
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"{upper_ratio:.0%} of body characters are set in all caps, above the "
                f"{float(max_upper_ratio):.0%} ceiling. Long all-caps passages measurably slow reading."
            ),
            suggested_fix="Reserve all caps for short labels; set longer text in sentence case.",
            confidence=0.95,
        )
    if offenders:
        first = offenders[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            bbox=tuple(first["bbox"]),  # type: ignore[arg-type]
            quoted_text=str(first["text"]),
            observation=(
                f"{len(offenders)} run(s) use the wrong casing; first is {first['observed']} "
                f"where {first['expected']} is required."
            ),
            suggested_fix=f"Reset the flagged runs to {first['expected']} case.",
            confidence=0.95,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation="Casing matches the configured rules on every measurable run.",
        confidence=0.95,
    )


__all__ = [
    "FamilyMatch",
    "canonical_family",
    "check_approved_family",
    "check_casing",
    "check_fallback_font",
    "check_hierarchy",
    "check_min_size",
    "effective_min_size_pt",
    "is_generic_fallback",
    "resolve_family",
]
