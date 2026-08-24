"""Brief -> assembly plan, constrained by the active ruleset.

The point of doing assembly *here* rather than in a generic layout tool is that
the same rules that would fail the finished asset are applied as constraints
before anything is built. Hard constraints (channel spec, safe zones, minimum
logo size, mandatory disclaimers) are enforced in code and are not negotiable by
the model; the model only chooses among options that already satisfy them.

If no provider is configured the endpoint still works: candidate ranking and
constraint solving are deterministic, and only the narrative rationale is lost.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from .channel_spec import resolve_spec, safe_zone_rects, spec_dimensions
from .config import Settings, get_settings
from .llm.base import LLMError, NullProvider
from .llm.factory import build_provider, canonical_provider
from .logging import get_logger
from .models import AssembleRequest, AssembleResponse, RuleDefinition

log = get_logger(__name__)


def collect_constraints(rules: list[RuleDefinition], brand_channel_spec: dict[str, Any] | None, target: dict[str, Any]) -> dict[str, Any]:
    """Flatten the active ruleset into a constraint bundle for one target."""
    channel = str(target.get("channel") or "")
    asset_type = str(target.get("assetType") or target.get("asset_type") or "")
    spec, spec_key = resolve_spec(brand_channel_spec, channel or None, asset_type or None)

    constraints: dict[str, Any] = {
        "channel": channel or None,
        "assetType": asset_type or None,
        "spec": spec or {},
        "specKey": spec_key,
        "safeZones": [],
        "minLogoHeightPct": None,
        "minMarginPct": None,
        "minFontSizePt": None,
        "mandatoryText": [],
        "bannedTerms": [],
        "allowedCtas": None,
        "maxOccupiedTextCells": None,
    }

    # The placement's published safe zones, before any rule is consulted: they
    # are what the channel will draw over regardless of what anybody authored,
    # and a plan that puts the CTA under TikTok's caption bar is wrong however
    # well it satisfies the ruleset.
    constraints["safeZones"].extend(safe_zone_rects(spec))

    for rule in rules:
        if rule.status not in ("active", "proposed"):
            continue
        params = rule.check.params
        fn = rule.check.fn
        if fn == "layout.safe_zone":
            zones = params.get("zones") or params.get("safeZones") or []
            constraints["safeZones"].extend([z for z in zones if isinstance(z, dict)])
        elif fn == "layout.margins":
            value = params.get("minMarginPct")
            if value is not None:
                constraints["minMarginPct"] = max(constraints["minMarginPct"] or 0.0, float(value))
        elif fn == "logo.min_size":
            value = params.get("minHeightPct")
            if value is not None:
                constraints["minLogoHeightPct"] = max(constraints["minLogoHeightPct"] or 0.0, float(value))
        elif fn in ("typography.min_size", "accessibility.font_size_floor"):
            value = params.get("minSizePt")
            if value is not None:
                constraints["minFontSizePt"] = max(constraints["minFontSizePt"] or 0.0, float(value))
        elif fn == "copy.required_terms":
            constraints["mandatoryText"].extend([str(t) for t in (params.get("terms") or [])])
        elif fn == "copy.banned_terms":
            constraints["bannedTerms"].extend([str(t) for t in (params.get("terms") or [])])
        elif fn == "copy.cta_allowlist":
            allowed = params.get("allowedCtas") or params.get("allowed")
            if allowed:
                constraints["allowedCtas"] = [str(a) for a in allowed]
        elif fn == "layout.text_density":
            value = params.get("maxOccupiedCells")
            if value is not None:
                constraints["maxOccupiedTextCells"] = int(value)
        elif fn == "channel_spec.conformance" and params.get("spec"):
            merged = dict(constraints["spec"])
            merged.update(params["spec"])
            constraints["spec"] = merged

    return constraints


def score_candidate(candidate: Any, target: dict[str, Any], constraints: dict[str, Any], brief_tags: set[str]) -> tuple[float, list[str]]:
    """Deterministic fit score with an explanation of every deduction."""
    reasons: list[str] = []
    score = float(candidate.score) if candidate.score is not None else 0.5

    size = spec_dimensions(constraints.get("spec"))
    want_w = (size[0] if size else None) or target.get("width")
    want_h = (size[1] if size else None) or target.get("height")
    if want_w and want_h and candidate.width and candidate.height:
        target_aspect = float(want_w) / max(float(want_h), 1e-6)
        cand_aspect = float(candidate.width) / max(float(candidate.height), 1e-6)
        # How much of the source survives the re-crop. Half the image lost is a
        # different photograph, not a resize.
        keep = min(target_aspect, cand_aspect) / max(target_aspect, cand_aspect)
        score *= 0.4 + 0.6 * keep
        if keep < 0.7:
            reasons.append(f"aspect mismatch: {(1 - keep):.0%} of the source is cropped away")
        if float(candidate.width) < float(want_w) or float(candidate.height) < float(want_h):
            score *= 0.35
            reasons.append(
                f"upscaling required ({int(candidate.width)}x{int(candidate.height)} -> "
                f"{int(want_w)}x{int(want_h)})"
            )

    tags = {t.lower() for t in candidate.tags}
    if brief_tags:
        overlap = len(tags & brief_tags) / max(len(brief_tags), 1)
        score *= 0.6 + 0.4 * overlap
        if overlap == 0:
            reasons.append("no tag overlap with the brief")
        else:
            reasons.append(f"{overlap:.0%} tag overlap with the brief")

    channel = constraints.get("channel")
    if channel and channel.lower() in tags:
        score *= 1.15
        reasons.append(f"tagged for {channel}")

    return round(min(1.0, score), 4), reasons


def _brief_tags(brief: Any) -> set[str]:
    """The words that describe what should be IN the picture.

    `mandatories` used to be folded in here, and it is a category error that
    quietly disabled candidate ranking: a mandatory is text the asset must
    CARRY — a brand name, a disclaimer, a risk warning — while a candidate's
    tags describe what the photograph SHOWS. "Northwind" and "Subscribe" will
    never overlap with "hero", "pour", "beans". So the overlap was almost
    always zero, every candidate took the same 0.6 multiplier, and the ranking
    collapsed to input order while still reporting a confident-looking score.

    What is left is the fields that genuinely describe content: an explicit tag
    list, and the words of the objective and key message. Free text is a weak
    signal, which is why it is a signal rather than a filter — a brief that
    says "warm autumn pour" should prefer the photograph tagged `pour`.
    """
    tags: set[str] = set()

    audience = brief.audience if isinstance(brief.audience, dict) else {}
    for tag in audience.get("tags", []) or []:
        if isinstance(tag, str) and tag.strip():
            tags.add(tag.strip().lower())

    for phrase in (brief.objective, brief.key_message, brief.title):
        if not isinstance(phrase, str):
            continue
        for word in re.findall(r"[a-z]{4,}", phrase.lower()):
            if word not in _STOPWORDS:
                tags.add(word)

    return tags


#: Words that appear in every brief and would match every candidate.
_STOPWORDS = frozenset(
    {
        "with", "that", "this", "from", "your", "our", "and", "the", "for", "into",
        "drive", "make", "help", "want", "need", "more", "than", "them", "they",
        "campaign", "creative", "asset", "assets", "brand", "audience", "customers",
        "signups", "launch", "push", "across", "every", "must", "should", "using",
    }
)


def build_plan(request: AssembleRequest) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    brief_tags = _brief_tags(request.brief)
    targets = request.brief.targets or [{"channel": None, "assetType": None}]
    items: list[dict[str, Any]] = []
    applied: dict[str, Any] = {}

    for target in targets:
        constraints = collect_constraints(request.rules, request.brand.channel_spec, target)
        label = f"{target.get('channel') or 'any'}:{target.get('assetType') or 'any'}"
        applied[label] = constraints

        ranked = sorted(
            (
                (candidate, *score_candidate(candidate, target, constraints, brief_tags))
                for candidate in request.candidate_assets
            ),
            key=lambda row: -row[1],
        )

        chosen = ranked[0] if ranked else None
        size = spec_dimensions(constraints.get("spec"))
        width = (size[0] if size else None) or target.get("width")
        height = (size[1] if size else None) or target.get("height")

        mandatory = list(dict.fromkeys(request.brief.mandatories + constraints["mandatoryText"]))
        for disclaimer in request.brand.disclaimers:
            channels = disclaimer.channels
            if not channels or (target.get("channel") in channels):
                mandatory.append(disclaimer.text)

        items.append(
            {
                "target": label,
                "channel": target.get("channel"),
                "assetType": target.get("assetType"),
                "widthPx": int(width) if width else None,
                "heightPx": int(height) if height else None,
                "backgroundAssetId": chosen[0].id if chosen else None,
                "backgroundAssetName": chosen[0].name if chosen else None,
                "fitScore": chosen[1] if chosen else None,
                "fitNotes": chosen[2] if chosen else ["no candidate assets supplied"],
                "alternatives": [
                    {"id": c.id, "name": c.name, "score": sc} for c, sc, _r in ranked[1:4]
                ],
                "layout": _layout_slots(constraints, request.brief.key_message),
                "mandatoryText": mandatory,
                "cta": (constraints.get("allowedCtas") or [None])[0],
                "constraintsEnforced": {
                    "minLogoHeightPct": constraints["minLogoHeightPct"],
                    "minMarginPct": constraints["minMarginPct"],
                    "minFontSizePt": constraints["minFontSizePt"],
                    "safeZoneCount": len(constraints["safeZones"]),
                },
            }
        )
    return items, applied


def _layout_slots(constraints: dict[str, Any], key_message: str | None) -> list[dict[str, Any]]:
    """Place the slots so the hard constraints hold by construction."""
    margin = float(constraints.get("minMarginPct") or 5.0) / 100.0
    logo_h = float(constraints.get("minLogoHeightPct") or 6.0) / 100.0
    zones = constraints.get("safeZones") or []
    # Reserve the union of the safe zones off the bottom, which is where
    # channel furniture (captions, CTAs, progress bars) almost always lives.
    reserved_bottom = max(
        [1.0 - float(z["bbox"][1]) for z in zones if isinstance(z.get("bbox"), (list, tuple)) and len(z["bbox"]) >= 4 and float(z["bbox"][3]) > 0.9],
        default=0.0,
    )
    usable_bottom = 1.0 - max(margin, reserved_bottom)

    return [
        {
            "slot": "logo",
            "bbox": [margin, margin, margin + logo_h * 2.5, margin + logo_h],
            "minHeightPct": round(logo_h * 100, 2),
        },
        {
            "slot": "headline",
            "bbox": [margin, margin + logo_h + 0.04, 1.0 - margin, margin + logo_h + 0.24],
            "text": key_message,
            "minFontSizePt": constraints.get("minFontSizePt"),
        },
        {
            "slot": "cta",
            "bbox": [margin, max(margin, usable_bottom - 0.12), margin + 0.32, usable_bottom],
        },
        {
            "slot": "legal",
            "bbox": [margin, max(margin, usable_bottom - 0.05), 1.0 - margin, usable_bottom],
            "minFontSizePt": constraints.get("minFontSizePt"),
        },
    ]


_RATIONALE_SYSTEM = """You explain an assembly plan to a marketer in plain language.

The plan was produced by a constraint solver: every geometric and legal constraint is
already satisfied and is NOT up for discussion. Do not propose changes that would break
a listed constraint, and do not invent assets that are not in the plan.

Write 3-6 sentences: what was chosen, why it fits the brief, and the single biggest
risk to watch in review.
"""


def assemble(request: AssembleRequest, settings: Settings | None = None) -> AssembleResponse:
    s = settings or get_settings()
    items, applied = build_plan(request)

    rationale_parts = [
        f"{len(items)} placement(s) planned against {len(request.candidate_assets)} candidate asset(s), "
        f"constrained by {len(request.rules)} active rule(s)."
    ]
    cost = 0.0

    provider = build_provider(canonical_provider(request.provider), request.model, s)
    if isinstance(provider, NullProvider):
        rationale_parts.append(f"Narrative rationale unavailable: {provider.reason}.")
    else:
        try:
            completion = provider.complete(
                system=_RATIONALE_SYSTEM,
                prompt=(
                    f"BRIEF:\n{request.brief.model_dump_json(by_alias=True)}\n\n"
                    f"PLAN:\n{json.dumps(items, default=str)[:6000]}\n\n"
                    f"CONSTRAINTS ENFORCED:\n{json.dumps(applied, default=str)[:3000]}"
                ),
                temperature=0.2,
                max_tokens=600,
            )
            cost = completion.cost_usd
            if completion.text.strip():
                rationale_parts.append(completion.text.strip())
        except LLMError as exc:
            rationale_parts.append(f"Narrative rationale failed: {exc}.")

    return AssembleResponse(
        request_id=request.request_id,
        items=items,
        constraints_applied=applied,
        rationale=" ".join(rationale_parts),
        cost_usd=round(cost, 6),
    )


def crop_loss(src_w: float, src_h: float, dst_w: float, dst_h: float) -> float:
    """Fraction of the source lost when re-cropping to a target aspect."""
    if min(src_w, src_h, dst_w, dst_h) <= 0:
        return 1.0
    src = src_w / src_h
    dst = dst_w / dst_h
    if math.isclose(src, dst, rel_tol=1e-3):
        return 0.0
    return round(1.0 - (min(src, dst) / max(src, dst)), 4)


__all__ = ["assemble", "build_plan", "collect_constraints", "crop_loss", "score_candidate"]
