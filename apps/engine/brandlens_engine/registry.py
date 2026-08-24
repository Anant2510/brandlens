"""Analyzer registry: `rule.check.fn` -> callable.

Every analyzer has the same shape — `(ctx, rule) -> CriterionResult` — which is
what lets the control plane add a rule without an engine deploy, and what lets
the pipeline schedule by tier without knowing what any individual check does.

An unregistered `fn` is a configuration error, not a crash: the pipeline turns
it into `insufficient_evidence` with the name in the observation, so a typo in
a rule shows up as one unevaluated criterion rather than a failed run.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from . import accessibility, channel_spec, color, copy_checks, imagery, judge, layout, logo, typography
from .models import CheckTier

if TYPE_CHECKING:
    from .models import CriterionResult, RuleDefinition
    from .pipeline import AnalysisContext

Analyzer = Callable[["AnalysisContext", "RuleDefinition"], "CriterionResult"]

ANALYZERS: dict[str, Analyzer] = {
    # -- logo -----------------------------------------------------------------
    "logo.presence": logo.check_presence,
    "logo.clearspace": logo.check_clearspace,
    "logo.min_size": logo.check_min_size,
    "logo.distortion": logo.check_distortion,
    "logo.recolor": logo.check_recolor,
    "logo.placement": logo.check_placement,
    "logo.occlusion": logo.check_occlusion,
    # -- colour ---------------------------------------------------------------
    "color.palette_conformance": color.check_palette_conformance,
    "color.forbidden": color.check_forbidden,
    "color.dominance_ratio": color.check_dominance_ratio,
    # -- typography -----------------------------------------------------------
    "typography.approved_family": typography.check_approved_family,
    "typography.min_size": typography.check_min_size,
    "typography.hierarchy": typography.check_hierarchy,
    "typography.fallback_font": typography.check_fallback_font,
    "typography.casing": typography.check_casing,
    # -- layout ---------------------------------------------------------------
    "layout.safe_zone": layout.check_safe_zone,
    "layout.margins": layout.check_margins,
    "layout.grid_alignment": layout.check_grid_alignment,
    "layout.element_overlap": layout.check_element_overlap,
    "layout.text_density": layout.check_text_density,
    # -- imagery --------------------------------------------------------------
    "imagery.style_conformance": imagery.check_style_conformance,
    "imagery.medium": imagery.check_medium,
    "imagery.prohibited_subject": imagery.check_prohibited_subject,
    "imagery.reuse": imagery.check_reuse,
    # -- copy -----------------------------------------------------------------
    "copy.banned_terms": copy_checks.check_banned_terms,
    "copy.required_terms": copy_checks.check_required_terms,
    "copy.readability": copy_checks.check_readability,
    "copy.claim_substantiation": copy_checks.check_claim_substantiation,
    "copy.disclaimer_present": copy_checks.check_disclaimer_present,
    "copy.locale_spelling": copy_checks.check_locale_spelling,
    "copy.cta_allowlist": copy_checks.check_cta_allowlist,
    # -- accessibility --------------------------------------------------------
    "accessibility.contrast": accessibility.check_contrast,
    "accessibility.font_size_floor": accessibility.check_font_size_floor,
    "accessibility.alt_text": accessibility.check_alt_text,
    # -- channel spec ---------------------------------------------------------
    "channel_spec.conformance": channel_spec.check_conformance,
    # -- T2 judge -------------------------------------------------------------
    # The generic one: the rule's own rubric is the criterion. Everything else
    # here asks a question this file chose; this asks the question the brand
    # wrote, which is what lets a semantic rule ship without an engine deploy.
    "vlm.rubric": judge.check_rubric,
    "vlm.voice_tone": judge.check_voice_tone,
    "vlm.mood": judge.check_mood,
    "vlm.subject_appropriateness": judge.check_subject_appropriateness,
    "vlm.overall_judgment": judge.check_overall_judgment,
    "vlm.rule_adjudication": judge.check_rule_adjudication,
}

#: The tier an analyzer *actually* runs at, independent of what a rule claims.
#: The pipeline schedules on the rule's declared tier but uses this to decide
#: what a `deterministicOnly` run may still execute — a rule mislabelled `cv`
#: must not smuggle a paid VLM call past the budget guard.
ANALYZER_TIERS: dict[str, CheckTier] = {
    "logo.presence": "cv",
    "logo.clearspace": "cv",
    "logo.min_size": "cv",
    "logo.distortion": "cv",
    "logo.recolor": "cv",
    "logo.placement": "cv",
    "logo.occlusion": "cv",
    "color.palette_conformance": "cv",
    "color.forbidden": "cv",
    "color.dominance_ratio": "cv",
    "typography.approved_family": "deterministic",
    "typography.min_size": "deterministic",
    "typography.hierarchy": "deterministic",
    "typography.fallback_font": "deterministic",
    "typography.casing": "deterministic",
    "layout.safe_zone": "cv",
    "layout.margins": "cv",
    "layout.grid_alignment": "cv",
    "layout.element_overlap": "cv",
    "layout.text_density": "cv",
    "imagery.style_conformance": "cv",
    "imagery.medium": "cv",
    "imagery.prohibited_subject": "vlm",
    "imagery.reuse": "cv",
    "copy.banned_terms": "deterministic",
    "copy.required_terms": "deterministic",
    "copy.readability": "deterministic",
    "copy.claim_substantiation": "deterministic",
    "copy.disclaimer_present": "deterministic",
    "copy.locale_spelling": "deterministic",
    "copy.cta_allowlist": "deterministic",
    "accessibility.contrast": "deterministic",
    "accessibility.font_size_floor": "deterministic",
    "accessibility.alt_text": "deterministic",
    "channel_spec.conformance": "deterministic",
    "vlm.rubric": "vlm",
    "vlm.voice_tone": "vlm",
    "vlm.mood": "vlm",
    "vlm.subject_appropriateness": "vlm",
    "vlm.overall_judgment": "vlm",
    "vlm.rule_adjudication": "hybrid",
}

#: Execution order within a run. T0 first so cheap certainties are banked before
#: anything can burn budget, and `vlm.overall_judgment` last so it can see them.
TIER_ORDER: tuple[CheckTier, ...] = ("deterministic", "cv", "hybrid", "vlm")


def get_analyzer(fn: str) -> Analyzer | None:
    return ANALYZERS.get(fn)


def effective_tier(fn: str, declared: CheckTier) -> CheckTier:
    """The stricter of the declared tier and the analyzer's real tier."""
    actual = ANALYZER_TIERS.get(fn)
    if actual is None:
        return declared
    return actual if TIER_ORDER.index(actual) > TIER_ORDER.index(declared) else declared


def requires_llm(fn: str) -> bool:
    return ANALYZER_TIERS.get(fn) in ("vlm", "hybrid")


def registered_names() -> list[str]:
    return sorted(ANALYZERS)


__all__ = [
    "ANALYZERS",
    "ANALYZER_TIERS",
    "TIER_ORDER",
    "Analyzer",
    "effective_tier",
    "get_analyzer",
    "registered_names",
    "requires_llm",
]
