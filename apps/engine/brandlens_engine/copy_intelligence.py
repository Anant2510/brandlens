"""Voice, lexicon and claims, read from a brand's own copy.

The division of labour is the same one the check pipeline uses, applied to
text instead of pixels: **we measure, the model judges.**

Measured in code, deterministically, and identical on every run:
  * readability (Flesch, Flesch-Kincaid, sentence and word counts)
  * sentence-length distribution and its variance
  * passive-voice, first-person and second-person rates
  * imperative and question rates
  * candidate claim sentences, found by the same superlative/absolute trigger
    set the claim-substantiation analyzer already uses in production
  * candidate disclaimers, found by legal boilerplate patterns
  * distinctive vocabulary, by frequency against a stopword baseline

Judged by a model, because they are genuinely matters of opinion:
  * what the voice IS — naming the axes and placing the brand on them
  * whether a candidate claim actually needs substantiating
  * whether a distinctive term is house style, jargon to avoid, or required

Every measured value is put INTO the prompt, so the model is never asked to
estimate a number it cannot count. And every quotation the model returns is
verified to appear verbatim in the corpus before it reaches the report: a
voice axis evidenced by a sentence the brand never wrote is worse than no
voice axis at all.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .config import Settings, get_settings
from .copy_checks import extract_claims, readability_metrics
from .llm.base import LLMError, NullProvider
from .llm.factory import build_provider, canonical_provider
from .logging import get_logger
from .models import (
    AnalyzeCopyRequest,
    AnalyzeCopyResponse,
    CopyPageInput,
    DiscoveredClaim,
    DiscoveredDisclaimer,
    DiscoveredLexiconTerm,
    DiscoveredVoiceAxis,
    ReadabilityProfile,
)

log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Deterministic measurement
# ---------------------------------------------------------------------------

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD = re.compile(r"[A-Za-z'’-]+")

# "was written", "is designed", "has been roasted" — auxiliary + past participle.
_PASSIVE = re.compile(
    r"\b(?:am|is|are|was|were|be|been|being|get|gets|got)\s+(?:\w+ly\s+)?(\w+ed|\w+en)\b",
    re.I,
)
_FIRST_PERSON = re.compile(r"\b(?:we|our|us|ours)\b", re.I)
_SECOND_PERSON = re.compile(r"\b(?:you|your|yours|you're|youre)\b", re.I)

# Legal boilerplate. Deliberately narrow: a disclaimer is a specific kind of
# sentence, and a loose pattern turns every footer link into one.
_DISCLAIMER = re.compile(
    r"(terms\s+(?:and\s+conditions\s+)?apply|t&cs?\s+apply|subject\s+to\s+(?:availability|status|change)|"
    r"registered\s+(?:in|office|trademark)|all\s+rights\s+reserved|"
    r"results?\s+(?:may|will)\s+vary|not\s+a\s+substitute\s+for|"
    r"capital\s+at\s+risk|your\s+home\s+may\s+be\s+repossessed|past\s+performance|"
    r"©|\(c\)\s*\d{4}|™|®|"
    r"substantiat\w+\s+on\s+request|where\s+applicable|excludes?\s+\w+|"
    r"18\+|over\s+18s?\s+only|please\s+drink\s+responsibly)",
    re.I,
)

# Words too common to be distinctive. Kept short on purpose: a big stoplist
# starts removing the very words that make a brand sound like itself.
_STOPWORDS = frozenset(
    """a an and are as at be been but by can could do does for from had has have he her his how i if in
    is it its me more most my no not of on or our out she should so some such than that the their them then
    there these they this to too up us was we were what when where which who will with would you your
    about after all also any because before between both during each few into just like new now off only
    other over own same through under very while will
    every much many able upon been being does done else ever here itself none once ours than thus were
    what whom whose your yours""".split()
)


@dataclass
class _Measured:
    """Everything computed without a model. This is the ground truth."""

    corpus: str
    sentences: list[str]
    readability: dict[str, float]
    readability_degraded: bool
    stats: dict[str, float]
    claim_candidates: list[dict[str, Any]] = field(default_factory=list)
    disclaimer_candidates: list[dict[str, Any]] = field(default_factory=list)
    distinctive_terms: list[dict[str, Any]] = field(default_factory=list)


def _sentences_of(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text) if s.strip()]


def measure_copy(pages: list[CopyPageInput]) -> _Measured:
    """Everything about the copy that is a fact rather than an opinion."""
    corpus_parts: list[str] = []
    for page in pages:
        body = (page.text or "").strip()
        if body:
            corpus_parts.append(body)
    corpus = "\n\n".join(corpus_parts)

    sentences = _sentences_of(corpus)
    words = _WORD.findall(corpus)
    lengths = [len(_WORD.findall(s)) for s in sentences] or [0]

    readability, degraded = readability_metrics(corpus) if corpus else ({}, True)

    mean_len = sum(lengths) / len(lengths)
    variance = sum((n - mean_len) ** 2 for n in lengths) / len(lengths)

    stats = {
        "words": float(len(words)),
        "sentences": float(len(sentences)),
        "meanSentenceWords": round(mean_len, 2),
        # Rhythm. A brand that alternates a four-word line with a thirty-word
        # one reads very differently from one that never varies, and the
        # standard deviation is the only honest way to say so.
        "sentenceLengthStdDev": round(variance**0.5, 2),
        "longestSentenceWords": float(max(lengths)),
        "passivePer100Sentences": _rate(_PASSIVE, corpus, len(sentences)),
        "firstPersonPer100Words": _rate(_FIRST_PERSON, corpus, len(words), per=100),
        "secondPersonPer100Words": _rate(_SECOND_PERSON, corpus, len(words), per=100),
        "questionRate": round(sum(1 for s in sentences if s.endswith("?")) / max(1, len(sentences)), 3),
        "exclamationRate": round(sum(1 for s in sentences if s.endswith("!")) / max(1, len(sentences)), 3),
    }

    return _Measured(
        corpus=corpus,
        sentences=sentences,
        readability=readability,
        readability_degraded=degraded,
        stats=stats,
        claim_candidates=_claim_candidates(pages),
        disclaimer_candidates=_disclaimer_candidates(pages),
        distinctive_terms=_distinctive_terms(pages),
    )


def _rate(pattern: re.Pattern[str], text: str, denominator: int, per: int = 100) -> float:
    if denominator <= 0:
        return 0.0
    return round(len(pattern.findall(text)) / denominator * per, 2)


def _claim_candidates(pages: list[CopyPageInput]) -> list[dict[str, Any]]:
    """Sentences a regulator would want evidence for, with the page they came from.

    Reuses `extract_claims` rather than re-implementing the trigger set, so a
    claim discovered on a website and a claim checked on an ad are found by
    exactly the same rule. Two detectors that disagree would be worse than one
    imperfect one.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        for candidate in extract_claims(page.text or ""):
            key = candidate["text"].strip().lower()
            if key in seen:
                continue
            seen.add(key)
            out.append({"text": candidate["text"], "triggers": candidate["triggers"], "url": page.url})
    return out[:60]


def _disclaimer_candidates(pages: list[CopyPageInput]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        for sentence in _sentences_of(page.text or ""):
            if len(sentence) < 12 or not _DISCLAIMER.search(sentence):
                continue
            key = sentence.strip().lower()[:200]
            if key in seen:
                continue
            seen.add(key)
            out.append({"text": sentence[:400], "url": page.url, "role": page.role})
    return out[:40]


def _distinctive_terms(pages: list[CopyPageInput]) -> list[dict[str, Any]]:
    """Vocabulary that recurs across pages — the brand's working words.

    Cross-page recurrence, not raw frequency, is the signal. A word used nine
    times on one product page is that product's word; a word used twice on six
    different pages is the brand's.
    """
    per_page: list[Counter[str]] = []
    for page in pages:
        words = [w.lower().strip("'’-") for w in _WORD.findall(page.text or "")]
        per_page.append(Counter(w for w in words if len(w) > 3 and w not in _STOPWORDS))

    total: Counter[str] = Counter()
    page_count: Counter[str] = Counter()
    for counts in per_page:
        total.update(counts)
        for word in counts:
            page_count[word] += 1

    # Cross-page recurrence is the ONLY gate. An earlier version also demanded
    # three total uses, which quietly contradicted the rule above: on a
    # three-page crawl a word written once per page is the brand's clearest
    # vocabulary and was being discarded for not being frequent enough.
    # Frequency still orders the list; it just no longer decides membership.
    candidates = [
        {"term": term, "count": total[term], "pageCount": page_count[term]}
        for term in total
        if page_count[term] >= 2
    ]
    candidates.sort(key=lambda c: (-c["pageCount"], -c["count"], c["term"]))
    return candidates[:40]


# ---------------------------------------------------------------------------
# LLM judgement
# ---------------------------------------------------------------------------

_VOICE_SYSTEM = """You are a brand strategist reading a company's own website copy.

Return STRICT JSON only. No prose, no markdown fence.

{
  "voiceAxes": [
    {"name": "...", "lowLabel": "...", "highLabel": "...", "value": 0.0,
     "rationale": "...", "evidence": ["exact sentence from the copy", "..."]}
  ],
  "lexicon": [
    {"term": "...", "kind": "preferred|required|banned|avoid", "note": "..."}
  ],
  "claims": [
    {"text": "exact sentence", "claimType": "superlative|comparative|quantified|health|environmental|financial|other",
     "needsSubstantiation": true, "suggestedEvidence": "..."}
  ],
  "disclaimers": [
    {"text": "exact sentence", "triggerCondition": "when this disclaimer must appear"}
  ]
}

RULES YOU MUST FOLLOW:

1. Every string in "evidence", and every "text" in claims and disclaimers,
   must be copied VERBATIM from the supplied copy. Do not paraphrase, tidy
   punctuation, or invent an example. Quotations that do not appear in the
   source are discarded and the axis they belong to is thrown away with them.

2. Name 4 to 6 voice axes, and choose them for THIS brand. Do not return a
   generic set. An axis is a pair of opposed adjectives with the brand placed
   between them: value 0.0 means fully lowLabel, 1.0 means fully highLabel.

3. The measured statistics are facts. If the copy averages 12-word sentences,
   do not describe it as dense. Reconcile your reading with the numbers, or
   say in the rationale why the numbers mislead here.

4. Only mark needsSubstantiation true when a reasonable regulator would ask
   for evidence. "The best coffee we have ever made" is opinion; "37% less
   sugar" is a claim.

5. For lexicon, prefer terms the brand actually uses distinctively over
   generic marketing words. If a candidate term is only industry jargon, mark
   it "avoid" and say why.
"""


def _judge_copy(
    measured: _Measured,
    request: AnalyzeCopyRequest,
    settings: Settings,
) -> tuple[dict[str, Any], float, list[str]]:
    provider = build_provider(canonical_provider(request.provider), request.model, settings)
    if isinstance(provider, NullProvider):
        return {}, 0.0, [f"copy judgement skipped: {provider.reason}"]

    # The corpus is trimmed rather than summarised: a model asked to name a
    # brand's voice from a summary is describing the summariser's voice.
    corpus = measured.corpus[: request.max_chars]

    prompt = (
        f"BRAND: {request.brand_name or 'unknown'}\n"
        f"SITE: {request.origin_url or 'unknown'}\n\n"
        f"MEASURED (computed deterministically — treat as fact):\n"
        f"{json.dumps({'readability': measured.readability, **measured.stats}, indent=2)}\n\n"
        f"CANDIDATE CLAIM SENTENCES (found by trigger words; you decide which are real claims):\n"
        f"{json.dumps([c['text'] for c in measured.claim_candidates][:30], indent=2)}\n\n"
        f"CANDIDATE DISCLAIMERS:\n"
        f"{json.dumps([d['text'] for d in measured.disclaimer_candidates][:20], indent=2)}\n\n"
        f"DISTINCTIVE VOCABULARY (term, uses, pages):\n"
        f"{json.dumps([[t['term'], t['count'], t['pageCount']] for t in measured.distinctive_terms[:30]])}\n\n"
        f"COPY:\n{corpus}"
    )

    try:
        completion = provider.complete(
            system=_VOICE_SYSTEM,
            prompt=prompt,
            temperature=0.0,
            max_tokens=4000,
        )
    except LLMError as exc:
        return {}, 0.0, [f"copy judgement failed: {exc}"]

    payload = _parse_json_object(completion.text or "")
    if payload is None:
        return {}, completion.cost_usd, ["copy judgement returned unparsable JSON"]
    return payload, completion.cost_usd, []


def _parse_json_object(text: str) -> dict[str, Any] | None:
    """Pulls the first JSON object out of a completion.

    Models wrap JSON in fences, prefix it with "Here is", or append a note
    however firmly the system prompt says not to. Extracting the braces is
    more reliable than insisting on clean output and failing the whole run.
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped, flags=re.S)
    match = re.search(r"\{.*\}", stripped, re.S)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# Grounding
# ---------------------------------------------------------------------------


def _normalise(text: str) -> str:
    """Collapses the differences that are not differences.

    A model reproducing a sentence will normalise a curly apostrophe or a
    non-breaking space without meaning to. Rejecting those would throw away
    good evidence; matching loosely on the letters keeps the check strict
    about the WORDS, which is what actually matters.
    """
    lowered = text.lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    lowered = lowered.replace(" ", " ").replace("—", "-").replace("–", "-")
    return re.sub(r"[^a-z0-9]+", " ", lowered).strip()


class _Grounder:
    """Verifies that a quotation actually appears in the brand's copy."""

    def __init__(self, corpus: str, pages: list[CopyPageInput]) -> None:
        self._corpus = _normalise(corpus)
        self._pages = [(page.url, _normalise(page.text or "")) for page in pages]

    def find(self, quote: str) -> str | None:
        """Returns the URL the quotation came from, or None if it is invented."""
        needle = _normalise(quote)
        # Below a handful of words a "quotation" matches by accident and
        # proves nothing.
        if len(needle) < 12:
            return None
        if needle not in self._corpus:
            return None
        for url, page_text in self._pages:
            if needle in page_text:
                return url
        return self._pages[0][0] if self._pages else None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def analyze_copy(request: AnalyzeCopyRequest, settings: Settings | None = None) -> AnalyzeCopyResponse:
    s = settings or get_settings()
    warnings: list[str] = []

    measured = measure_copy(request.pages)
    if not measured.corpus.strip():
        return AnalyzeCopyResponse(
            request_id=request.request_id,
            readability=ReadabilityProfile(metrics={}, degraded=True, stats={}),
            warnings=["no copy was supplied"],
        )
    if measured.readability_degraded:
        warnings.append("textstat unavailable — readability came from the vendored Flesch fallback")

    judged, cost, judge_warnings = _judge_copy(measured, request, s)
    warnings.extend(judge_warnings)

    grounder = _Grounder(measured.corpus, request.pages)

    axes = _build_axes(judged.get("voiceAxes"), grounder, warnings)
    lexicon = _build_lexicon(judged.get("lexicon"), measured, warnings)
    claims = _build_claims(judged.get("claims"), measured, grounder, warnings)
    disclaimers = _build_disclaimers(judged.get("disclaimers"), measured, grounder, warnings)

    return AnalyzeCopyResponse(
        request_id=request.request_id,
        voice_axes=axes,
        lexicon=lexicon,
        claims=claims,
        disclaimers=disclaimers,
        readability=ReadabilityProfile(
            metrics=measured.readability,
            degraded=measured.readability_degraded,
            stats=measured.stats,
        ),
        cost_usd=round(cost, 6),
        warnings=warnings,
    )


def _build_axes(raw: Any, grounder: _Grounder, warnings: list[str]) -> list[DiscoveredVoiceAxis]:
    axes: list[DiscoveredVoiceAxis] = []
    dropped = 0

    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        low = str(item.get("lowLabel") or "").strip()
        high = str(item.get("highLabel") or "").strip()
        if not name or not low or not high:
            continue

        try:
            value = float(item.get("value", 0.5))
        except (TypeError, ValueError):
            value = 0.5
        value = max(0.0, min(1.0, value))

        # An axis survives only if at least one of its quotations is real.
        # This is the anti-hallucination gate: a voice reading with no
        # verifiable evidence behind it is exactly the kind of confident,
        # unfalsifiable output that makes people stop trusting the tool.
        evidence: list[str] = []
        for quote in item.get("evidence") or []:
            text = str(quote).strip()
            if grounder.find(text):
                evidence.append(text[:400])

        if not evidence:
            dropped += 1
            continue

        axes.append(
            DiscoveredVoiceAxis(
                name=name[:80],
                low_label=low[:60],
                high_label=high[:60],
                value=round(value, 3),
                rationale=str(item.get("rationale") or "").strip()[:600] or None,
                evidence=evidence[:4],
            )
        )

    if dropped:
        warnings.append(f"{dropped} voice axis/axes discarded: their supporting quotations were not found in the copy")
    return axes[:8]


def _build_lexicon(raw: Any, measured: _Measured, warnings: list[str]) -> list[DiscoveredLexiconTerm]:
    """Keeps only terms the brand demonstrably uses.

    The measured vocabulary is the allowlist. A model asked for "banned terms"
    will happily invent a plausible list of words the brand has never written,
    and a lexicon full of terms nobody used is a lexicon nobody trusts.
    """
    observed = {t["term"].lower(): t for t in measured.distinctive_terms}
    terms: list[DiscoveredLexiconTerm] = []
    invented = 0

    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        term = str(item.get("term") or "").strip()
        if not term:
            continue

        head = term.lower().split()[0] if term.split() else ""
        stat = observed.get(term.lower()) or observed.get(head)
        if stat is None:
            invented += 1
            continue

        kind = str(item.get("kind") or "preferred").strip().lower()
        if kind not in {"preferred", "required", "banned", "avoid"}:
            kind = "preferred"

        terms.append(
            DiscoveredLexiconTerm(
                term=term[:120],
                kind=kind,
                note=str(item.get("note") or "").strip()[:300] or None,
                uses=int(stat["count"]),
                page_count=int(stat["pageCount"]),
            )
        )

    if invented:
        warnings.append(f"{invented} lexicon term(s) discarded: the brand's copy does not contain them")
    return terms[:30]


def _build_claims(
    raw: Any, measured: _Measured, grounder: _Grounder, warnings: list[str]
) -> list[DiscoveredClaim]:
    """Joins the model's judgement onto the deterministically found sentences.

    The model decides which candidates are real claims; it does not get to add
    sentences of its own. Detection stays deterministic so the same page always
    yields the same candidate set, and only the verdict varies.
    """
    verdicts: dict[str, dict[str, Any]] = {}
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict) and item.get("text"):
            verdicts[_normalise(str(item["text"]))] = item

    claims: list[DiscoveredClaim] = []
    for candidate in measured.claim_candidates:
        key = _normalise(candidate["text"])
        verdict = verdicts.get(key)

        # Fall back to a substring match: models often quote a claim without
        # its trailing clause.
        if verdict is None:
            for vkey, vitem in verdicts.items():
                if vkey and (vkey in key or key in vkey):
                    verdict = vitem
                    break

        claims.append(
            DiscoveredClaim(
                text=candidate["text"][:400],
                url=candidate["url"],
                triggers=candidate["triggers"],
                claim_type=str((verdict or {}).get("claimType") or "other")[:40],
                # Unjudged defaults to True. A claim the model never reached is
                # an open question, and the safe answer to an open question
                # about regulated copy is "a human should look at this".
                needs_substantiation=bool((verdict or {}).get("needsSubstantiation", True)),
                suggested_evidence=str((verdict or {}).get("suggestedEvidence") or "").strip()[:300] or None,
                judged=verdict is not None,
            )
        )

    unjudged = sum(1 for c in claims if not c.judged)
    if unjudged:
        warnings.append(f"{unjudged} claim(s) were detected but not judged; they default to needing substantiation")
    return claims[:60]


def _build_disclaimers(
    raw: Any, measured: _Measured, grounder: _Grounder, warnings: list[str]
) -> list[DiscoveredDisclaimer]:
    conditions: dict[str, str] = {}
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict) and item.get("text"):
            conditions[_normalise(str(item["text"]))] = str(item.get("triggerCondition") or "").strip()

    out: list[DiscoveredDisclaimer] = []
    for candidate in measured.disclaimer_candidates:
        key = _normalise(candidate["text"])
        condition = conditions.get(key)
        if condition is None:
            for ckey, cvalue in conditions.items():
                if ckey and (ckey in key or key in ckey):
                    condition = cvalue
                    break
        out.append(
            DiscoveredDisclaimer(
                text=candidate["text"],
                url=candidate["url"],
                trigger_condition=(condition or "").strip()[:300] or None,
            )
        )
    return out[:30]


__all__ = ["analyze_copy", "measure_copy"]
