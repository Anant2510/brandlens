"""Aho-Corasick, normalization, lexicon, claims, disclaimers, readability."""

from __future__ import annotations

import pytest

from brandlens_engine.copy_checks import (
    AhoCorasick,
    check_banned_terms,
    check_claim_substantiation,
    check_cta_allowlist,
    check_disclaimer_present,
    check_locale_spelling,
    check_readability,
    check_required_terms,
    extract_claims,
    fuzzy_find,
    is_whole_word,
    normalize_text,
    readability_metrics,
)

from .conftest import make_rule


# ---------------------------------------------------------------------------
# Aho-Corasick
# ---------------------------------------------------------------------------
def test_automaton_finds_all_patterns_in_one_pass():
    ac = AhoCorasick()
    for pattern in ("he", "she", "his", "hers"):
        ac.add(pattern)
    found = {(m.pattern, m.start) for m in ac.build().find("ushers")}
    assert found == {("she", 1), ("he", 2), ("hers", 2)}


def test_automaton_reports_nested_patterns_via_suffix_links():
    """'cheap' inside 'cheaper' must still fire — that is what suffix links are for."""
    ac = AhoCorasick()
    ac.add("cheap")
    ac.add("cheaper")
    patterns = {m.pattern for m in ac.build().find("get cheaper deals")}
    assert patterns == {"cheap", "cheaper"}


def test_automaton_handles_empty_and_absent_cases():
    ac = AhoCorasick()
    assert ac.add("") == -1
    ac.add("brand")
    assert ac.build().find("") == []
    assert ac.find("nothing here") == []


def test_automaton_scales_to_a_large_lexicon():
    ac = AhoCorasick()
    terms = [f"term{i:04d}" for i in range(800)]
    for t in terms:
        ac.add(t)
    ac.build()
    haystack = "prefix " + " ".join(terms[::100]) + " suffix"
    assert {m.pattern for m in ac.find(haystack)} == set(terms[::100])


def test_is_whole_word():
    assert is_whole_word("a cat sat", 2, 5)
    assert not is_whole_word("concatenate", 3, 6)


# ---------------------------------------------------------------------------
# normalization
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("The “best” deal", 'the "best" deal'),
        ("low—cost", "low-cost"),
        ("non breaking", "non breaking"),
        ("ﬁnancial ofﬁce", "financial office"),
        ("café", "cafe"),
        ("soft­hyphen", "softhyphen"),
        ("zero​width", "zerowidth"),
        ("double  space", "double space"),
        ("It’s", "it's"),
    ],
)
def test_normalization_folds_typographic_variation(raw, expected):
    assert normalize_text(raw).text == expected


def test_normalization_preserves_original_offsets():
    """Evidence must quote the writer's characters, not our folded copy."""
    raw = "The “best” — truly ﬁnest — offer"
    norm = normalize_text(raw)
    start = norm.text.find("best")
    assert norm.slice_original(start, start + 4) == "best"
    start = norm.text.find("finest")
    assert norm.slice_original(start, start + 6) == "ﬁnest"


def test_ocr_confusion_folding_is_opt_in():
    assert normalize_text("guarante0d").text == "guarante0d"
    assert normalize_text("guarante0d", ocr_fold=True).text == "guaranteod"


def test_fuzzy_find_tolerates_ocr_damage():
    hit = fuzzy_find("guaranteed", "our rates are guarantecd for life")
    assert hit is not None
    assert hit[2] >= 88.0
    assert fuzzy_find("guaranteed", "completely unrelated sentence") is None


# ---------------------------------------------------------------------------
# lexicon analyzers
# ---------------------------------------------------------------------------
def test_banned_term_detected_in_copy_fields(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Best rates guaranteed for everyone."})
    result = check_banned_terms(ctx, make_rule("copy.banned", "copy.banned_terms", "copy"))
    assert result.verdict == "fail"
    assert result.evidence.measured["hits"][0]["term"] == "guaranteed"
    assert result.evidence.quoted_text == "guaranteed"
    assert "designed to" in (result.suggested_fix or "")


def test_banned_term_matched_through_typographic_noise(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Rates GUARANTEED​ today."})
    result = check_banned_terms(ctx, make_rule("copy.banned", "copy.banned_terms", "copy"))
    assert result.verdict == "fail"


def test_banned_term_respects_market_scoping(context_for, poster_path, brand):
    brand.lexicon[0].market_codes = ["DE"]
    ctx = context_for(poster_path, copy_fields={"body": "Best rates guaranteed."}, market="US")
    ctx.request.brand = brand
    result = check_banned_terms(ctx, make_rule("copy.banned", "copy.banned_terms", "copy"))
    assert result.verdict == "not_applicable"


def test_banned_terms_pass_on_clean_copy(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Open a Northgate account in minutes."})
    result = check_banned_terms(ctx, make_rule("copy.banned", "copy.banned_terms", "copy"))
    assert result.verdict == "pass"
    assert result.evidence.measured["hitCount"] == 0


def test_banned_terms_degrade_without_text(context_for, poster_path):
    """No copy fields, no structure, OCR off — abstain, never pass."""
    result = check_banned_terms(context_for(poster_path), make_rule("copy.banned", "copy.banned_terms", "copy"))
    assert result.verdict == "insufficient_evidence"
    assert "none" in (result.evidence.observation or "")


def test_required_terms(context_for, poster_path):
    rule = make_rule("copy.required", "copy.required_terms", "copy", severity="blocker")

    present = check_required_terms(
        context_for(poster_path, copy_fields={"body": "Northgate makes it simple."}), rule
    )
    assert present.verdict == "pass"

    missing = check_required_terms(
        context_for(poster_path, copy_fields={"body": "We make it simple."}), rule
    )
    assert missing.verdict == "fail"
    assert missing.evidence.measured["missing"][0]["term"] == "Northgate"


# ---------------------------------------------------------------------------
# readability
# ---------------------------------------------------------------------------
def test_readability_metrics_rank_simple_above_dense_prose():
    simple, _ = readability_metrics(
        "We keep it simple. You open an account. You move your money. It just works, every day."
    )
    dense, _ = readability_metrics(
        "Notwithstanding the aforementioned indemnification provisions enumerated hereinabove, the "
        "counterparty shall remain irrevocably liable for consequential damages accruing subsequent "
        "to the termination of the aforesaid contractual relationship."
    )
    assert simple["fleschReadingEase"] > dense["fleschReadingEase"] + 40
    assert dense["fleschKincaidGrade"] > simple["fleschKincaidGrade"] + 8


def test_readability_fallback_produces_sane_numbers(monkeypatch):
    """A missing textstat corpus must degrade, not crash the criterion."""
    import builtins

    real_import = builtins.__import__

    def _fail(name, *args, **kwargs):
        if name == "textstat":
            raise ImportError("simulated missing corpus")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fail)
    metrics, degraded = readability_metrics("We keep it simple. You open an account today.")
    assert degraded is True
    assert 0 < metrics["fleschReadingEase"] <= 121
    assert metrics["words"] > 0


def test_readability_is_not_applicable_for_a_headline(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"headline": "Move money the modern way"})
    result = check_readability(ctx, make_rule("copy.read", "copy.readability", "copy"))
    assert result.verdict == "not_applicable"
    assert "calibrated on prose" in (result.evidence.observation or "")


def test_readability_fails_dense_copy(context_for, poster_path):
    ctx = context_for(
        poster_path,
        copy_fields={
            "body": (
                "Notwithstanding the aforementioned indemnification provisions enumerated hereinabove, "
                "the counterparty shall remain irrevocably liable for consequential damages accruing "
                "subsequent to the termination of the aforesaid contractual relationship between the "
                "parties identified in the preceding paragraph."
            )
        },
    )
    result = check_readability(
        ctx, make_rule("copy.read", "copy.readability", "copy", params={"maxFleschKincaidGrade": 10})
    )
    assert result.verdict == "fail"
    assert result.evidence.measured["fleschKincaidGrade"] > 10


# ---------------------------------------------------------------------------
# claims
# ---------------------------------------------------------------------------
def test_claim_extraction_finds_superlatives_and_ignores_neutral_prose():
    claims = extract_claims("We are the best bank. Our office is on Main Street. Up to 40% more savings.")
    triggers = {t for c in claims for t in c["triggers"]}
    assert "best" in triggers
    assert any("40%" in t for t in triggers)
    assert len(claims) == 2


def test_unregistered_claim_fails(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "We are the fastest bank in the country."})
    result = check_claim_substantiation(
        ctx, make_rule("copy.claims", "copy.claim_substantiation", "copy", severity="blocker")
    )
    assert result.verdict == "insufficient_evidence"  # register is empty in the base fixture
    assert result.evidence.measured["detectedClaims"]


def test_expired_claim_is_flagged(context_for, poster_path, brand):
    from brandlens_engine.models import ClaimEntry

    brand.claims = [
        ClaimEntry(
            id="claim-1",
            text="the fastest bank in the country",
            jurisdictions=["US"],
            expires_at="2020-01-01T00:00:00Z",
        )
    ]
    ctx = context_for(poster_path, copy_fields={"body": "We are the fastest bank in the country."}, market="US")
    ctx.request.brand = brand
    result = check_claim_substantiation(
        ctx, make_rule("copy.claims", "copy.claim_substantiation", "copy", severity="blocker")
    )
    assert result.verdict == "fail"
    assert "expired" in result.evidence.measured["problems"][0]["problem"]


def test_out_of_jurisdiction_claim_is_flagged(context_for, poster_path, brand):
    from brandlens_engine.models import ClaimEntry

    brand.claims = [
        ClaimEntry(id="claim-1", text="the fastest bank in the country", jurisdictions=["US"])
    ]
    ctx = context_for(poster_path, copy_fields={"body": "We are the fastest bank in the country."}, market="DE")
    ctx.request.brand = brand
    result = check_claim_substantiation(
        ctx, make_rule("copy.claims", "copy.claim_substantiation", "copy")
    )
    assert result.verdict == "fail"
    assert "DE" in result.evidence.measured["problems"][0]["problem"]


def test_valid_registered_claim_passes(context_for, poster_path, brand):
    from brandlens_engine.models import ClaimEntry

    brand.claims = [
        ClaimEntry(
            id="claim-1",
            text="the fastest bank in the country",
            jurisdictions=["US"],
            expires_at="2099-01-01T00:00:00Z",
        )
    ]
    ctx = context_for(poster_path, copy_fields={"body": "We are the fastest bank in the country."}, market="US")
    ctx.request.brand = brand
    result = check_claim_substantiation(ctx, make_rule("copy.claims", "copy.claim_substantiation", "copy"))
    assert result.verdict == "pass"
    assert result.evidence.measured["matchedClaims"]


def test_copy_without_claims_passes(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Open an account online in about ten minutes."})
    result = check_claim_substantiation(ctx, make_rule("copy.claims", "copy.claim_substantiation", "copy"))
    assert result.verdict == "pass"
    assert result.evidence.measured["detectedClaims"] == []


# ---------------------------------------------------------------------------
# disclaimers (the four-way check)
# ---------------------------------------------------------------------------
def test_missing_disclaimer_fails(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Open an account today."})
    result = check_disclaimer_present(
        ctx, make_rule("copy.disclaimer", "copy.disclaimer_present", "copy", severity="blocker")
    )
    assert result.verdict == "fail"
    assert result.severity == "blocker"
    assert result.evidence.measured["disclaimers"][0]["present"] is False


def test_disclaimer_present_but_too_small_fails_on_the_size_leg(context_for, brand_pdf_path):
    """The PDF sets the disclaimer at 6.5pt against an 8pt floor."""
    ctx = context_for(brand_pdf_path, kind="pdf")
    result = check_disclaimer_present(
        ctx, make_rule("copy.disclaimer", "copy.disclaimer_present", "copy", severity="blocker")
    )
    assert result.verdict == "fail"
    record = result.evidence.measured["disclaimers"][0]
    assert record["present"] is True
    assert record["legs"]["present"] is True
    assert record["legs"]["size"] is False
    assert record["sizePt"] == pytest.approx(6.5, abs=0.1)
    assert "size" in (result.evidence.observation or "")


def test_disclaimer_all_four_legs_pass(context_for, scratch, brand):
    import pymupdf

    path = scratch / "good_disclaimer.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((48, 700), "Terms apply. Rates shown are illustrative only.", fontname="helv", fontsize=10)
    doc.save(path)
    doc.close()

    ctx = context_for(str(path), kind="pdf")
    result = check_disclaimer_present(
        ctx, make_rule("copy.disclaimer", "copy.disclaimer_present", "copy", severity="blocker")
    )
    assert result.verdict == "pass"
    legs = result.evidence.measured["disclaimers"][0]["legs"]
    assert legs["present"] is True and legs["size"] is True and legs["contrast"] is True


def test_disclaimer_not_applicable_out_of_market(context_for, poster_path, brand):
    brand.disclaimers[0].market_codes = ["DE"]
    ctx = context_for(poster_path, copy_fields={"body": "hello"}, market="US")
    ctx.request.brand = brand
    result = check_disclaimer_present(ctx, make_rule("copy.disclaimer", "copy.disclaimer_present", "copy"))
    assert result.verdict == "not_applicable"


# ---------------------------------------------------------------------------
# locale spelling / CTA
# ---------------------------------------------------------------------------
def test_locale_spelling_flags_the_wrong_variant(context_for, poster_path):
    rule = make_rule("copy.locale", "copy.locale_spelling", "copy")

    us_asset = context_for(
        poster_path, copy_fields={"body": "Personalise your colour theme at our centre."}, locale="en-US"
    )
    result = check_locale_spelling(us_asset, rule)
    assert result.verdict == "fail"
    assert {h["expected"] for h in result.evidence.measured["hits"]} >= {"personalize", "color", "center"}

    gb_asset = context_for(
        poster_path, copy_fields={"body": "Personalise your colour theme at our centre."}, locale="en-GB"
    )
    assert check_locale_spelling(gb_asset, rule).verdict == "pass"


def test_locale_spelling_not_applicable_for_non_english(context_for, poster_path):
    ctx = context_for(poster_path, copy_fields={"body": "Bonjour le monde entier."}, locale="fr-FR")
    result = check_locale_spelling(ctx, make_rule("copy.locale", "copy.locale_spelling", "copy"))
    assert result.verdict == "not_applicable"


def test_cta_allowlist(context_for, poster_path):
    rule = make_rule(
        "copy.cta", "copy.cta_allowlist", "copy", params={"allowedCtas": ["Learn more", "Open an account"]}
    )

    ok = check_cta_allowlist(context_for(poster_path, copy_fields={"cta": "Learn more"}), rule)
    assert ok.verdict == "pass"

    bad = check_cta_allowlist(context_for(poster_path, copy_fields={"ctaLabel": "Buy now!!"}), rule)
    assert bad.verdict == "fail"
    assert "not on the allowlist" in (bad.evidence.observation or "")

    absent = check_cta_allowlist(context_for(poster_path), rule)
    assert absent.verdict == "insufficient_evidence"


def test_cta_allowlist_not_applicable_without_configuration(context_for, poster_path):
    rule = make_rule("copy.cta", "copy.cta_allowlist", "copy")
    assert check_cta_allowlist(context_for(poster_path), rule).verdict == "not_applicable"
