"""Brand-book ingestion: document -> *proposed* rules with citations.

Two non-negotiables.

**Every rule carries a citation.** page + bbox + the extracting model. A rule
whose provenance cannot be shown is a rule a customer cannot defend when their
agency disputes a finding, and the citation is what turns "the tool says so"
into "page 34 says so".

**Nothing is ever activated here.** `status` is hard-coded `proposed` and the
enum is not exposed to the model. Activation is the customer's act — it is what
makes the audit trail defensible, and it is also the onboarding moment where a
brand manager sees their own guidelines become machine-checkable, which is the
moment the product sells itself.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .config import Settings, get_settings
from .llm.base import LLMError, NullProvider
from .llm.factory import build_provider, canonical_provider
from .logging import get_logger
from .media import MediaError, resolve_uri
from .models import (
    DocumentChunk,
    ExtractedToken,
    ExtractedVoiceAttribute,
    ExtractRulesRequest,
    ExtractRulesResponse,
    RubricSpec,
    RuleCheckSpec,
    RuleCitation,
    RuleDefinition,
)
from .registry import registered_names
from .structured import parse_pdf, parse_pptx

log = get_logger(__name__)

_HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
_PANTONE = re.compile(r"\bPANTONE\s+([0-9]{2,4}\s*[A-Z]{0,2})\b", re.I)
_CMYK = re.compile(r"\bC\s*[:=]?\s*(\d{1,3})\s+M\s*[:=]?\s*(\d{1,3})\s+Y\s*[:=]?\s*(\d{1,3})\s+K\s*[:=]?\s*(\d{1,3})\b", re.I)
_SIZE_PT = re.compile(r"\b(\d{1,3}(?:\.\d)?)\s*(?:pt|point)s?\b", re.I)
_VOICE = re.compile(
    r"\bwe(?:'re| are)\s+([^.,;\n]{3,60})[,;]?\s*(?:but\s+)?(?:we(?:'re| are)\s+)?not\s+([^.,;\n]{3,60})",
    re.I,
)

_HEADING_HINTS = (
    "logo", "colour", "color", "typography", "type", "imagery", "photography",
    "voice", "tone", "clear space", "clearspace", "misuse", "do not", "don't",
    "accessibility", "layout", "grid", "spacing", "legal", "disclaimer",
)


@dataclass(slots=True)
class ExtractionOutcome:
    response: ExtractRulesResponse


def _looks_like_heading(text: str) -> bool:
    """Structural test, not a keyword test.

    Matching on topic words alone classified "Always maintain clear space of at
    least 0.5x the logomark height" — the actual rule — as a *heading*, so it
    was consumed as a section title and never reached the proposer. A heading is
    short, unpunctuated and cased; the keyword only breaks ties.
    """
    stripped = text.strip()
    if not (3 <= len(stripped) <= 60):
        return False
    if stripped.endswith((".", "!", "?", ";", ":", ",")) and not stripped.isupper():
        return False
    words = stripped.split()
    if len(words) > 8:
        return False
    if stripped.isupper():
        return True
    title_cased = all(w[:1].isupper() for w in words if w[:1].isalpha())
    return title_cased and any(hint in stripped.lower() for hint in _HEADING_HINTS)


def chunk_document(data: bytes, mime_type: str | None, max_pages: int) -> tuple[list[DocumentChunk], int, list[str]]:
    """Page-and-heading chunks with bboxes, so every rule can cite its source."""
    warnings: list[str] = []
    if data[:5] == b"%PDF-" or (mime_type or "").endswith("pdf"):
        doc = parse_pdf(data, max_pages=max_pages)
    elif data[:2] == b"PK" or "presentation" in (mime_type or ""):
        doc = parse_pptx(data, max_pages=max_pages)
    else:
        warnings.append(f"unsupported brand-book type {mime_type!r}; only PDF and PPTX are parsed")
        return [], 0, warnings

    warnings.extend(doc.warnings)
    chunks: list[DocumentChunk] = []
    for page in doc.pages:
        current_heading: str | None = None
        buffer: list[str] = []
        boxes: list[tuple[float, float, float, float]] = []
        ordinal = 0

        def _flush(heading: str | None, page_index: int = page.index) -> None:
            # `heading` is passed rather than closed over: the value in force at the
            # moment of the flush is what the chunk belongs to.
            nonlocal buffer, boxes, ordinal
            text = " ".join(buffer).strip()
            if text:
                bbox = (
                    [
                        round(min(b[0] for b in boxes), 5),
                        round(min(b[1] for b in boxes), 5),
                        round(max(b[2] for b in boxes), 5),
                        round(max(b[3] for b in boxes), 5),
                    ]
                    if boxes
                    else None
                )
                chunks.append(
                    DocumentChunk(
                        page=page_index + 1,
                        ordinal=ordinal,
                        heading=heading,
                        text=text[:4000],
                        bbox=bbox,
                    )
                )
                ordinal += 1
            buffer = []
            boxes = []

        # Larger-than-median type on a page is a heading in practice; using the
        # per-page median makes it robust across wildly different layouts.
        sizes = sorted(el.font_size_pt for el in page.text if el.font_size_pt > 0)
        median = sizes[len(sizes) // 2] if sizes else 0.0
        for el in page.text:
            text = el.text.strip()
            if not text:
                continue
            if (el.font_size_pt > median * 1.35 and len(text) < 80) or _looks_like_heading(text):
                _flush(current_heading)
                current_heading = text[:120]
                continue
            buffer.append(text)
            boxes.append(el.bbox)
        _flush(current_heading)

    page_count = int(doc.meta.get("page_count", len(doc.pages)) or len(doc.pages))
    return chunks, page_count, warnings


def extract_tokens(chunks: list[DocumentChunk]) -> list[ExtractedToken]:
    """Deterministic token harvesting. No model call — hex codes are unambiguous."""
    seen: set[str] = set()
    tokens: list[ExtractedToken] = []
    for chunk in chunks:
        for match in _HEX.finditer(chunk.text):
            hex_value = match.group(0).upper()
            if len(hex_value) == 4:
                hex_value = "#" + "".join(c * 2 for c in hex_value[1:])
            if hex_value in seen:
                continue
            seen.add(hex_value)
            tokens.append(
                ExtractedToken(
                    path=f"color.extracted.{len(tokens) + 1}",
                    type="color",
                    value={"page": chunk.page, "heading": chunk.heading},
                    hex=hex_value,
                )
            )
        for match in _PANTONE.finditer(chunk.text):
            key = f"PANTONE {match.group(1).strip()}"
            if key in seen:
                continue
            seen.add(key)
            tokens.append(
                ExtractedToken(path=f"color.pantone.{len(tokens) + 1}", type="spot-color", value=key)
            )
        for match in _CMYK.finditer(chunk.text):
            values = [int(g) for g in match.groups()]
            key = f"CMYK {values}"
            if key in seen:
                continue
            seen.add(key)
            tokens.append(ExtractedToken(path=f"color.cmyk.{len(tokens) + 1}", type="cmyk", value=values))
        if chunk.heading and any(h in chunk.heading.lower() for h in ("type", "typograph", "font")):
            for match in _SIZE_PT.finditer(chunk.text):
                key = f"size {match.group(1)}pt"
                if key in seen:
                    continue
                seen.add(key)
                tokens.append(
                    ExtractedToken(
                        path=f"typography.size.{len(tokens) + 1}",
                        type="dimension",
                        value={"pt": float(match.group(1)), "page": chunk.page},
                    )
                )
    return tokens


def extract_voice(chunks: list[DocumentChunk]) -> list[ExtractedVoiceAttribute]:
    """Harvest explicit "we are X, not Y" constructions — the canonical form
    brand books use, and the exact shape the judge's ontology needs."""
    out: list[ExtractedVoiceAttribute] = []
    seen: set[str] = set()
    for chunk in chunks:
        for match in _VOICE.finditer(chunk.text):
            we_are = match.group(1).strip().rstrip(".,;")
            we_are_not = match.group(2).strip().rstrip(".,;")
            key = we_are.lower()
            if key in seen or len(we_are) < 3:
                continue
            seen.add(key)
            out.append(
                ExtractedVoiceAttribute(
                    name=we_are.split()[0].capitalize(),
                    we_are=we_are,
                    we_are_not=we_are_not,
                )
            )
    return out[:20]


_RULE_SYSTEM = """You convert brand guideline prose into machine-checkable rules.

You will receive numbered excerpts from a brand book. For each excerpt that states an
enforceable rule, emit one rule object. Ignore prose that is aspirational, historical or
purely descriptive — "our blue evokes trust" is not a rule; "never place the logo on a
photographic background" is.

Return ONLY a JSON array:
[
  {
    "excerptIndex": <the number of the excerpt this comes from>,
    "key": "kebab-case-stable-identifier",
    "statement": "the rule in one imperative sentence",
    "rationale": "why the brand says it, if stated",
    "dimension": "logo|color|typography|layout|imagery|copy|accessibility|channel_spec|legal",
    "tier": "deterministic|cv|vlm|hybrid",
    "severity": "blocker|major|minor|advisory",
    "check": {"fn": "<one of the analyzer names below>", "params": {}},
    "rubric": {"question": "the closed question a reviewer would ask", "kind": "binary"}
  }
]

Choose `check.fn` ONLY from this list; if nothing fits, use "vlm.rule_adjudication":
%s

Rules for `params`: fill in numeric thresholds ONLY when the excerpt states them
explicitly (e.g. "minimum 24px" -> {"minHeightPx": 24}). Never invent a threshold —
an invented number becomes a false failure on a customer's asset.
"""


def _propose_rules_with_llm(
    chunks: list[DocumentChunk],
    request: ExtractRulesRequest,
    settings: Settings,
) -> tuple[list[RuleDefinition], float, list[str]]:
    warnings: list[str] = []
    provider = build_provider(canonical_provider(request.provider), request.model, settings)
    if isinstance(provider, NullProvider):
        return [], 0.0, [f"rule proposal skipped: {provider.reason}"]

    system = _RULE_SYSTEM % json.dumps(registered_names())
    rules: list[RuleDefinition] = []
    cost = 0.0
    batch_size = 12

    for start in range(0, len(chunks), batch_size):
        batch = chunks[start : start + batch_size]
        excerpts = "\n\n".join(
            f"[{start + i}] page {c.page}"
            + (f" — {c.heading}" if c.heading else "")
            + f"\n{c.text[:1200]}"
            for i, c in enumerate(batch)
        )
        try:
            completion = provider.complete(
                system=system,
                prompt=f"EXCERPTS FROM {request.document_name!r}:\n\n{excerpts}",
                temperature=0.0,
                max_tokens=4000,
            )
        except LLMError as exc:
            warnings.append(f"rule proposal failed for excerpts {start}-{start + len(batch)}: {exc}")
            continue
        cost += completion.cost_usd

        match = re.search(r"\[.*\]", completion.text or "", re.S)
        if not match:
            continue
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            warnings.append(f"unparsable rule JSON for excerpts {start}-{start + len(batch)}")
            continue

        for item in payload if isinstance(payload, list) else []:
            rule = _coerce_rule(item, batch, start, request)
            if rule is not None:
                rules.append(rule)

    # Stable de-duplication: the same rule often appears on several pages.
    unique: dict[str, RuleDefinition] = {}
    for rule in rules:
        unique.setdefault(rule.key, rule)
    return list(unique.values()), cost, warnings


def _coerce_rule(
    item: Any, batch: list[DocumentChunk], offset: int, request: ExtractRulesRequest
) -> RuleDefinition | None:
    if not isinstance(item, dict):
        return None
    statement = str(item.get("statement", "")).strip()
    key = str(item.get("key", "")).strip()
    if not statement or not key:
        return None

    fn = str((item.get("check") or {}).get("fn", "")).strip()
    if fn not in registered_names():
        fn = "vlm.rule_adjudication"
    params = (item.get("check") or {}).get("params")
    if not isinstance(params, dict):
        params = {}

    try:
        index = int(item.get("excerptIndex", offset)) - offset
    except (TypeError, ValueError):
        index = 0
    chunk = batch[index] if 0 <= index < len(batch) else (batch[0] if batch else None)

    dimension = str(item.get("dimension", "")).strip()
    if dimension not in (
        "logo", "color", "typography", "layout", "imagery", "copy",
        "accessibility", "channel_spec", "legal",
    ):
        dimension = fn.split(".")[0] if fn.split(".")[0] in ("logo", "color", "typography", "layout", "imagery", "copy") else "copy"

    tier = str(item.get("tier", "")).strip()
    if tier not in ("deterministic", "cv", "vlm", "hybrid"):
        tier = "vlm" if fn.startswith("vlm.") else "cv"
    severity = str(item.get("severity", "")).strip()
    if severity not in ("blocker", "major", "minor", "advisory"):
        severity = "major"

    rubric_raw = item.get("rubric") or {}
    rubric = None
    if isinstance(rubric_raw, dict) and rubric_raw.get("question"):
        rubric = RubricSpec(question=str(rubric_raw["question"])[:400], kind="binary")

    return RuleDefinition(
        key=key[:120],
        statement=statement[:600],
        rationale=str(item.get("rationale") or "")[:600] or None,
        dimension=dimension,  # type: ignore[arg-type]
        tier=tier,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        check=RuleCheckSpec(fn=fn, params=params),
        rubric=rubric,
        provenance="deductive",
        citation=RuleCitation(
            doc=request.document_name,
            page=chunk.page if chunk else None,
            bbox=tuple(chunk.bbox[:4]) if chunk and chunk.bbox and len(chunk.bbox) >= 4 else None,  # type: ignore[arg-type]
            extracted_by=f"{request.provider}:{request.model}",
        ),
        # Hard-coded, never model-supplied. Activation is the customer's act.
        status="proposed",
    )


def extract_rules(request: ExtractRulesRequest, settings: Settings | None = None) -> ExtractRulesResponse:
    s = settings or get_settings()
    warnings: list[str] = []

    try:
        data = resolve_uri(request.document_uri, timeout=s.engine_timeout_ms / 1000.0)
    except MediaError as exc:
        return ExtractRulesResponse(
            request_id=request.request_id,
            page_count=0,
            warnings=[f"brand book could not be read: {exc}"],
        )

    chunks, page_count, chunk_warnings = chunk_document(data, request.mime_type, request.max_pages)
    warnings.extend(chunk_warnings)
    if not chunks:
        return ExtractRulesResponse(
            request_id=request.request_id,
            page_count=page_count,
            warnings=warnings + ["no text chunks were extracted from the document"],
        )

    tokens = extract_tokens(chunks)
    voice = extract_voice(chunks)

    # Only excerpts that plausibly contain a rule go to the model. Sending 120
    # pages of a brand book verbatim is most of the cost and none of the value.
    candidates = [
        c
        for c in chunks
        if len(c.text) > 60
        and (
            (c.heading and any(h in c.heading.lower() for h in _HEADING_HINTS))
            or re.search(r"\b(must|never|always|do not|don't|minimum|maximum|at least|no less than|required)\b", c.text, re.I)
        )
    ]
    if not candidates:
        candidates = chunks[:40]
        warnings.append("no rule-bearing language detected; sent the first 40 chunks for proposal")

    rules, cost, llm_warnings = _propose_rules_with_llm(candidates[:120], request, s)
    warnings.extend(llm_warnings)

    # Defence in depth: whatever happened above, nothing leaves here activated.
    for rule in rules:
        rule.status = "proposed"

    return ExtractRulesResponse(
        request_id=request.request_id,
        rules=rules,
        tokens=tokens,
        voice_attributes=voice,
        chunks=chunks[:500],
        page_count=page_count,
        cost_usd=round(cost, 6),
        warnings=warnings,
    )


__all__ = ["chunk_document", "extract_rules", "extract_tokens", "extract_voice"]
