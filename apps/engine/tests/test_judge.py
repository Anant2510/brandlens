"""The T2 judge: prompt construction, voting, abstention, SoM grounding.

A `FakeProvider` stands in for the vendor API. No network, no keys — and it lets
us assert on the exact prompt the judge builds, which is where most judge
regressions actually live.
"""

from __future__ import annotations

import json

import pytest

from brandlens_engine.judge import (
    MAX_PRECEDENTS,
    Judge,
    balance_precedents,
    build_brand_ontology,
    check_voice_tone,
    parse_sample,
    select_crop,
    vote_entropy,
)
from brandlens_engine.llm.base import Completion, LLMError, LLMProvider, Usage
from brandlens_engine.models import EngineJudgeConfig, EnginePrecedent, RubricSpec, RuleDefinition

from .conftest import make_rule


class FakeProvider(LLMProvider):
    """Returns scripted responses and records every prompt it was given."""

    name = "fake"

    def __init__(self, responses: list[str] | str = "", fail_with: Exception | None = None) -> None:
        super().__init__(model="fake-model-1")
        self.responses = [responses] if isinstance(responses, str) else list(responses)
        self.fail_with = fail_with
        self.calls: list[dict[str, object]] = []

    def _next(self, system: str, prompt: str, images: list[bytes] | None = None) -> Completion:
        self.calls.append({"system": system, "prompt": prompt, "images": len(images or [])})
        if self.fail_with is not None:
            raise self.fail_with
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        text = self.responses[index] if self.responses else ""
        return Completion(
            text=text,
            usage=Usage(input_tokens=1000, output_tokens=200),
            cost_usd=0.004,
            model=self.model,
            provider=self.name,
        )

    def complete(self, system, prompt, temperature=0.0, max_tokens=1024, enable_cache=True, stop=None):
        return self._next(system, prompt)

    def complete_vision(self, system, prompt, images, temperature=0.0, max_tokens=1024,
                        enable_cache=True, media_type="image/png"):
        return self._next(system, prompt, images)


def response(verdict: str, confidence: float = 0.9, marks: list[int] | None = None, bbox=None) -> str:
    payload = {
        "observation": f"I observe something relevant to a {verdict} verdict.",
        "evidence": "mark 1 shows the measured value exceeding the threshold",
        "verdict": verdict,
        "severity": "major",
        "confidence": confidence,
        "suggested_fix": None if verdict == "pass" else "Do the thing",
        "mark_refs": marks if marks is not None else [1],
    }
    if bbox is not None:
        payload["bbox"] = bbox
    return "Here is my answer:\n" + json.dumps(payload)


@pytest.fixture
def vlm_rule() -> RuleDefinition:
    rule = make_rule("vlm.voice", "vlm.voice_tone", "copy", tier="vlm")
    rule.rubric = RubricSpec(question="Does the copy sound like us?", kind="binary")
    return rule


# ---------------------------------------------------------------------------
# response parsing
# ---------------------------------------------------------------------------
def test_parse_extracts_the_json_object_from_surrounding_prose():
    sample = parse_sample(response("fail", 0.8))
    assert sample is not None
    assert sample.verdict == "fail"
    assert sample.confidence == 0.8
    assert sample.mark_refs == [1]
    assert sample.observation


def test_parse_rejects_a_verdict_outside_the_enum():
    assert parse_sample('{"verdict": "maybe", "confidence": 0.9}') is None
    assert parse_sample("no json at all") is None


def test_parse_accepts_the_mandatory_abstention_verdicts():
    for verdict in ("not_applicable", "insufficient_evidence"):
        sample = parse_sample(json.dumps({"verdict": verdict, "confidence": 0.7}))
        assert sample is not None and sample.verdict == verdict


def test_parse_recovers_from_trailing_prose_after_the_object():
    raw = json.dumps({"verdict": "pass", "confidence": 0.9}) + '\nHope that helps! {"stray": '
    sample = parse_sample(raw)
    assert sample is not None and sample.verdict == "pass"


def test_parse_normalises_verdict_spelling():
    sample = parse_sample('{"verdict": "Not-Applicable", "confidence": 0.6}')
    assert sample is not None and sample.verdict == "not_applicable"


# ---------------------------------------------------------------------------
# vote entropy
# ---------------------------------------------------------------------------
def test_vote_entropy_is_zero_when_unanimous():
    assert vote_entropy(["pass"] * 5) == 0.0
    assert vote_entropy(["fail"]) == 0.0


def test_vote_entropy_is_normalised_by_the_achievable_maximum():
    """Normalising by log(min(k, |verdicts|)) rather than log(2) is what keeps a
    4-of-5 majority from being punished as hard as a coin flip."""
    assert vote_entropy(["pass", "fail"]) == pytest.approx(1.0)
    even_split_of_four = vote_entropy(["pass", "pass", "fail", "fail"])
    lopsided_of_five = vote_entropy(["pass", "pass", "pass", "pass", "fail"])
    assert 0.0 < lopsided_of_five < even_split_of_four < 1.0


def test_vote_entropy_rises_with_disagreement():
    low = vote_entropy(["pass", "pass", "pass", "pass", "fail"])
    high = vote_entropy(["pass", "pass", "fail", "fail", "not_applicable"])
    assert 0.0 < low < high <= 1.0


# ---------------------------------------------------------------------------
# precedent balancing
# ---------------------------------------------------------------------------
def _precedent(verdict: str, similarity: float, rule_key: str = "vlm.voice") -> EnginePrecedent:
    return EnginePrecedent(asset_id=f"a-{verdict}-{similarity}", rule_key=rule_key, verdict=verdict, similarity=similarity)


def test_precedents_are_balanced_half_pass_half_fail():
    precedents = [_precedent("pass", 0.9 - i * 0.01) for i in range(10)] + [
        _precedent("fail", 0.8 - i * 0.01) for i in range(10)
    ]
    chosen = balance_precedents(precedents, "vlm.voice", k=6)
    assert len(chosen) == 6
    assert sum(1 for p in chosen if p.verdict == "pass") == 3
    assert sum(1 for p in chosen if p.verdict == "fail") == 3


def test_unbalanced_pool_yields_a_smaller_balanced_block():
    """Topping up from the majority class would leak a label prior."""
    precedents = [_precedent("pass", 0.9) for _ in range(8)] + [_precedent("fail", 0.9)]
    chosen = balance_precedents(precedents, "vlm.voice", k=6)
    assert len(chosen) == 2
    assert sum(1 for p in chosen if p.verdict == "pass") == 1
    assert sum(1 for p in chosen if p.verdict == "fail") == 1


def test_precedents_are_interleaved_not_grouped_by_label():
    precedents = [_precedent("pass", 0.9) for _ in range(4)] + [_precedent("fail", 0.9) for _ in range(4)]
    verdicts = [p.verdict for p in balance_precedents(precedents, "vlm.voice", k=4)]
    assert verdicts == ["pass", "fail", "pass", "fail"]


def test_precedent_count_is_capped():
    precedents = [_precedent("pass", 0.9) for _ in range(50)] + [_precedent("fail", 0.9) for _ in range(50)]
    assert len(balance_precedents(precedents, "vlm.voice", k=100)) <= MAX_PRECEDENTS


def test_precedents_prefer_the_most_similar():
    precedents = [_precedent("pass", 0.1), _precedent("pass", 0.99), _precedent("fail", 0.2), _precedent("fail", 0.98)]
    chosen = balance_precedents(precedents, "vlm.voice", k=2)
    assert {round(p.similarity or 0, 2) for p in chosen} == {0.99, 0.98}


def test_no_precedents_yields_an_empty_block():
    assert balance_precedents([], "vlm.voice", k=6) == []


# ---------------------------------------------------------------------------
# prompt construction
# ---------------------------------------------------------------------------
def test_brand_ontology_carries_voice_and_tokens(brand):
    from brandlens_engine.models import VoiceAttribute

    brand.voice_attributes = [
        VoiceAttribute(name="Plain", we_are="direct and plain", we_are_not="jargon-heavy")
    ]
    ontology = build_brand_ontology(brand)
    assert "Northgate" in ontology
    assert "we are NOT: jargon-heavy" in ontology
    assert "#0B5FFF" in ontology
    assert "guaranteed" in ontology  # banned terms are part of the ontology


def test_static_prompt_half_is_identical_across_assets(brand, judge_config, vlm_rule):
    """Prompt-cache hit rate depends on the system block being byte-stable."""
    judge = Judge(FakeProvider(response("pass")), judge_config, brand)
    first = judge._system(vlm_rule, "Q?", None, None)
    second = judge._system(vlm_rule, "Q?", None, None)
    assert first == second
    # The variable half is where the asset goes; it must not leak into `system`.
    assert "MEASUREMENTS" not in first
    assert "observation" in first and "insufficient_evidence" in first


def test_response_contract_puts_reasoning_before_the_verdict(brand, judge_config, vlm_rule):
    judge = Judge(FakeProvider(response("pass")), judge_config, brand)
    system = judge._system(vlm_rule, "Q?", None, None)
    assert system.index('"observation"') < system.index('"evidence"') < system.index('"verdict"')
    assert system.index('"verdict"') < system.index('"confidence"') < system.index('"suggested_fix"')


def test_measurements_are_injected_as_authoritative_numbers(brand, judge_config, vlm_rule):
    provider = FakeProvider(response("fail"))
    judge = Judge(provider, judge_config, brand)
    judge.evaluate(vlm_rule, "Q?", measurements={"deltaE2000": 7.42, "toleranceDeltaE": 3.0})
    prompt = str(provider.calls[0]["prompt"])
    assert "7.42" in prompt
    assert "authoritative" in prompt
    assert "do not re-estimate" in prompt.lower()


# ---------------------------------------------------------------------------
# voting, confidence and abstention
# ---------------------------------------------------------------------------
def test_single_sample_uses_the_model_confidence(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 1
    outcome = Judge(FakeProvider(response("fail", 0.92)), judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "fail"
    assert outcome.confidence == pytest.approx(0.92)
    assert outcome.vote_entropy == 0.0
    assert outcome.cost_usd == pytest.approx(0.004)


def test_self_consistency_takes_the_majority_and_reports_entropy(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 5
    provider = FakeProvider(
        [response("fail", 0.9), response("fail", 0.9), response("pass", 0.6), response("fail", 0.9), response("fail", 0.9)]
    )
    outcome = Judge(provider, judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "fail"
    assert outcome.self_consistency_k == 5
    assert 0.0 < outcome.vote_entropy < 1.0
    assert outcome.cost_usd == pytest.approx(0.02)


def test_self_consistency_samples_at_a_nonzero_temperature(brand, judge_config, vlm_rule):
    """k>1 at T=0 is k identical samples and a meaningless entropy of 0."""
    judge_config.self_consistency_k = 3
    judge_config.temperature = 0.0
    outcome = Judge(FakeProvider(response("pass")), judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.temperature >= 0.7


def test_split_vote_drives_confidence_below_the_floor_and_abstains(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 4
    judge_config.abstain_below_confidence = 0.55
    provider = FakeProvider(
        [response("fail", 0.6), response("pass", 0.6), response("fail", 0.6), response("pass", 0.6)]
    )
    outcome = Judge(provider, judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.vote_entropy > 0.4
    assert outcome.confidence < 0.55
    assert outcome.verdict == "abstained", "a coin-flip must route to a human, not into findings"


def test_strong_majority_is_not_abstained(brand, judge_config, vlm_rule):
    """The counterpart to the coin-flip test: 4-of-5 agreement must stand."""
    judge_config.self_consistency_k = 5
    judge_config.abstain_below_confidence = 0.55
    provider = FakeProvider(
        [response("fail", 0.9), response("fail", 0.9), response("fail", 0.9), response("fail", 0.9), response("pass", 0.5)]
    )
    outcome = Judge(provider, judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "fail"
    assert outcome.confidence >= 0.55


def test_abstention_never_masks_a_not_applicable(brand, judge_config, vlm_rule):
    """Only pass/fail can be downgraded to abstained; NA is a real answer."""
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 1
    judge_config.abstain_below_confidence = 0.99
    outcome = Judge(FakeProvider(response("not_applicable", 0.5)), judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "not_applicable"


def test_low_confidence_single_sample_escalates(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 3
    provider = FakeProvider([response("fail", 0.5), response("fail", 0.85), response("fail", 0.85)])
    outcome = Judge(provider, judge_config, brand).evaluate(vlm_rule, "Q?")
    assert len(provider.calls) == 3, "a shaky lone answer must be re-sampled"
    assert outcome.self_consistency_k == 3
    assert outcome.verdict == "fail"


def test_provider_failure_degrades_to_insufficient_evidence(brand, judge_config, vlm_rule):
    outcome = Judge(FakeProvider(fail_with=LLMError("upstream 503")), judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "insufficient_evidence"
    assert outcome.confidence == 0.0
    assert "503" in (outcome.error or "")


def test_unparsable_response_degrades_rather_than_guessing(brand, judge_config, vlm_rule):
    outcome = Judge(FakeProvider("I think it looks fine to me!"), judge_config, brand).evaluate(vlm_rule, "Q?")
    assert outcome.verdict == "insufficient_evidence"
    assert "parsable" in (outcome.error or "")


def test_budget_stops_the_vote_mid_flight(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 8
    provider = FakeProvider(response("fail", 0.9))
    outcome = Judge(provider, judge_config, brand).evaluate(vlm_rule, "Q?", budget_remaining=0.009)
    assert len(provider.calls) <= 3
    assert outcome.verdict == "fail"


# ---------------------------------------------------------------------------
# Set-of-Mark grounding
# ---------------------------------------------------------------------------
def test_mark_reference_resolves_to_the_detected_box(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 1
    boxes = [(0.1, 0.1, 0.3, 0.3), (0.5, 0.5, 0.7, 0.7)]
    outcome = Judge(FakeProvider(response("fail", 0.9, marks=[2])), judge_config, brand).evaluate(
        vlm_rule, "Q?", mark_boxes=boxes, mark_labels=["a", "b"]
    )
    assert outcome.bbox == boxes[1]


def test_hallucinated_bbox_is_dropped(brand, judge_config, vlm_rule):
    """A box that matches no detection points reviewers at nothing; drop it."""
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 1
    boxes = [(0.1, 0.1, 0.3, 0.3)]
    outcome = Judge(
        FakeProvider(response("fail", 0.9, marks=[], bbox=[0.8, 0.8, 0.95, 0.95])), judge_config, brand
    ).evaluate(vlm_rule, "Q?", mark_boxes=boxes)
    assert outcome.bbox is None
    assert outcome.dropped_bbox is True


def test_bbox_overlapping_a_detection_is_kept(brand, judge_config, vlm_rule):
    judge_config.self_consistency_k = 1
    judge_config.escalate_k = 1
    boxes = [(0.1, 0.1, 0.3, 0.3)]
    outcome = Judge(
        FakeProvider(response("fail", 0.9, marks=[], bbox=[0.12, 0.12, 0.28, 0.28])), judge_config, brand
    ).evaluate(vlm_rule, "Q?", mark_boxes=boxes)
    assert outcome.bbox is not None
    assert outcome.dropped_bbox is False


def test_marks_are_listed_in_the_variable_prompt_half(brand, judge_config, vlm_rule):
    provider = FakeProvider(response("pass"))
    Judge(provider, judge_config, brand).evaluate(
        vlm_rule, "Q?", mark_labels=["logo:Primary lockup", "text:headline"], mark_boxes=[(0, 0, 1, 1), (0, 0, 1, 1)]
    )
    prompt = str(provider.calls[0]["prompt"])
    assert "1. logo:Primary lockup" in prompt
    assert "Do not output coordinates" in prompt


def test_select_crop_sends_the_logo_region_not_the_whole_canvas(context_for, poster_path):
    ctx = context_for(poster_path)
    rule = make_rule("logo.clearspace", "logo.clearspace", "logo", tier="cv")
    full_png, _b, _l, full_desc = select_crop(ctx, rule, "full")
    logo_png, boxes, labels, logo_desc = select_crop(ctx, rule, "logo")
    assert logo_png is not None and full_png is not None
    assert len(logo_png) < len(full_png), "the logo crop must be smaller than the full canvas"
    assert boxes and labels and labels[0].startswith("logo:")
    assert "logo region" in logo_desc and full_desc


# ---------------------------------------------------------------------------
# analyzer integration
# ---------------------------------------------------------------------------
def test_voice_tone_degrades_without_a_provider(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "We make money simple."})
    result = check_voice_tone(ctx, make_rule("vlm.voice", "vlm.voice_tone", "copy", tier="vlm"))
    assert result.verdict in ("insufficient_evidence", "not_applicable")
    assert result.cost_usd == 0.0


def test_voice_tone_runs_through_the_judge(context_for, poster_path, brand, monkeypatch):
    from brandlens_engine.models import VoiceAttribute

    brand.voice_attributes = [VoiceAttribute(name="Plain", we_are="direct", we_are_not="jargon-heavy")]
    ctx = context_for(poster_path, copy_fields={"body": "We leverage synergistic paradigms."})
    ctx.request.brand = brand

    provider = FakeProvider(response("fail", 0.88))
    fake_judge = Judge(provider, ctx.judge_config, brand)
    monkeypatch.setattr(ctx, "judge", lambda: fake_judge)

    result = check_voice_tone(ctx, make_rule("vlm.voice", "vlm.voice_tone", "copy", tier="vlm"))
    assert result.verdict == "fail"
    assert result.model is not None
    assert result.model.provider == "fake"
    assert result.model.vote_entropy == 0.0
    assert result.cost_usd == pytest.approx(0.004)
    assert ctx.cost_usd == pytest.approx(0.004)
    # Voice/tone is a text question: no image is sent, so no image tokens burn.
    assert provider.calls[0]["images"] == 0
    assert "leverage synergistic paradigms" in str(provider.calls[0]["prompt"])


def test_judge_config_defaults_match_the_contract():
    cfg = EngineJudgeConfig(provider="anthropic", model="m")
    assert cfg.temperature == 0.0
    assert cfg.self_consistency_k == 1
    assert cfg.escalate_k == 3
    assert cfg.abstain_below_confidence == 0.55
    assert cfg.max_image_edge == 1568
    assert cfg.cost_ceiling_usd == 2.5
