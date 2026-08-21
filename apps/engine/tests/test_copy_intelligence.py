"""Tests for voice, lexicon, claim and disclaimer extraction from site copy.

The interesting tests here are the GROUNDING ones. A model asked to describe a
brand's voice will always produce something fluent, and fluent-but-invented is
the failure mode that destroys trust in this kind of tool. So the module
verifies every quotation against the corpus before it ships, and these tests
pin that behaviour by feeding it deliberately fabricated output.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from brandlens_engine import copy_intelligence as ci
from brandlens_engine.models import AnalyzeCopyRequest, CopyPageInput

HOME = (
    "We roast on Tuesdays and ship on Wednesdays. "
    "We pay farmers above the C-price on every lot, every year. "
    "Our beans are traceable to a single farm and a single harvest window."
)
ABOUT = (
    "We started in a garage in 2011 with one drum roaster. "
    "We are the best independent roaster in the country. "
    "Every bag is traceable, and every farmer is paid above the C-price."
)
LEGAL = "Northwind Coffee Co. Registered in England. Terms and conditions apply. Results may vary."


def pages() -> list[CopyPageInput]:
    return [
        CopyPageInput(url="https://northwind.test/", role="home", text=HOME),
        CopyPageInput(url="https://northwind.test/about", role="about", text=ABOUT),
        CopyPageInput(url="https://northwind.test/legal", role="legal", text=LEGAL),
    ]


# ---------------------------------------------------------------------------
# Deterministic measurement
# ---------------------------------------------------------------------------


class TestMeasureCopy:
    def test_counts_sentences_and_words(self) -> None:
        m = ci.measure_copy(pages())
        assert m.stats["sentences"] >= 9
        assert m.stats["words"] > 50
        assert m.stats["meanSentenceWords"] > 0

    def test_measures_first_person_rate(self) -> None:
        # The fixture is written in "we" throughout; a voice reading that
        # called it detached would be contradicting a counted fact.
        m = ci.measure_copy(pages())
        assert m.stats["firstPersonPer100Words"] > 0

    def test_reports_sentence_rhythm_not_just_average(self) -> None:
        m = ci.measure_copy(pages())
        assert "sentenceLengthStdDev" in m.stats
        assert m.stats["longestSentenceWords"] >= m.stats["meanSentenceWords"]

    def test_finds_the_superlative_claim(self) -> None:
        m = ci.measure_copy(pages())
        texts = [c["text"] for c in m.claim_candidates]
        assert any("best independent roaster" in t for t in texts)

    def test_attributes_each_claim_to_its_page(self) -> None:
        m = ci.measure_copy(pages())
        claim = next(c for c in m.claim_candidates if "best independent" in c["text"])
        assert claim["url"] == "https://northwind.test/about"

    def test_finds_legal_boilerplate(self) -> None:
        m = ci.measure_copy(pages())
        texts = " ".join(d["text"] for d in m.disclaimer_candidates)
        assert "Terms and conditions apply" in texts
        assert "Registered in England" in texts

    def test_does_not_treat_ordinary_prose_as_a_disclaimer(self) -> None:
        m = ci.measure_copy([CopyPageInput(url="https://x/", text="We roast coffee. It tastes good.")])
        assert m.disclaimer_candidates == []

    def test_distinctive_vocabulary_prefers_cross_page_recurrence(self) -> None:
        # "traceable" and "farmers"/"farm" appear on two pages; a word used
        # many times on ONE page is that page's word, not the brand's.
        m = ci.measure_copy(pages())
        terms = {t["term"] for t in m.distinctive_terms}
        assert "traceable" in terms
        assert all(t["pageCount"] >= 2 for t in m.distinctive_terms)

    def test_excludes_stopwords(self) -> None:
        m = ci.measure_copy(pages())
        assert not ({"that", "with", "have"} & {t["term"] for t in m.distinctive_terms})

    def test_empty_corpus_does_not_explode(self) -> None:
        m = ci.measure_copy([CopyPageInput(url="https://x/", text="")])
        assert m.corpus == ""
        assert m.claim_candidates == []


# ---------------------------------------------------------------------------
# Grounding — the anti-hallucination gate
# ---------------------------------------------------------------------------


class TestGrounder:
    def setup_method(self) -> None:
        self.g = ci._Grounder(f"{HOME}\n\n{ABOUT}", pages()[:2])

    def test_accepts_a_verbatim_quotation_and_names_its_page(self) -> None:
        assert self.g.find("We roast on Tuesdays and ship on Wednesdays.") == "https://northwind.test/"
        assert self.g.find("We started in a garage in 2011 with one drum roaster.") == "https://northwind.test/about"

    def test_tolerates_punctuation_and_whitespace_drift(self) -> None:
        # A model reproducing a sentence will normalise a curly apostrophe
        # without meaning to. Rejecting that would discard good evidence.
        assert self.g.find("We  roast on Tuesdays   and ship on Wednesdays") is not None

    def test_rejects_an_invented_sentence(self) -> None:
        assert self.g.find("We are passionate about delivering exceptional customer experiences.") is None

    def test_rejects_a_plausible_paraphrase(self) -> None:
        # This is the dangerous case: close enough to read as real, different
        # enough that the brand never said it.
        assert self.g.find("We roast every Tuesday and ship every Wednesday.") is None

    def test_rejects_a_fragment_too_short_to_prove_anything(self) -> None:
        assert self.g.find("We roast") is None


# ---------------------------------------------------------------------------
# LLM output handling
# ---------------------------------------------------------------------------


class TestParseJsonObject:
    def test_parses_bare_json(self) -> None:
        assert ci._parse_json_object('{"a": 1}') == {"a": 1}

    def test_parses_json_inside_a_markdown_fence(self) -> None:
        assert ci._parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}

    def test_parses_json_with_a_chatty_preamble(self) -> None:
        assert ci._parse_json_object('Sure! Here is the analysis:\n{"a": 1}\nHope that helps.') == {"a": 1}

    def test_returns_none_rather_than_raising_on_rubbish(self) -> None:
        assert ci._parse_json_object("no json here") is None
        assert ci._parse_json_object("{not: valid}") is None
        assert ci._parse_json_object("") is None

    def test_returns_none_for_a_bare_array(self) -> None:
        # The contract is an object; an array means the model ignored it.
        assert ci._parse_json_object("[1, 2, 3]") is None


class FakeCompletion:
    def __init__(self, text: str) -> None:
        self.text = text
        self.cost_usd = 0.004


class FakeProvider:
    """Stands in for a real LLM so judgement can be tested deterministically."""

    name = "fake"

    def __init__(self, payload: Any) -> None:
        self.payload = payload
        self.prompts: list[str] = []

    def complete(self, system: str, prompt: str, **_: Any) -> FakeCompletion:
        self.prompts.append(prompt)
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return FakeCompletion(text)


@pytest.fixture
def request_obj() -> AnalyzeCopyRequest:
    return AnalyzeCopyRequest(
        request_id="req-1",
        org_id="org-1",
        brand_name="Northwind Coffee",
        origin_url="https://northwind.test",
        pages=pages(),
        provider="anthropic",
        model="test-model",
    )


def run_with(monkeypatch: pytest.MonkeyPatch, payload: Any, request_obj: AnalyzeCopyRequest):
    provider = FakeProvider(payload)
    monkeypatch.setattr(ci, "build_provider", lambda *_a, **_k: provider)
    monkeypatch.setattr(ci, "canonical_provider", lambda p: p)
    return ci.analyze_copy(request_obj), provider


class TestAnalyzeCopy:
    def test_puts_the_measured_numbers_into_the_prompt(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        # "We measure, the model judges" — the model must never be asked to
        # estimate a quantity that was already counted.
        _, provider = run_with(monkeypatch, {"voiceAxes": []}, request_obj)
        prompt = provider.prompts[0]
        assert "MEASURED" in prompt
        assert "meanSentenceWords" in prompt
        assert "treat as fact" in prompt

    def test_keeps_an_axis_whose_evidence_is_real(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "voiceAxes": [
                    {
                        "name": "Directness",
                        "lowLabel": "Ornate",
                        "highLabel": "Plain",
                        "value": 0.85,
                        "rationale": "Short declaratives throughout.",
                        "evidence": ["We roast on Tuesdays and ship on Wednesdays."],
                    }
                ]
            },
            request_obj,
        )
        assert len(result.voice_axes) == 1
        assert result.voice_axes[0].name == "Directness"
        assert result.voice_axes[0].value == 0.85

    def test_discards_an_axis_whose_evidence_was_invented(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "voiceAxes": [
                    {
                        "name": "Warmth",
                        "lowLabel": "Cold",
                        "highLabel": "Warm",
                        "value": 0.9,
                        "evidence": ["We are passionate about delivering exceptional experiences."],
                    }
                ]
            },
            request_obj,
        )
        assert result.voice_axes == []
        assert any("not found in the copy" in w for w in result.warnings)

    def test_keeps_only_the_real_evidence_from_a_mixed_axis(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "voiceAxes": [
                    {
                        "name": "Directness",
                        "lowLabel": "Ornate",
                        "highLabel": "Plain",
                        "value": 0.8,
                        "evidence": [
                            "We roast on Tuesdays and ship on Wednesdays.",
                            "We synergise stakeholder value at pace.",
                        ],
                    }
                ]
            },
            request_obj,
        )
        assert len(result.voice_axes) == 1
        assert result.voice_axes[0].evidence == ["We roast on Tuesdays and ship on Wednesdays."]

    def test_clamps_an_out_of_range_axis_value(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "voiceAxes": [
                    {
                        "name": "X",
                        "lowLabel": "a",
                        "highLabel": "b",
                        "value": 42,
                        "evidence": ["We roast on Tuesdays and ship on Wednesdays."],
                    }
                ]
            },
            request_obj,
        )
        assert result.voice_axes[0].value == 1.0

    def test_discards_lexicon_terms_the_brand_never_wrote(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "lexicon": [
                    {"term": "traceable", "kind": "preferred", "note": "used consistently"},
                    {"term": "synergy", "kind": "banned", "note": "corporate filler"},
                ]
            },
            request_obj,
        )
        terms = {t.term for t in result.lexicon}
        assert "traceable" in terms
        assert "synergy" not in terms
        assert any("does not contain them" in w for w in result.warnings)

    def test_lexicon_carries_the_measured_usage_counts(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch, {"lexicon": [{"term": "traceable", "kind": "preferred"}]}, request_obj
        )
        term = result.lexicon[0]
        assert term.uses >= 2
        assert term.page_count >= 2

    def test_claims_come_from_detection_not_from_the_model(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        # The model may judge the candidates; it may not add sentences of its
        # own. Detection stays deterministic so the same page always yields
        # the same candidate set.
        result, _ = run_with(
            monkeypatch,
            {"claims": [{"text": "We are the fastest roaster on Earth.", "needsSubstantiation": True}]},
            request_obj,
        )
        assert all("fastest roaster on Earth" not in c.text for c in result.claims)
        assert any("best independent roaster" in c.text for c in result.claims)

    def test_applies_the_models_verdict_to_a_detected_claim(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "claims": [
                    {
                        "text": "We are the best independent roaster in the country.",
                        "claimType": "superlative",
                        "needsSubstantiation": True,
                        "suggestedEvidence": "Independent market share data.",
                    }
                ]
            },
            request_obj,
        )
        claim = next(c for c in result.claims if "best independent" in c.text)
        assert claim.claim_type == "superlative"
        assert claim.judged is True
        assert claim.suggested_evidence == "Independent market share data."

    def test_an_unjudged_claim_defaults_to_needing_substantiation(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        # Silence about regulated copy must resolve toward review, never away
        # from it.
        result, _ = run_with(monkeypatch, {"claims": []}, request_obj)
        claim = next(c for c in result.claims if "best independent" in c.text)
        assert claim.needs_substantiation is True
        assert claim.judged is False
        assert any("default to needing substantiation" in w for w in result.warnings)

    def test_disclaimers_pick_up_their_trigger_condition(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(
            monkeypatch,
            {
                "disclaimers": [
                    {"text": "Terms and conditions apply.", "triggerCondition": "Any promotional offer"}
                ]
            },
            request_obj,
        )
        d = next(d for d in result.disclaimers if "Terms and conditions" in d.text)
        assert d.trigger_condition == "Any promotional offer"

    def test_always_returns_the_measured_readability(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        result, _ = run_with(monkeypatch, {}, request_obj)
        assert result.readability.stats["words"] > 0
        assert result.readability.stats["sentences"] > 0

    def test_survives_a_model_that_returns_nonsense(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        # The deterministic half must still ship. Losing the claims register
        # because a model had a bad day would be a much worse outcome than
        # losing the voice axes.
        result, _ = run_with(monkeypatch, "I'm afraid I can't help with that.", request_obj)
        assert result.voice_axes == []
        assert len(result.claims) > 0
        assert len(result.disclaimers) > 0
        assert any("unparsable" in w for w in result.warnings)

    def test_reports_no_copy_rather_than_pretending(self) -> None:
        result = ci.analyze_copy(
            AnalyzeCopyRequest(
                request_id="r",
                org_id="o",
                pages=[CopyPageInput(url="https://x/", text="")],
                provider="anthropic",
                model="m",
            )
        )
        assert result.warnings == ["no copy was supplied"]
        assert result.voice_axes == []

    def test_a_missing_api_key_degrades_instead_of_failing(
        self, monkeypatch: pytest.MonkeyPatch, request_obj: AnalyzeCopyRequest
    ) -> None:
        from brandlens_engine.llm.base import NullProvider

        monkeypatch.setattr(ci, "build_provider", lambda *_a, **_k: NullProvider("no API key configured"))
        monkeypatch.setattr(ci, "canonical_provider", lambda p: p)

        result = ci.analyze_copy(request_obj)
        assert result.voice_axes == []
        assert len(result.claims) > 0  # deterministic detection is unaffected
        assert any("skipped" in w for w in result.warnings)
