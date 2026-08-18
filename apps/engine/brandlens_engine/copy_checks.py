"""Copy compliance: lexicon, claims, disclaimers, readability, spelling, CTAs.

Three ideas carry this module.

**Normalize before matching, but keep the offsets.** Real copy arrives with
typographic quotes, non-breaking spaces, soft hyphens, ligatures and — when it
came through OCR — `rn` for `m` and `0` for `O`. A banned term nobody can find
is a banned term that ships. We fold all of that away, and carry an index map so
the quoted evidence is still the writer's original characters, not our mangled
copy.

**One pass over the text, not one per term.** A lexicon of 800 terms against a
long brochure is 800 scans with naive matching. The Aho–Corasick automaton below
is a pure-Python implementation (adding `pyahocorasick` would mean a C build on
a machine with no compiler) that finds every term in a single O(n) pass.

**Disclaimers are a four-way check.** Present is not enough: the reader has to
be able to *read* it, which means present AND large enough AND contrasty enough
AND near the claim it qualifies. Regulators test all four; so do we.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import deque
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from rapidfuzz import fuzz

from .contrast import measure_local_contrast
from .logging import get_logger
from .models import DisclaimerEntry, LexiconEntry, RuleDefinition, build_result

if TYPE_CHECKING:
    from .models import CriterionResult
    from .pipeline import AnalysisContext

log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Aho–Corasick
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Match:
    start: int
    end: int
    pattern_id: int
    pattern: str


class AhoCorasick:
    """Multi-pattern exact matcher. Build once per lexicon, scan once per text.

    Deliberately hand-rolled: the C extension that would normally provide this
    cannot be installed on the target VM, and the automaton is 60 lines.
    """

    __slots__ = ("_goto", "_fail", "_out", "_patterns", "_built")

    def __init__(self) -> None:
        self._goto: list[dict[str, int]] = [{}]
        self._fail: list[int] = [0]
        self._out: list[list[int]] = [[]]
        self._patterns: list[str] = []
        self._built = False

    def add(self, pattern: str) -> int:
        if not pattern:
            return -1
        pid = len(self._patterns)
        self._patterns.append(pattern)
        node = 0
        for ch in pattern:
            nxt = self._goto[node].get(ch)
            if nxt is None:
                nxt = len(self._goto)
                self._goto.append({})
                self._fail.append(0)
                self._out.append([])
                self._goto[node][ch] = nxt
            node = nxt
        self._out[node].append(pid)
        self._built = False
        return pid

    def build(self) -> AhoCorasick:
        queue: deque[int] = deque()
        for child in self._goto[0].values():
            self._fail[child] = 0
            queue.append(child)
        while queue:
            node = queue.popleft()
            for ch, child in self._goto[node].items():
                queue.append(child)
                state = self._fail[node]
                while state and ch not in self._goto[state]:
                    state = self._fail[state]
                self._fail[child] = self._goto[state].get(ch, 0) if state or ch in self._goto[0] else 0
                if self._fail[child] == child:
                    self._fail[child] = 0
                # Suffix links carry their target's outputs, so a single node
                # visit reports every pattern ending here (e.g. "cheap" inside
                # "cheaper" when both are banned).
                self._out[child] = self._out[child] + self._out[self._fail[child]]
        self._built = True
        return self

    def find(self, text: str) -> list[Match]:
        if not self._built:
            self.build()
        results: list[Match] = []
        node = 0
        for i, ch in enumerate(text):
            while node and ch not in self._goto[node]:
                node = self._fail[node]
            node = self._goto[node].get(ch, 0)
            for pid in self._out[node]:
                pattern = self._patterns[pid]
                results.append(Match(start=i - len(pattern) + 1, end=i + 1, pattern_id=pid, pattern=pattern))
        return results

    @property
    def patterns(self) -> list[str]:
        return list(self._patterns)


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
_DASHES = "‐‑‒–—―−﹘﹣－"
_SINGLE_QUOTES = "‘’‚‛′´ʹʼ＇"
_DOUBLE_QUOTES = "“”„‟″«»＂"
_SPACES = "               　"
_INVISIBLE = "​‌‍⁠﻿­"
_LIGATURES = {
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
    "ﬅ": "st", "ﬆ": "st", "œ": "oe", "Œ": "OE", "æ": "ae", "Æ": "AE",
}
#: Glyph confusions an OCR pass introduces. Applied only when fuzzy matching is
#: enabled for a term, because folding these unconditionally would make "1-800"
#: and "l-8OO" indistinguishable in copy that was never OCR'd.
_OCR_CONFUSIONS = {
    "0": "o", "1": "l", "5": "s", "8": "b", "|": "l", "!": "l", "@": "a",
    "¡": "i", "€": "e", "$": "s", "£": "l",
}


@dataclass(slots=True)
class NormalizedText:
    text: str
    #: `offsets[i]` is the index in the original string that produced `text[i]`.
    offsets: list[int]
    original: str

    def slice_original(self, start: int, end: int) -> str:
        if not self.offsets:
            return ""
        s = self.offsets[max(0, min(start, len(self.offsets) - 1))]
        e = self.offsets[max(0, min(end - 1, len(self.offsets) - 1))] + 1
        return self.original[s:e]


def normalize_text(raw: str, lowercase: bool = True, ocr_fold: bool = False) -> NormalizedText:
    """Fold typographic and OCR variation away, preserving an offset map."""
    original = raw or ""
    out: list[str] = []
    offsets: list[int] = []

    for idx, ch in enumerate(original):
        if ch in _INVISIBLE:
            continue
        if ch in _LIGATURES:
            for sub in _LIGATURES[ch]:
                out.append(sub)
                offsets.append(idx)
            continue
        if ch in _DASHES:
            replacement = "-"
        elif ch in _SINGLE_QUOTES:
            replacement = "'"
        elif ch in _DOUBLE_QUOTES:
            replacement = '"'
        elif ch in _SPACES or ch in "\t\r\n\f\v":
            replacement = " "
        else:
            # NFKD then drop combining marks: "café" and "cafe" must match.
            decomposed = unicodedata.normalize("NFKD", ch)
            replacement = "".join(c for c in decomposed if not unicodedata.combining(c)) or ch
        if lowercase:
            replacement = replacement.lower()
        if ocr_fold:
            replacement = "".join(_OCR_CONFUSIONS.get(c, c) for c in replacement)
        for sub in replacement:
            out.append(sub)
            offsets.append(idx)

    # Collapse runs of spaces so "brand  new" matches "brand new".
    collapsed: list[str] = []
    collapsed_offsets: list[int] = []
    prev_space = False
    for ch, off in zip(out, offsets, strict=True):
        if ch == " ":
            if prev_space:
                continue
            prev_space = True
        else:
            prev_space = False
        collapsed.append(ch)
        collapsed_offsets.append(off)

    return NormalizedText(text="".join(collapsed), offsets=collapsed_offsets, original=original)


_WORD_CHAR = re.compile(r"[\wÀ-ɏ]")


def is_whole_word(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start > 0 else " "
    after = text[end] if end < len(text) else " "
    return not _WORD_CHAR.match(before) and not _WORD_CHAR.match(after)


def fuzzy_find(needle: str, haystack: str, min_score: float = 88.0) -> tuple[int, int, float] | None:
    """Best fuzzy window for `needle`. Used when a term allows fuzzy matching."""
    if not needle or not haystack:
        return None
    n = len(needle)
    best: tuple[int, int, float] | None = None
    # Slide a window of the needle's length +/- 25% and score it.
    for width in {max(1, int(n * 0.8)), n, int(n * 1.25) + 1}:
        step = max(1, width // 4)
        for start in range(0, max(1, len(haystack) - width + 1), step):
            window = haystack[start : start + width]
            score = fuzz.ratio(needle, window)
            if score >= min_score and (best is None or score > best[2]):
                best = (start, start + width, float(score))
    return best


# ---------------------------------------------------------------------------
# Text assembly
# ---------------------------------------------------------------------------
def asset_copy(ctx: AnalysisContext) -> tuple[str, str]:
    """All readable copy plus the path that produced it."""
    fields = ctx.asset.copy_fields or {}
    if fields:
        return "\n".join(f"{v}" for v in fields.values() if v), "copyFields"
    doc = ctx.structured()
    if doc.available and doc.plain_text.strip():
        return doc.plain_text, doc.kind
    spans = ctx.text_spans()
    if spans:
        return "\n".join(s.text for s in spans), "ocr"
    return "", "none"


def _no_copy(ctx: AnalysisContext, rule: RuleDefinition, what: str) -> CriterionResult:
    driver = ctx.settings.ocr_driver
    reason = (
        f"OCR driver is {driver!r}, so no text could be recovered from the pixels"
        if driver == "none"
        else "no copy fields, structured text or OCR spans were available"
    )
    return build_result(
        rule,
        "insufficient_evidence",
        observation=f"{what} needs text and none was available: {reason}.",
        measured={"copySource": "none", "ocrDriver": driver},
    )


# ---------------------------------------------------------------------------
# copy.banned_terms / copy.required_terms
# ---------------------------------------------------------------------------
def _market_applies(market_codes: list[str] | None, asset_market: str | None) -> bool:
    if not market_codes:
        return True
    if not asset_market:
        return True  # unscoped asset: apply everything rather than silently skip
    m = asset_market.strip().upper()
    return any(m == str(c).strip().upper() for c in market_codes)


def _scan_lexicon(
    ctx: AnalysisContext, kinds: set[str], text: str
) -> tuple[list[dict[str, Any]], NormalizedText, int]:
    entries = [
        e
        for e in ctx.brand.lexicon
        if e.kind in kinds and _market_applies(e.market_codes, ctx.asset.market)
    ]
    if not entries:
        return [], normalize_text(text), 0

    norm = normalize_text(text, lowercase=True)
    norm_cs = normalize_text(text, lowercase=False)

    automaton_ci = AhoCorasick()
    automaton_cs = AhoCorasick()
    index_ci: dict[str, list[int]] = {}
    index_cs: dict[str, list[int]] = {}
    for i, entry in enumerate(entries):
        target = normalize_text(entry.term, lowercase=not entry.case_sensitive).text
        if not target:
            continue
        if entry.case_sensitive:
            if target not in index_cs:
                automaton_cs.add(target)
            index_cs.setdefault(target, []).append(i)
        else:
            if target not in index_ci:
                automaton_ci.add(target)
            index_ci.setdefault(target, []).append(i)

    found: list[dict[str, Any]] = []
    seen: set[tuple[int, int, int]] = set()

    for automaton, source, index in ((automaton_ci, norm, index_ci), (automaton_cs, norm_cs, index_cs)):
        if not index:
            continue
        for m in automaton.build().find(source.text):
            for entry_idx in index.get(m.pattern, []):
                entry = entries[entry_idx]
                if entry.match_whole_word and not is_whole_word(source.text, m.start, m.end):
                    continue
                key = (entry_idx, m.start, m.end)
                if key in seen:
                    continue
                seen.add(key)
                found.append(
                    {
                        "term": entry.term,
                        "kind": entry.kind,
                        "severity": entry.severity,
                        "replacement": entry.replacement,
                        "quoted": source.slice_original(m.start, m.end),
                        "charOffset": source.offsets[m.start] if m.start < len(source.offsets) else 0,
                        "matchType": "exact",
                        "score": 100.0,
                    }
                )

    # Fuzzy pass only for terms not already found exactly — catches OCR damage
    # and the near-misses writers reach for when a word is banned.
    ocr_text = normalize_text(text, lowercase=True, ocr_fold=True)
    exact_terms = {f["term"] for f in found}
    for entry in entries:
        if not entry.allow_fuzzy or entry.term in exact_terms:
            continue
        needle = normalize_text(entry.term, lowercase=True, ocr_fold=True).text
        if len(needle) < 4:
            continue  # short strings fuzzy-match everything
        hit = fuzzy_find(needle, ocr_text.text, min_score=90.0)
        if hit:
            start, end, score = hit
            found.append(
                {
                    "term": entry.term,
                    "kind": entry.kind,
                    "severity": entry.severity,
                    "replacement": entry.replacement,
                    "quoted": ocr_text.slice_original(start, end),
                    "charOffset": ocr_text.offsets[start] if start < len(ocr_text.offsets) else 0,
                    "matchType": "fuzzy",
                    "score": round(score, 1),
                }
            )
    return found, norm, len(entries)


def check_banned_terms(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Banned-term scanning")

    extra = [str(t) for t in (rule.check.params.get("terms") or [])]
    hits, _norm, entry_count = _scan_lexicon(ctx, {"banned"}, text)

    if extra:
        automaton = AhoCorasick()
        norm = normalize_text(text)
        for t in extra:
            automaton.add(normalize_text(t).text)
        for m in automaton.build().find(norm.text):
            if is_whole_word(norm.text, m.start, m.end):
                hits.append(
                    {
                        "term": m.pattern,
                        "kind": "banned",
                        "severity": rule.severity,
                        "replacement": None,
                        "quoted": norm.slice_original(m.start, m.end),
                        "charOffset": norm.offsets[m.start] if m.start < len(norm.offsets) else 0,
                        "matchType": "exact",
                        "score": 100.0,
                        "origin": "rule.params",
                    }
                )

    measured = {
        "copySource": source,
        "copyChars": len(text),
        "lexiconEntries": entry_count + len(extra),
        "hitCount": len(hits),
        "hits": hits[:25],
    }
    thresholds = {"maxHits": 0, "market": ctx.asset.market}

    if entry_count + len(extra) == 0:
        return build_result(
            rule,
            "not_applicable",
            measured=measured,
            threshold=thresholds,
            observation="No banned terms apply to this asset's market.",
        )
    if hits:
        worst = max(hits, key=lambda h: {"blocker": 3, "major": 2, "minor": 1, "advisory": 0}.get(str(h["severity"]), 1))
        fix = (
            f"Replace {worst['term']!r} with {worst['replacement']!r}."
            if worst.get("replacement")
            else f"Remove {worst['term']!r}."
        )
        return build_result(
            rule,
            "fail",
            severity=worst["severity"] if worst["severity"] in ("blocker", "major", "minor", "advisory") else None,  # type: ignore[arg-type]
            measured=measured,
            threshold=thresholds,
            quoted_text=str(worst["quoted"])[:200],
            observation=(
                f"{len(hits)} banned term occurrence(s); highest-severity is {worst['term']!r} "
                f"({worst['matchType']} match)."
            ),
            suggested_fix=fix,
            confidence=0.99 if worst["matchType"] == "exact" else 0.8,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"No banned term found across {len(text)} characters of copy from {source}.",
        confidence=0.97,
    )


def check_required_terms(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Required-term verification")

    required = [
        e
        for e in ctx.brand.lexicon
        if e.kind in ("required", "trademark") and _market_applies(e.market_codes, ctx.asset.market)
    ]
    # Terms declared inline on the rule are treated exactly like register
    # entries so downstream handling has a single code path.
    for t in rule.check.params.get("terms") or []:
        required.append(LexiconEntry(term=str(t), kind="required", severity=rule.severity))

    if not required:
        return build_result(
            rule,
            "not_applicable",
            measured={"copySource": source, "requiredTerms": 0},
            observation="No required terms apply to this asset's market.",
        )

    norm = normalize_text(text)
    present: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for entry in required:
        needle = normalize_text(entry.term, lowercase=not entry.case_sensitive).text
        haystack = norm.text if not entry.case_sensitive else normalize_text(text, lowercase=False).text
        idx = haystack.find(needle)
        if idx >= 0 and (not entry.match_whole_word or is_whole_word(haystack, idx, idx + len(needle))):
            present.append({"term": entry.term, "matchType": "exact"})
            continue
        if entry.allow_fuzzy and len(needle) >= 4:
            hit = fuzzy_find(needle, haystack, min_score=92.0)
            if hit:
                present.append({"term": entry.term, "matchType": "fuzzy", "score": round(hit[2], 1)})
                continue
        missing.append({"term": entry.term, "kind": entry.kind, "severity": entry.severity})

    measured = {
        "copySource": source,
        "requiredCount": len(required),
        "presentCount": len(present),
        "present": present[:25],
        "missing": missing[:25],
    }
    thresholds = {"requiredTerms": [e.term for e in required], "market": ctx.asset.market}
    if missing:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"{len(missing)} required term(s) absent from the copy: "
                + ", ".join(str(m["term"]) for m in missing[:5])
                + ("..." if len(missing) > 5 else "")
            ),
            suggested_fix=f"Add the missing mandatory wording: {missing[0]['term']!r}.",
            confidence=0.95,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"All {len(required)} required term(s) are present.",
        confidence=0.95,
    )


# ---------------------------------------------------------------------------
# copy.readability
# ---------------------------------------------------------------------------
_VOWEL_GROUPS = re.compile(r"[aeiouy]+", re.I)


def _fallback_syllables(word: str) -> int:
    """Heuristic syllable count for the vendored Flesch fallback."""
    w = word.lower().strip(".,;:!?\"'()")
    if not w:
        return 0
    groups = len(_VOWEL_GROUPS.findall(w))
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and groups > 1:
        groups -= 1
    return max(1, groups)


def _fallback_flesch(text: str) -> dict[str, float]:
    sentences = max(1, len([s for s in re.split(r"[.!?]+", text) if s.strip()]))
    words = re.findall(r"[A-Za-z'À-ɏ]+", text)
    if not words:
        return {"fleschReadingEase": 0.0, "fleschKincaidGrade": 0.0, "words": 0, "sentences": sentences}
    syllables = sum(_fallback_syllables(w) for w in words)
    wps = len(words) / sentences
    spw = syllables / len(words)
    return {
        "fleschReadingEase": round(206.835 - 1.015 * wps - 84.6 * spw, 2),
        "fleschKincaidGrade": round(0.39 * wps + 11.8 * spw - 15.59, 2),
        "words": len(words),
        "sentences": sentences,
    }


def readability_metrics(text: str) -> tuple[dict[str, float], bool]:
    """textstat metrics, with a vendored Flesch fallback. Returns (metrics, degraded)."""
    try:
        import textstat

        return (
            {
                "fleschReadingEase": round(float(textstat.flesch_reading_ease(text)), 2),
                "fleschKincaidGrade": round(float(textstat.flesch_kincaid_grade(text)), 2),
                "gunningFog": round(float(textstat.gunning_fog(text)), 2),
                "smogIndex": round(float(textstat.smog_index(text)), 2),
                "automatedReadabilityIndex": round(float(textstat.automated_readability_index(text)), 2),
                "colemanLiauIndex": round(float(textstat.coleman_liau_index(text)), 2),
                "daleChall": round(float(textstat.dale_chall_readability_score(text)), 2),
                "words": int(textstat.lexicon_count(text, removepunct=True)),
                "sentences": int(textstat.sentence_count(text)),
                "difficultWords": int(textstat.difficult_words(text)),
            },
            False,
        )
    except Exception as exc:  # noqa: BLE001 - a missing corpus must not fail the run
        log.warning("textstat_unavailable", error=str(exc))
        return _fallback_flesch(text), True


def check_readability(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Readability scoring")

    params = rule.check.params
    min_words = int(params.get("minWords", 20))
    words = len(re.findall(r"\w+", text))
    if words < min_words:
        return build_result(
            rule,
            "not_applicable",
            measured={"copySource": source, "words": words},
            threshold={"minWords": min_words},
            observation=(
                f"Only {words} words of copy. Readability formulas are calibrated on prose "
                f"and are meaningless below ~{min_words} words — a headline is not 'unreadable'."
            ),
        )

    metrics, degraded = readability_metrics(text)
    min_ease = params.get("minFleschReadingEase")
    max_grade = params.get("maxFleschKincaidGrade")
    if min_ease is None and max_grade is None:
        max_grade = 10.0  # a common default for consumer marketing copy

    measured = {"copySource": source, "degradedToFallback": degraded, **metrics}
    thresholds = {"minFleschReadingEase": min_ease, "maxFleschKincaidGrade": max_grade}
    problems: list[str] = []
    if min_ease is not None and metrics["fleschReadingEase"] < float(min_ease):
        problems.append(f"reading ease {metrics['fleschReadingEase']} below {min_ease}")
    if max_grade is not None and metrics["fleschKincaidGrade"] > float(max_grade):
        problems.append(f"grade level {metrics['fleschKincaidGrade']} above {max_grade}")

    if problems:
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            observation="Copy is harder to read than the target: " + "; ".join(problems) + ".",
            suggested_fix="Shorten sentences and prefer shorter, more common words.",
            confidence=0.85 if not degraded else 0.7,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=(
            f"Reading ease {metrics['fleschReadingEase']}, grade {metrics['fleschKincaidGrade']} "
            f"over {metrics.get('words', words)} words."
        ),
        confidence=0.85 if not degraded else 0.7,
    )


# ---------------------------------------------------------------------------
# copy.claim_substantiation
# ---------------------------------------------------------------------------
_SUPERLATIVE = re.compile(
    r"\b(best|fastest|safest|strongest|cheapest|healthiest|number one|no\.?\s*1|#1|"
    r"world'?s\s+\w+est|leading|unrivalled|unrivaled|guaranteed|proven|clinically\s+proven|"
    r"\d+\s*%\s+(?:more|less|better|faster|fewer)|up\s+to\s+\d+\s*%)\b",
    re.I,
)


def extract_claims(text: str) -> list[dict[str, Any]]:
    """Sentences that assert something a regulator would want substantiated."""
    out: list[dict[str, Any]] = []
    offset = 0
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        stripped = sentence.strip()
        if stripped:
            triggers = [m.group(0) for m in _SUPERLATIVE.finditer(stripped)]
            if triggers:
                out.append(
                    {
                        "text": stripped[:300],
                        "triggers": sorted(set(t.lower() for t in triggers)),
                        "charOffset": text.find(stripped, offset),
                    }
                )
        offset += len(sentence) + 1
    return out


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        cleaned = value.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned).date()
    except ValueError:
        try:
            return datetime.strptime(value[:10], "%Y-%m-%d").date()
        except ValueError:
            return None


def check_claim_substantiation(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Join detected claims against the tenant's claims register.

    Four ways a claim fails, all of them things a legal reviewer checks by hand
    today: it is not in the register at all; it is registered but inactive; it
    has expired; or it is not approved for this asset's jurisdiction.
    """
    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Claim substantiation")

    params = rule.check.params
    today = _parse_date(str(params.get("asOfDate"))) or datetime.now(UTC).date()
    jurisdiction = (ctx.asset.market or params.get("jurisdiction") or "").strip().upper()
    fuzzy_threshold = float(params.get("fuzzyThreshold", 88.0))

    norm = normalize_text(text)
    detected = extract_claims(text)

    register: list[tuple[Any, str]] = []
    for claim in ctx.brand.claims:
        for variant in [claim.text, *claim.variants]:
            v = normalize_text(variant).text
            if v:
                register.append((claim, v))

    unregistered: list[dict[str, Any]] = []
    problems: list[dict[str, Any]] = []
    matched: list[dict[str, Any]] = []

    for item in detected:
        needle = normalize_text(str(item["text"])).text
        best: tuple[Any, float] | None = None
        for claim, variant in register:
            score = max(
                fuzz.partial_ratio(variant, needle),
                fuzz.token_set_ratio(variant, needle),
            )
            if best is None or score > best[1]:
                best = (claim, float(score))
        if best is None or best[1] < fuzzy_threshold:
            unregistered.append({**item, "bestScore": round(best[1], 1) if best else 0.0})
            continue

        claim, score = best
        record = {
            "claimId": claim.id,
            "claimText": claim.text[:120],
            "detected": str(item["text"])[:160],
            "score": round(score, 1),
            "triggers": item["triggers"],
        }
        matched.append(record)

        if not claim.is_active:
            problems.append({**record, "problem": "claim is marked inactive in the register"})
        expiry = _parse_date(claim.expires_at)
        if expiry is not None and expiry < today:
            problems.append({**record, "problem": f"claim expired on {expiry.isoformat()}"})
        if claim.jurisdictions and jurisdiction:
            allowed = {j.strip().upper() for j in claim.jurisdictions}
            if jurisdiction not in allowed:
                problems.append(
                    {**record, "problem": f"claim is not approved for {jurisdiction} (approved: {sorted(allowed)})"}
                )
        if claim.required_disclaimer_id:
            disclaimer = next((d for d in ctx.brand.disclaimers if d.id == claim.required_disclaimer_id), None)
            if disclaimer is None:
                problems.append({**record, "problem": "required disclaimer is not defined in the brand context"})
            else:
                needle_d = normalize_text(disclaimer.text).text
                found = needle_d and (needle_d in norm.text or bool(fuzzy_find(needle_d, norm.text, 85.0)))
                if not found:
                    problems.append(
                        {**record, "problem": f"required disclaimer {disclaimer.name!r} is missing from the asset"}
                    )

    measured = {
        "copySource": source,
        "detectedClaims": detected[:20],
        "matchedClaims": matched[:20],
        "unregisteredClaims": unregistered[:20],
        "problems": problems[:20],
        "registerSize": len(ctx.brand.claims),
        "asOfDate": today.isoformat(),
        "jurisdiction": jurisdiction or None,
    }
    thresholds = {"fuzzyThreshold": fuzzy_threshold, "requireRegistered": True}

    if not detected:
        return build_result(
            rule,
            "pass",
            measured=measured,
            threshold=thresholds,
            observation="No substantiation-triggering claim language detected in the copy.",
            confidence=0.8,
        )
    if not ctx.brand.claims:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            quoted_text=str(detected[0]["text"])[:200],
            observation=(
                f"{len(detected)} claim-like statement(s) detected but the tenant's claims register "
                "is empty, so substantiation cannot be verified either way."
            ),
        )
    if problems or unregistered:
        first = (problems or unregistered)[0]
        detail = str(first.get("problem", "not present in the claims register"))
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            quoted_text=str(first.get("detected") or first.get("text"))[:200],
            observation=(
                f"{len(problems)} registered-claim problem(s) and {len(unregistered)} unregistered "
                f"claim(s). First: {detail}."
            ),
            suggested_fix="Substantiate the claim in the register, or remove the claim language.",
            confidence=0.85,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"All {len(matched)} detected claim(s) are registered, active and in-jurisdiction.",
        confidence=0.85,
    )


# ---------------------------------------------------------------------------
# copy.disclaimer_present  (the four-way check)
# ---------------------------------------------------------------------------
def _applicable_disclaimers(ctx: AnalysisContext, rule: RuleDefinition) -> list[DisclaimerEntry]:
    ids = rule.check.params.get("disclaimerIds")
    out: list[DisclaimerEntry] = []
    for d in ctx.brand.disclaimers:
        if ids and d.id not in ids:
            continue
        if not _market_applies(d.market_codes, ctx.asset.market):
            continue
        if d.channels and ctx.asset.channel and ctx.asset.channel not in d.channels:
            continue
        out.append(d)
    return out


def check_disclaimer_present(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """Present AND legible AND contrasty AND near what it qualifies.

    A disclaimer that is present but 4pt, or present but 1.6:1 against its
    background, or present but on the opposite side of the layout from the claim
    it modifies, fails the purpose it exists for. Each leg is measured
    separately so the finding tells the designer which one to fix.
    """
    disclaimers = _applicable_disclaimers(ctx, rule)
    if not disclaimers:
        return build_result(
            rule,
            "not_applicable",
            measured={"applicableDisclaimers": 0, "market": ctx.asset.market, "channel": ctx.asset.channel},
            observation="No disclaimer applies to this asset's market and channel.",
        )

    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Disclaimer verification")

    params = rule.check.params
    min_score = float(params.get("fuzzyThreshold", 85.0))
    norm = normalize_text(text)
    img = ctx.image()
    doc = ctx.structured()
    spans = ctx.text_spans()

    results: list[dict[str, Any]] = []
    for d in disclaimers:
        needle = normalize_text(d.text).text
        exact = needle and needle in norm.text
        fuzzy = None if exact else (fuzzy_find(needle, norm.text, min_score) if needle else None)
        present = bool(exact or fuzzy)

        # Only *configured* legs appear. A disclaimer with no minContrastRatio
        # is not "unmeasured on contrast", it simply has no contrast requirement,
        # and conflating the two turns every pass into insufficient_evidence.
        legs: dict[str, bool | None] = {"present": present}
        for leg, configured in (
            ("size", d.min_font_size_pt is not None),
            ("contrast", d.min_contrast_ratio is not None),
            ("proximity", d.max_proximity_pct is not None),
        ):
            if configured:
                legs[leg] = None

        record: dict[str, Any] = {
            "disclaimerId": d.id,
            "name": d.name,
            "present": present,
            "matchType": "exact" if exact else ("fuzzy" if fuzzy else "absent"),
            "matchScore": round(fuzzy[2], 1) if fuzzy else (100.0 if exact else 0.0),
            "legs": legs,
        }

        # Locate it so the size/contrast/proximity legs have geometry to use.
        located = None
        for el in doc.all_text:
            if fuzz.partial_ratio(normalize_text(el.text).text, needle) >= min_score and len(el.text) > 8:
                located = {"bbox": el.bbox, "sizePt": el.font_size_pt, "source": doc.kind}
                break
        if located is None:
            for span in spans:
                if fuzz.partial_ratio(normalize_text(span.text).text, needle) >= min_score:
                    located = {
                        "bbox": span.bbox,
                        "sizePt": span.font_size_pt_estimate or 0.0,
                        "source": span.source,
                    }
                    break
        record["located"] = located

        if present and d.min_font_size_pt is not None:
            if located and float(located["sizePt"]) > 0:
                size_ok = float(located["sizePt"]) + 1e-6 >= float(d.min_font_size_pt)
                record["legs"]["size"] = size_ok
                record["sizePt"] = round(float(located["sizePt"]), 2)
            else:
                record["legs"]["size"] = None
                record["sizeNote"] = "type size unavailable without a structured source or OCR geometry"

        if present and d.min_contrast_ratio is not None:
            if located and img is not None:
                from .media import denorm_bbox

                box_px = denorm_bbox(tuple(located["bbox"]), img.width, img.height)
                local = measure_local_contrast(img.rgb, box_px)
                record["contrastRatio"] = local.ratio
                record["contrastReliable"] = local.reliable
                record["legs"]["contrast"] = local.ratio + 1e-6 >= float(d.min_contrast_ratio)
            else:
                record["legs"]["contrast"] = None
                record["contrastNote"] = "no pixels or no located disclaimer region"

        if present and d.max_proximity_pct is not None:
            anchor_boxes: list[tuple[float, float, float, float]] = []
            for claim in ctx.brand.claims:
                if claim.required_disclaimer_id != d.id:
                    continue
                cn = normalize_text(claim.text).text
                for el in doc.all_text:
                    if cn and fuzz.partial_ratio(normalize_text(el.text).text, cn) >= min_score:
                        anchor_boxes.append(el.bbox)
                for span in spans:
                    if cn and fuzz.partial_ratio(normalize_text(span.text).text, cn) >= min_score:
                        anchor_boxes.append(span.bbox)
            if located and anchor_boxes:
                db = tuple(located["bbox"])
                dcx, dcy = (db[0] + db[2]) / 2, (db[1] + db[3]) / 2
                best = min(
                    math.hypot(dcx - (a[0] + a[2]) / 2, dcy - (a[1] + a[3]) / 2) for a in anchor_boxes
                )
                # Distance normalized to the canvas diagonal so the threshold is
                # resolution- and aspect-independent.
                proximity_pct = best / math.sqrt(2.0) * 100.0
                record["proximityPct"] = round(proximity_pct, 2)
                record["legs"]["proximity"] = proximity_pct <= float(d.max_proximity_pct)
            else:
                record["legs"]["proximity"] = None
                record["proximityNote"] = "no located claim anchor to measure distance from"

        results.append(record)

    failed = [r for r in results if not r["present"] or any(v is False for v in r["legs"].values())]
    unknown_legs = [
        r
        for r in results
        if r["present"] and any(v is None for k, v in r["legs"].items() if k != "present")
    ]

    measured = {
        "copySource": source,
        "disclaimers": results,
        "failedCount": len(failed),
        "structuredSource": doc.kind,
    }
    thresholds = {
        d.id: {
            "minFontSizePt": d.min_font_size_pt,
            "minContrastRatio": d.min_contrast_ratio,
            "maxProximityPct": d.max_proximity_pct,
            "severity": d.severity,
        }
        for d in disclaimers
    }

    if failed:
        worst = failed[0]
        broken = [leg for leg, ok in worst["legs"].items() if ok is False]
        if not worst["present"]:
            detail = f"{worst['name']!r} is absent from the copy"
        else:
            detail = f"{worst['name']!r} fails on: {', '.join(broken)}"
        severity = next((d.severity for d in disclaimers if d.id == worst["disclaimerId"]), rule.severity)
        return build_result(
            rule,
            "fail",
            severity=severity,
            measured=measured,
            threshold=thresholds,
            bbox=tuple(worst["located"]["bbox"]) if worst.get("located") else None,  # type: ignore[arg-type]
            quoted_text=next((d.text[:200] for d in disclaimers if d.id == worst["disclaimerId"]), None),
            observation=f"{len(failed)} disclaimer problem(s). {detail}.",
            suggested_fix="Add the disclaimer at the required size, contrast and proximity to the claim.",
            confidence=0.95,
        )
    if unknown_legs:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation=(
                f"All {len(results)} disclaimer(s) are present, but size/contrast/proximity could not be "
                "measured without structured geometry or OCR spans."
            ),
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"All {len(results)} applicable disclaimer(s) pass presence, size, contrast and proximity.",
        confidence=0.95,
    )


# ---------------------------------------------------------------------------
# copy.locale_spelling
# ---------------------------------------------------------------------------
#: Small, high-precision list. A full dictionary would need a corpus download;
#: these suffixes and words cover the overwhelming majority of real findings.
_GB_TO_US = {
    "colour": "color", "colours": "colors", "favourite": "favorite", "favour": "favor",
    "behaviour": "behavior", "honour": "honor", "labour": "labor", "neighbour": "neighbor",
    "centre": "center", "centres": "centers", "theatre": "theater", "litre": "liter",
    "metre": "meter", "fibre": "fiber", "organise": "organize", "organised": "organized",
    "organisation": "organization", "realise": "realize", "realised": "realized",
    "recognise": "recognize", "recognised": "recognized", "personalise": "personalize",
    "personalised": "personalized", "customise": "customize", "customised": "customized",
    "analyse": "analyze", "analysed": "analyzed", "catalogue": "catalog", "dialogue": "dialog",
    "programme": "program", "cheque": "check", "grey": "gray", "travelling": "traveling",
    "traveller": "traveler", "cancelled": "canceled", "jewellery": "jewelry",
    "licence": "license", "defence": "defense", "offence": "offense", "practise": "practice",
    "enrolment": "enrollment", "fulfil": "fulfill", "instalment": "installment",
    "aluminium": "aluminum", "speciality": "specialty", "whilst": "while", "amongst": "among",
}
_US_TO_GB = {v: k for k, v in _GB_TO_US.items()}


def check_locale_spelling(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    text, source = asset_copy(ctx)
    if not text.strip():
        return _no_copy(ctx, rule, "Locale spelling verification")

    params = rule.check.params
    locale = str(params.get("locale") or ctx.asset.locale or "").strip().replace("_", "-")
    if not locale:
        return build_result(
            rule,
            "not_applicable",
            measured={"copySource": source, "locale": None},
            observation="No locale is set on the asset or the rule, so spelling variant cannot be enforced.",
        )

    lang = locale.split("-")[0].lower()
    region = locale.split("-")[1].upper() if "-" in locale else ""
    if lang != "en":
        return build_result(
            rule,
            "not_applicable",
            measured={"copySource": source, "locale": locale},
            observation=f"Locale-spelling rules are only modelled for English; asset locale is {locale!r}.",
        )

    # en-GB and the Commonwealth variants share British spelling conventions.
    prefer_gb = region in ("GB", "UK", "IE", "AU", "NZ", "ZA", "IN", "SG", "HK", "MY", "")
    wrong_map = _US_TO_GB if prefer_gb else _GB_TO_US
    expected_variant = "en-GB" if prefer_gb else "en-US"

    norm = normalize_text(text)
    automaton = AhoCorasick()
    for word in wrong_map:
        automaton.add(word)

    hits: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for m in automaton.build().find(norm.text):
        if not is_whole_word(norm.text, m.start, m.end):
            continue
        key = (m.pattern, m.start)
        if key in seen:
            continue
        seen.add(key)
        hits.append(
            {
                "found": norm.slice_original(m.start, m.end),
                "expected": wrong_map[m.pattern],
                "charOffset": norm.offsets[m.start] if m.start < len(norm.offsets) else 0,
            }
        )

    measured = {
        "copySource": source,
        "locale": locale,
        "expectedVariant": expected_variant,
        "hitCount": len(hits),
        "hits": hits[:25],
    }
    thresholds = {"expectedVariant": expected_variant, "maxHits": 0}
    if hits:
        first = hits[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            quoted_text=str(first["found"]),
            observation=(
                f"{len(hits)} word(s) use the wrong English variant for {locale}; "
                f"e.g. {first['found']!r} should be {first['expected']!r}."
            ),
            suggested_fix=f"Convert the copy to {expected_variant} spelling.",
            confidence=0.9,
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        observation=f"No {('American' if prefer_gb else 'British')} spellings found in {locale} copy.",
        confidence=0.9,
    )


# ---------------------------------------------------------------------------
# copy.cta_allowlist
# ---------------------------------------------------------------------------
_CTA_FIELD_HINTS = ("cta", "button", "action", "buttonlabel", "cta_label", "ctatext")


def check_cta_allowlist(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    """CTAs are usually contractually fixed per channel, so this is exact-match
    (after normalization), not fuzzy — 'Learn More!' is not 'Learn more'."""
    params = rule.check.params
    allowed = [str(c) for c in (params.get("allowedCtas") or params.get("allowed") or [])]
    if not allowed:
        return build_result(
            rule,
            "not_applicable",
            measured={"allowedCtas": 0},
            observation="No CTA allowlist is configured on this rule.",
        )

    candidates: list[dict[str, Any]] = []
    for key, value in (ctx.asset.copy_fields or {}).items():
        if any(hint in key.lower().replace(" ", "").replace("-", "") for hint in _CTA_FIELD_HINTS):
            if value.strip():
                candidates.append({"source": f"copyFields.{key}", "text": value.strip()})

    if not candidates:
        # Fall back to short imperative-looking runs from the structured source.
        for el in ctx.structured().all_text:
            t = el.text.strip()
            if 2 <= len(t) <= 30 and len(t.split()) <= 4 and t[0].isupper():
                candidates.append({"source": "structured", "text": t, "bbox": list(el.bbox)})

    if not candidates:
        return build_result(
            rule,
            "insufficient_evidence",
            measured={"allowedCtas": allowed, "candidates": 0},
            observation=(
                "No CTA field or short button-like text run could be identified, so the allowlist "
                "cannot be applied."
            ),
        )

    allowed_norm = {normalize_text(a).text.strip(): a for a in allowed}
    case_sensitive = bool(params.get("caseSensitive", False))
    if case_sensitive:
        allowed_norm = {normalize_text(a, lowercase=False).text.strip(): a for a in allowed}

    exact_field_candidates = [c for c in candidates if str(c["source"]).startswith("copyFields")]
    pool = exact_field_candidates or candidates
    violations: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []
    for c in pool:
        key = normalize_text(str(c["text"]), lowercase=not case_sensitive).text.strip()
        if key in allowed_norm:
            accepted.append({**c, "matched": allowed_norm[key]})
        elif exact_field_candidates:
            # Only assert a violation for an explicitly-labelled CTA field;
            # guessing that a random short heading is a CTA would be noise.
            violations.append(c)

    measured = {
        "candidates": candidates[:15],
        "accepted": accepted[:15],
        "violations": violations[:15],
        "usedExplicitField": bool(exact_field_candidates),
    }
    thresholds = {"allowedCtas": allowed, "caseSensitive": case_sensitive}

    if violations:
        first = violations[0]
        return build_result(
            rule,
            "fail",
            measured=measured,
            threshold=thresholds,
            quoted_text=str(first["text"])[:120],
            observation=(
                f"CTA {first['text']!r} is not on the allowlist ({', '.join(allowed[:5])}"
                f"{'...' if len(allowed) > 5 else ''})."
            ),
            suggested_fix=f"Use an approved CTA, e.g. {allowed[0]!r}.",
            confidence=0.95,
        )
    if not accepted:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measured,
            threshold=thresholds,
            observation="No labelled CTA field was present; short text runs were not assumed to be CTAs.",
        )
    return build_result(
        rule,
        "pass",
        measured=measured,
        threshold=thresholds,
        quoted_text=str(accepted[0]["text"])[:120],
        observation=f"{len(accepted)} CTA(s) match the allowlist.",
        confidence=0.95,
    )


__all__ = [
    "AhoCorasick",
    "Match",
    "NormalizedText",
    "asset_copy",
    "check_banned_terms",
    "check_claim_substantiation",
    "check_cta_allowlist",
    "check_disclaimer_present",
    "check_locale_spelling",
    "check_readability",
    "check_required_terms",
    "extract_claims",
    "fuzzy_find",
    "is_whole_word",
    "normalize_text",
    "readability_metrics",
]
