"""`vlm.rubric` — the analyzer that lets a brand write a semantic rule.

Every other `vlm.*` check hardcodes its question. This one takes the rule's
own rubric, which is what makes "the people in the hero must be centrally
positioned" expressible without shipping a new engine.

The tests below are mostly about the two things that stop it becoming the vibes
analyzer: a rubric-less rule must say so loudly rather than quietly asking "is
this good?", and every call must hand the judge measured geometry rather than
leaving it to estimate position from the picture.
"""

from __future__ import annotations

import pytest

from brandlens_engine.judge import Judge, check_rubric
from brandlens_engine.models import RubricSpec

from .conftest import make_rule
from .test_judge import FakeProvider, response


def rubric_rule(
    *,
    question: str = "Are the people in the hero image centrally positioned within the banner?",
    kind: str = "binary",
    crop_to: str = "full",
    pass_when: str | None = "The subject sits near the centre of the frame.",
    fail_when: str | None = "The subject is pushed to an edge and reads as a crop error.",
    params: dict | None = None,
    key: str = "composition.subject-centred",
):
    rule = make_rule(key, "vlm.rubric", "layout", tier="vlm", params=params or {})
    rule.rubric = RubricSpec(
        kind=kind,  # type: ignore[arg-type]
        question=question,
        pass_when=pass_when,
        fail_when=fail_when,
        crop_to=crop_to,  # type: ignore[arg-type]
    )
    return rule


def wire_judge(ctx, brand, monkeypatch, provider: FakeProvider) -> Judge:
    judge = Judge(provider, ctx.judge_config, brand)
    monkeypatch.setattr(ctx, "judge", lambda: judge)
    return judge


# ---------------------------------------------------------------------------
# The guard that matters most
# ---------------------------------------------------------------------------
def test_a_rule_with_no_rubric_says_so_instead_of_asking_the_model_anything(context_for, poster_path):
    """
    The failure this analyzer could most easily introduce: a rule pointed here
    with no rubric would otherwise reach the judge carrying an empty question,
    and whatever came back would be a verdict nobody could trace to a criterion.
    """
    ctx = context_for(poster_path)
    rule = make_rule("composition.vague", "vlm.rubric", "layout", tier="vlm")
    rule.rubric = None

    result = check_rubric(ctx, rule)

    assert result.verdict == "insufficient_evidence"
    assert "no rubric question" in (result.evidence.observation or "")
    # And it costs nothing: the model was never called.
    assert result.cost_usd == 0.0


def test_a_blank_question_is_treated_the_same_as_no_rubric(context_for, poster_path):
    ctx = context_for(poster_path)
    rule = rubric_rule(question="   ")
    result = check_rubric(ctx, rule)
    assert result.verdict == "insufficient_evidence"
    assert result.cost_usd == 0.0


def test_it_degrades_rather_than_guessing_when_no_provider_is_configured(context_for, poster_path):
    # Same contract as every other T2 check: no key, no verdict, no cost.
    ctx = context_for(poster_path)
    result = check_rubric(ctx, rubric_rule())
    assert result.verdict in ("insufficient_evidence", "not_applicable")
    assert result.cost_usd == 0.0


# ---------------------------------------------------------------------------
# The rubric IS the criterion
# ---------------------------------------------------------------------------
def test_the_rules_own_question_reaches_the_prompt(context_for, poster_path, brand, monkeypatch):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("fail", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    check_rubric(ctx, rubric_rule(question="Is the headline about the snowboarding experience?"))

    # The criterion goes in the system turn — it is the reviewer's brief, not
    # part of the per-asset payload.
    system = str(provider.calls[0]["system"])
    assert "Is the headline about the snowboarding experience?" in system
    assert "composition.subject-centred" in system


def test_pass_and_fail_conditions_reach_the_prompt(context_for, poster_path, brand, monkeypatch):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    check_rubric(
        ctx,
        rubric_rule(
            pass_when="The subject sits within the middle third.",
            fail_when="The subject is cropped by the frame edge.",
        ),
    )

    system = str(provider.calls[0]["system"])
    assert "middle third" in system
    assert "cropped by the frame edge" in system


def test_ordinal_anchors_reach_the_prompt(context_for, poster_path, brand, monkeypatch):
    """An ordinal rubric without its anchors is a scale the judge has to invent."""
    from brandlens_engine.models import RubricLevel

    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    rule = rubric_rule(kind="ordinal")
    rule.rubric.levels = [
        RubricLevel(value=0, label="Off-centre", anchor="Subject is against an edge."),
        RubricLevel(value=1, label="Acceptable", anchor="Subject is off-centre but whole."),
        RubricLevel(value=2, label="Centred", anchor="Subject sits in the middle of the frame."),
    ]
    check_rubric(ctx, rule)

    system = str(provider.calls[0]["system"])
    assert "Off-centre" in system
    assert "Subject sits in the middle of the frame." in system


def test_the_verdict_and_its_model_trace_come_back_intact(context_for, poster_path, brand, monkeypatch):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("fail", 0.91))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())

    assert result.verdict == "fail"
    assert result.model is not None
    assert result.model.provider == "fake"
    assert result.cost_usd == pytest.approx(0.004)
    assert ctx.cost_usd == pytest.approx(0.004)


# ---------------------------------------------------------------------------
# Measured, not estimated
# ---------------------------------------------------------------------------
def test_the_judge_is_handed_the_canvas_rather_than_asked_to_estimate_it(
    context_for, poster_path, brand, monkeypatch
):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())

    canvas = result.evidence.measured.get("canvas")
    assert canvas is not None
    assert canvas["width"] > 0 and canvas["height"] > 0
    assert canvas["aspectRatio"] == pytest.approx(canvas["width"] / canvas["height"], rel=1e-3)


def test_every_element_carries_a_measured_position(context_for, poster_path, brand, monkeypatch):
    """
    The point of the whole analyzer. "Is the subject centrally positioned" is a
    guess if the judge only sees a picture, and a checkable question if it is
    told each element's centre and its distance from the canvas centre.
    """
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())
    elements = result.evidence.measured.get("elements")

    assert isinstance(elements, list) and elements, "no elements were measured"
    for element in elements:
        assert set(element) >= {"mark", "kind", "bbox", "center", "offsetFromCenter", "areaFrac"}
        cx, cy = element["center"]
        # The centre is the midpoint of the bbox, not a restatement of a corner.
        assert cx == pytest.approx((element["bbox"][0] + element["bbox"][2]) / 2, abs=1e-3)
        assert cy == pytest.approx((element["bbox"][1] + element["bbox"][3]) / 2, abs=1e-3)
        # A corner of the canvas is ~0.707 away from its centre; nothing can
        # exceed that, so a larger number means the arithmetic is wrong.
        assert 0.0 <= element["offsetFromCenter"] <= 0.75


def test_the_marks_the_judge_sees_are_the_ones_it_was_measured(
    context_for, poster_path, brand, monkeypatch
):
    """
    The crop numbers elements 1..n and the measurement block numbers them the
    same way. If the two ever disagreed, "mark 2 is off-centre" would point at
    a different element than the one measured — a wrong finding that still
    looks precise.
    """
    ctx = context_for(poster_path)
    provider = FakeProvider(response("fail", 0.9, marks=[1]))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())
    marks = [e["mark"] for e in result.evidence.measured["elements"]]
    assert marks == list(range(1, len(marks) + 1))

    # The verdict's bbox resolved to a real detected element rather than a
    # rectangle the model invented.
    assert result.evidence.bbox is not None


def test_measured_geometry_appears_in_the_prompt_as_authoritative(
    context_for, poster_path, brand, monkeypatch
):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    check_rubric(ctx, rubric_rule())

    prompt = str(provider.calls[0]["prompt"])
    assert "offsetFromCenter" in prompt
    assert "do not re-estimate" in prompt


# ---------------------------------------------------------------------------
# Copy rubrics
# ---------------------------------------------------------------------------
def test_a_text_rubric_sends_the_copy_and_no_image(context_for, poster_path, brand, monkeypatch):
    ctx = context_for(poster_path, copy_fields={"headline": "Snowbound Bliss"})
    provider = FakeProvider(response("fail", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(
        ctx,
        rubric_rule(
            key="copy.theme-relevance",
            question="Is the headline centred on the snowboarding experience?",
            crop_to="text",
        ),
    )

    assert result.verdict == "fail"
    assert "Snowbound Bliss" in str(provider.calls[0]["prompt"])
    # `crop_to: text` means the question is about words, so no image tokens burn.
    assert provider.calls[0]["images"] == 0


def test_a_visual_rubric_does_not_burn_tokens_on_copy_by_default(
    context_for, poster_path, brand, monkeypatch
):
    ctx = context_for(poster_path, copy_fields={"body": "A very long body of marketing prose " * 40})
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule(crop_to="full"))
    assert "copy" not in result.evidence.measured


def test_copy_can_be_requested_explicitly_for_a_visual_rubric(
    context_for, poster_path, brand, monkeypatch
):
    # A rule about whether the headline matches the picture needs both.
    ctx = context_for(poster_path, copy_fields={"headline": "Snowbound Bliss"})
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule(crop_to="full", params={"includeCopy": True}))
    assert "Snowbound Bliss" in str(result.evidence.measured.get("copy", ""))


def test_copy_is_truncated_so_one_rule_cannot_blow_the_context(
    context_for, poster_path, brand, monkeypatch
):
    ctx = context_for(poster_path, copy_fields={"body": "x" * 9000})
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule(crop_to="text", params={"maxCopyChars": 500}))
    assert len(result.evidence.measured["copy"]) == 500


def test_require_image_can_be_overridden_so_a_copy_rule_survives_a_bad_raster(
    context_for, poster_path, brand, monkeypatch
):
    """
    A rule about wording must not report `insufficient_evidence` because the
    asset would not rasterise. `requireImage: false` is the escape hatch, and
    the default already follows the crop.
    """
    ctx = context_for(poster_path, copy_fields={"headline": "Snowbound Bliss"})
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)
    monkeypatch.setattr(ctx, "image", lambda: None)

    result = check_rubric(
        ctx,
        rubric_rule(crop_to="full", params={"requireImage": False, "includeCopy": True}),
    )
    assert result.verdict == "pass"
    assert provider.calls[0]["images"] == 0


def test_a_visual_rubric_abstains_when_the_asset_will_not_rasterise(
    context_for, poster_path, brand, monkeypatch
):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)
    monkeypatch.setattr(ctx, "image", lambda: None)

    result = check_rubric(ctx, rubric_rule(crop_to="full"))
    assert result.verdict == "insufficient_evidence"
    assert provider.calls == []


# ---------------------------------------------------------------------------
# It obeys the same budget and abstention rules as every other T2 check
# ---------------------------------------------------------------------------
def test_it_is_skipped_in_deterministic_only_mode(context_for, poster_path, brand, monkeypatch):
    ctx = context_for(poster_path)
    provider = FakeProvider(response("fail", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)
    monkeypatch.setattr(type(ctx), "deterministic_only", property(lambda self: True))

    result = check_rubric(ctx, rubric_rule())
    assert result.verdict == "insufficient_evidence"
    assert provider.calls == []
    assert result.cost_usd == 0.0


def test_a_lone_low_confidence_answer_is_escalated_rather_than_believed(
    context_for, poster_path, brand, monkeypatch
):
    """
    One unsure sample is not a verdict. The judge re-samples at a higher
    temperature and lets agreement decide, because vote agreement across
    independent samples is better calibrated than a model's own confidence
    number — so three samples that agree outrank one that hedged.
    """
    ctx = context_for(poster_path)
    provider = FakeProvider(response("fail", 0.2))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())

    assert len(provider.calls) == 3, "a hedged single sample should have escalated"
    assert result.model is not None
    assert result.model.self_consistency_k == 3


def test_a_split_panel_abstains_rather_than_taking_a_majority(
    context_for, poster_path, brand, monkeypatch
):
    """
    Two-one is not a decision on a question this subjective. When the samples
    disagree, entropy drags the confidence under the floor and the criterion
    goes to a human instead of being resolved by a show of hands.
    """
    ctx = context_for(poster_path)
    provider = FakeProvider([response("fail", 0.5), response("pass", 0.5), response("pass", 0.5)])
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())

    assert result.verdict == "abstained"
    assert "confidence floor" in (result.evidence.observation or "")
    assert result.model is not None
    assert result.model.vote_entropy > 0


def test_a_provider_failure_becomes_a_verdict_rather_than_an_exception(
    context_for, poster_path, brand, monkeypatch
):
    from brandlens_engine.llm.base import LLMError

    ctx = context_for(poster_path)
    provider = FakeProvider(fail_with=LLMError("upstream exploded"))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())
    assert result.verdict in ("insufficient_evidence", "abstained")
    assert result.evidence.observation


# ---------------------------------------------------------------------------
# The registry contract
# ---------------------------------------------------------------------------
def test_it_is_registered_at_the_vlm_tier():
    from brandlens_engine.registry import ANALYZER_TIERS, get_analyzer

    assert get_analyzer("vlm.rubric") is check_rubric
    # A rule that mislabelled itself `deterministic` must not smuggle a paid
    # model call past the budget guard.
    assert ANALYZER_TIERS["vlm.rubric"] == "vlm"


def test_it_reads_nothing_from_the_ontology(context_for, poster_path, brand, monkeypatch):
    """
    A brand with nothing configured can still write a rubric rule — which is
    the difference between a feature that works on day one and one that waits
    for an ontology nobody has filled in yet.
    """
    ctx = context_for(poster_path)
    brand.logo_variants = []
    brand.type_styles = []
    brand.color_tokens = []
    brand.voice_attributes = []
    ctx.request.brand = brand

    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    result = check_rubric(ctx, rubric_rule())
    assert result.verdict == "pass"


# ---------------------------------------------------------------------------
# Two defects the first end-to-end run surfaced
# ---------------------------------------------------------------------------
def test_measured_geometry_is_plain_python_numbers(context_for, poster_path, brand, monkeypatch):
    """
    Element boxes can arrive as numpy scalars from the CV path, and `round()`
    on one returns a numpy scalar too. Pydantic serialises them, so nothing
    breaks loudly — it just leaves a measurement dict that is half numpy and
    half float, which reads as noise in a log and compares badly downstream.
    """
    ctx = context_for(poster_path)
    provider = FakeProvider(response("pass", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    elements = check_rubric(ctx, rubric_rule()).evidence.measured["elements"]
    for element in elements:
        for value in [*element["center"], *element["bbox"], element["offsetFromCenter"], element["areaFrac"]]:
            assert type(value) is float, f"{value!r} is {type(value).__name__}, not a plain float"


def test_a_text_rubric_does_not_ship_geometry_for_a_picture_it_never_sent(
    context_for, poster_path, brand, monkeypatch
):
    """
    A question about wording gets no image. Sending twelve element boxes with
    it would burn tokens describing a canvas the judge was never shown — and
    invite it to reason about positions it cannot see.
    """
    ctx = context_for(poster_path, copy_fields={"headline": "Snowbound Bliss"})
    provider = FakeProvider(response("fail", 0.9))
    wire_judge(ctx, brand, monkeypatch, provider)

    measured = check_rubric(ctx, rubric_rule(crop_to="text")).evidence.measured
    assert "elements" not in measured
    assert "canvas" not in measured
    assert measured["copy"] == "Snowbound Bliss"
