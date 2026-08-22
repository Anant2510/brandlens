"""The T2 judge.

Every design decision here exists to raise precision, because a brand-compliance
tool that cries wolf gets switched off:

* **One criterion per call.** Batched criteria contaminate each other — the
  model finds one violation and starts finding them everywhere.
* **Reasoning fields first.** The response schema is ordered
  observation -> evidence -> verdict -> severity -> confidence -> suggested_fix.
  Emitting the verdict first makes everything after it a rationalisation; making
  the model describe what it sees before it decides is the cheapest accuracy
  win available.
* **`not_applicable` and `insufficient_evidence` are always offered.** Without
  them the model must invent a verdict, and it will.
* **Measurements go in, questions come out.** The model is never asked to
  measure. It is told "dE2000 is 7.4 against a tolerance of 3.0" and asked
  whether the brand's stated exception applies.
* **Balanced precedents.** k/2 pass, k/2 fail. An unbalanced few-shot block
  leaks a label prior and the judge degenerates into a yes-machine.
* **Set-of-Mark grounding.** Numbered boxes come from our detector; the model
  references numbers. Any bbox it returns anyway is verified against a real
  detection and dropped if it does not overlap one.
* **Self-consistency with vote entropy.** k samples at T=0.7; the entropy of
  the vote is a free, well-calibrated confidence signal, far better than asking
  the model how sure it is.
* **Abstain, don't guess.** Below the confidence floor the verdict is
  `abstained`, which routes to a human instead of into the findings list.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .config import Settings, get_settings
from .llm.base import Completion, LLMError, LLMProvider
from .logging import get_logger
from .media import bbox_iou, draw_set_of_mark, encode_png, resize_max_edge
from .models import (
    EngineBrandContext,
    EngineJudgeConfig,
    EnginePrecedent,
    ModelTrace,
    RuleDefinition,
    Verdict,
    build_result,
)

log = get_logger(__name__)

VALID_VERDICTS: tuple[str, ...] = ("pass", "fail", "not_applicable", "insufficient_evidence")
VALID_SEVERITIES: tuple[str, ...] = ("blocker", "major", "minor", "advisory")

#: Hard cap. Beyond ~8 exemplars the marginal accuracy is negligible and the
#: prompt cost is not.
MAX_PRECEDENTS = 8

_JSON_OBJECT = re.compile(r"\{.*\}", re.S)


@dataclass(slots=True)
class JudgeSample:
    verdict: str
    severity: str | None
    confidence: float
    observation: str
    evidence: str
    suggested_fix: str | None
    mark_refs: list[int] = field(default_factory=list)
    bbox: list[float] | None = None
    raw: str = ""


@dataclass(slots=True)
class JudgeOutcome:
    verdict: Verdict
    severity: str | None
    confidence: float
    observation: str
    evidence: str
    suggested_fix: str | None
    bbox: tuple[float, float, float, float] | None
    vote_entropy: float
    samples: list[JudgeSample]
    cost_usd: float
    latency_ms: float
    prompt_hash: str
    temperature: float
    self_consistency_k: int
    error: str | None = None
    dropped_bbox: bool = False


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------
RESPONSE_CONTRACT = """Respond with ONE JSON object and nothing else. The key order below is required;
fill the reasoning keys before you commit to a verdict.

{
  "observation": "What you actually see in the image/text, described plainly. No verdict here.",
  "evidence": "The specific detail that decides this, citing mark numbers (e.g. 'mark 2') and the supplied measurements.",
  "verdict": "pass" | "fail" | "not_applicable" | "insufficient_evidence",
  "severity": "blocker" | "major" | "minor" | "advisory",
  "confidence": 0.0-1.0,
  "suggested_fix": "One concrete action, or null when the verdict is pass.",
  "mark_refs": [<numbers of the overlaid boxes you are referring to>]
}

Rules for the verdict:
- "not_applicable": the criterion does not apply to this asset at all.
- "insufficient_evidence": the crop, resolution or context does not let you decide. Use it freely;
  a wrong confident answer is far more damaging than an admitted uncertainty.
- Never invent a bounding box. Refer to the numbered marks. If nothing is marked, leave mark_refs empty.
- The measurements supplied to you were computed by instrumented code and are authoritative.
  Do not re-estimate them from the image; use them, and judge only what they cannot settle.
"""


def build_brand_ontology(brand: EngineBrandContext, max_items: int = 12) -> str:
    """The stable half of the prompt: who this brand is.

    Identical for every criterion on every asset for this brand, so it sits at
    the very front of the system block where every provider's prefix cache can
    reuse it.
    """
    lines: list[str] = [f"BRAND: {brand.name}"]
    if brand.positioning:
        lines.append(f"POSITIONING: {brand.positioning}")

    if brand.voice_attributes:
        lines.append("\nVOICE ATTRIBUTES:")
        for attr in brand.voice_attributes[:max_items]:
            lines.append(f"- {attr.name} (weight {attr.weight})")
            lines.append(f"    we are: {attr.we_are}")
            lines.append(f"    we are NOT: {attr.we_are_not}")
            if attr.positive_examples:
                lines.append(f"    sounds like: {' | '.join(attr.positive_examples[:3])}")
            if attr.negative_examples:
                lines.append(f"    does not sound like: {' | '.join(attr.negative_examples[:3])}")

    if brand.color_tokens:
        swatches = ", ".join(f"{t.path}={t.hex}" + (f" ({t.role})" if t.role else "") for t in brand.color_tokens[:max_items])
        lines.append(f"\nCOLOUR TOKENS: {swatches}")
    if brand.type_styles:
        styles = ", ".join(f"{s.name}={s.font_family} {int(s.font_weight)}" for s in brand.type_styles[:max_items])
        lines.append(f"TYPE STYLES: {styles}")
    if brand.lexicon:
        banned = [e.term for e in brand.lexicon if e.kind == "banned"][:max_items]
        if banned:
            lines.append(f"BANNED TERMS: {', '.join(banned)}")
    return "\n".join(lines)


def balance_precedents(
    precedents: list[EnginePrecedent], rule_key: str, k: int = 6
) -> list[EnginePrecedent]:
    """Take k/2 passes and k/2 fails, most similar first.

    Balance is not a nicety. With 6 pass exemplars and 0 fail exemplars the
    model's prior shifts hard toward "pass" and the criterion stops discriminating
    — the failure mode is silent, because the tool simply stops finding things.
    """
    k = max(0, min(k, MAX_PRECEDENTS))
    if k == 0 or not precedents:
        return []
    relevant = [p for p in precedents if p.rule_key == rule_key] or list(precedents)
    passes = sorted([p for p in relevant if p.verdict == "pass"], key=lambda p: -(p.similarity or 0.0))
    fails = sorted([p for p in relevant if p.verdict == "fail"], key=lambda p: -(p.similarity or 0.0))

    half = k // 2
    chosen = passes[:half] + fails[:half]
    # If one side is short, do NOT top up from the other: an unbalanced block is
    # worse than a smaller balanced one.
    limit = min(len(passes), len(fails), half)
    if limit < half:
        chosen = passes[:limit] + fails[:limit]
    # Interleave so the model does not see a run of one label.
    interleaved: list[EnginePrecedent] = []
    for i in range(limit):
        interleaved.append(passes[i])
        interleaved.append(fails[i])
    return interleaved or chosen


def format_precedents(precedents: list[EnginePrecedent]) -> str:
    if not precedents:
        return ""
    lines = ["\nPRECEDENTS — decisions this brand's reviewers already made on this criterion:"]
    for i, p in enumerate(precedents, start=1):
        lines.append(f"{i}. verdict={p.verdict}")
        if p.measured:
            lines.append(f"   measured: {json.dumps(p.measured, default=str)[:300]}")
        if p.rationale:
            lines.append(f"   reviewer said: {p.rationale[:300]}")
    lines.append("Apply the same standard. Do not assume the next answer follows the pattern above.")
    return "\n".join(lines)


def format_rubric(rule: RuleDefinition, question: str, pass_when: str | None, fail_when: str | None) -> str:
    lines = [
        "\nCRITERION",
        f"key: {rule.key}",
        f"statement: {rule.statement}",
    ]
    if rule.rationale:
        lines.append(f"why it exists: {rule.rationale}")
    lines.append(f"question: {question}")
    rubric = rule.rubric
    if rubric:
        lines.append(f"rubric kind: {rubric.kind}")
        if rubric.levels:
            lines.append("levels:")
            for level in rubric.levels:
                lines.append(f"  {level.value} = {level.label}: {level.anchor}")
        if rubric.pass_when:
            lines.append(f"pass when: {rubric.pass_when}")
        if rubric.fail_when:
            lines.append(f"fail when: {rubric.fail_when}")
    if pass_when:
        lines.append(f"pass when: {pass_when}")
    if fail_when:
        lines.append(f"fail when: {fail_when}")
    lines.append(f"default severity if failing: {rule.severity}")
    return "\n".join(lines)


def format_measurements(measurements: dict[str, Any]) -> str:
    if not measurements:
        return "MEASUREMENTS: none were computed for this criterion."
    return (
        "MEASUREMENTS (computed by instrumented code — authoritative, do not re-estimate):\n"
        + json.dumps(measurements, indent=2, default=str)[:4000]
    )


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------
def parse_sample(raw: str) -> JudgeSample | None:
    match = _JSON_OBJECT.search(raw or "")
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        # Models occasionally emit trailing prose after the object; retry on the
        # shortest balanced prefix rather than discarding a usable answer.
        text = match.group(0)
        for end in range(len(text), 1, -1):
            if text[end - 1] != "}":
                continue
            try:
                payload = json.loads(text[:end])
                break
            except json.JSONDecodeError:
                continue
        else:
            return None
    if not isinstance(payload, dict):
        return None

    verdict = str(payload.get("verdict", "")).strip().lower().replace("-", "_").replace(" ", "_")
    if verdict not in VALID_VERDICTS:
        return None
    severity = str(payload.get("severity", "")).strip().lower() or None
    if severity not in VALID_SEVERITIES:
        severity = None
    try:
        confidence = float(payload.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5

    refs: list[int] = []
    for r in payload.get("mark_refs") or []:
        try:
            refs.append(int(r))
        except (TypeError, ValueError):
            continue

    bbox = payload.get("bbox")
    bbox_list: list[float] | None = None
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
        try:
            bbox_list = [float(v) for v in bbox[:4]]
        except (TypeError, ValueError):
            bbox_list = None

    return JudgeSample(
        verdict=verdict,
        severity=severity,
        confidence=max(0.0, min(1.0, confidence)),
        observation=str(payload.get("observation", ""))[:2000],
        evidence=str(payload.get("evidence", ""))[:2000],
        suggested_fix=(str(payload["suggested_fix"])[:500] if payload.get("suggested_fix") else None),
        mark_refs=refs,
        bbox=bbox_list,
        raw=raw[:4000],
    )


def vote_entropy(verdicts: list[str]) -> float:
    """Normalized Shannon entropy of the vote. 0 = unanimous, 1 = maximal spread.

    The denominator is the maximum entropy *achievable with this many samples*,
    log(min(k, |verdicts|)) — not log(2). Normalising to the binary maximum
    would score a 4-of-5 majority almost as badly as a coin flip and the judge
    would abstain on votes that are, in fact, decisive.
    """
    if len(verdicts) <= 1:
        return 0.0
    counts = Counter(verdicts)
    total = len(verdicts)
    h = -sum((c / total) * math.log(c / total) for c in counts.values())
    max_h = math.log(min(total, len(VALID_VERDICTS)))
    return round(h / max_h, 4) if max_h > 0 else 0.0


# ---------------------------------------------------------------------------
# Judge
# ---------------------------------------------------------------------------
class Judge:
    """Holds the provider, the static prompt half and the cost meter."""

    def __init__(
        self,
        provider: LLMProvider,
        config: EngineJudgeConfig,
        brand: EngineBrandContext,
        precedents: list[EnginePrecedent] | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.provider = provider
        self.config = config
        self.brand = brand
        self.precedents = precedents or []
        self.settings = settings or get_settings()
        self.cost_usd = 0.0
        self.calls = 0
        self._ontology = build_brand_ontology(brand)

    # -- prompt halves -------------------------------------------------------
    def _system(self, rule: RuleDefinition, question: str, pass_when: str | None, fail_when: str | None) -> str:
        """Static half: role, ontology, rubric, exemplars, output contract.

        Order matters for cache hit rate — the least variable content goes
        first, so the shared prefix across criteria is as long as possible.
        """
        precedents = balance_precedents(
            self.precedents, rule.key, k=min(self.settings.judge_precedent_k, MAX_PRECEDENTS)
        )
        blocks = [
            "You are a brand-compliance reviewer. You judge one criterion at a time against "
            "measurements supplied by instrumented code. You are rigorous, literal and comfortable "
            "saying you cannot tell.",
            self._ontology,
            format_rubric(rule, question, pass_when, fail_when),
        ]
        if rule.rubric is None or rule.rubric.use_precedents:
            block = format_precedents(precedents)
            if block:
                blocks.append(block)
        blocks.append(RESPONSE_CONTRACT)
        return "\n\n".join(b for b in blocks if b)

    @staticmethod
    def _user(measurements: dict[str, Any], mark_labels: list[str], extra_context: str | None) -> str:
        parts: list[str] = []
        if mark_labels:
            parts.append(
                "The image has numbered boxes drawn on it by the detector:\n"
                + "\n".join(f"  {i + 1}. {label}" for i, label in enumerate(mark_labels))
                + "\nRefer to these numbers in `mark_refs`. Do not output coordinates."
            )
        parts.append(format_measurements(measurements))
        if extra_context:
            parts.append(extra_context)
        parts.append("Now answer for THIS asset, following the JSON contract exactly.")
        return "\n\n".join(parts)

    # -- sampling ------------------------------------------------------------
    def _sample_once(
        self, system: str, user: str, images: list[bytes], temperature: float
    ) -> tuple[JudgeSample | None, Completion | None, str | None]:
        try:
            if images and self.provider.supports_vision():
                completion = self.provider.complete_vision(
                    system=system,
                    prompt=user,
                    images=images,
                    temperature=temperature,
                    max_tokens=1200,
                    enable_cache=self.config.enable_prompt_cache,
                )
            else:
                completion = self.provider.complete(
                    system=system,
                    prompt=user,
                    temperature=temperature,
                    max_tokens=1200,
                    enable_cache=self.config.enable_prompt_cache,
                )
        except LLMError as exc:
            return None, None, str(exc)
        except Exception as exc:  # noqa: BLE001 - never let a provider bug 500 the run
            return None, None, f"unexpected provider error: {exc}"
        return parse_sample(completion.text), completion, None

    def evaluate(
        self,
        rule: RuleDefinition,
        question: str,
        measurements: dict[str, Any] | None = None,
        images: list[bytes] | None = None,
        mark_labels: list[str] | None = None,
        mark_boxes: list[tuple[float, float, float, float]] | None = None,
        pass_when: str | None = None,
        fail_when: str | None = None,
        extra_context: str | None = None,
        budget_remaining: float | None = None,
    ) -> JudgeOutcome:
        started = time.perf_counter()
        system = self._system(rule, question, pass_when, fail_when)
        user = self._user(measurements or {}, mark_labels or [], extra_context)
        prompt_hash = self.provider.prompt_hash(system, user)

        k = max(1, int(self.config.self_consistency_k))
        # Self-consistency needs spread. Sampling k>1 at T=0 returns k copies of
        # the same answer and an entropy of 0 that means nothing.
        temperature = self.config.temperature if k == 1 else max(self.config.temperature, self.settings.judge_sampling_temperature)

        samples: list[JudgeSample] = []
        cost = 0.0
        errors: list[str] = []

        for i in range(k):
            if budget_remaining is not None and cost >= budget_remaining:
                errors.append("cost ceiling reached mid-vote")
                break
            sample, completion, error = self._sample_once(system, user, images or [], temperature)
            if completion is not None:
                cost += completion.cost_usd
                self.cost_usd += completion.cost_usd
                self.calls += 1
            if error:
                errors.append(error)
                continue
            if sample is None:
                errors.append("model response was not parsable JSON")
                continue
            samples.append(sample)
            del i

        latency = round((time.perf_counter() - started) * 1000.0, 2)

        if not samples:
            return JudgeOutcome(
                verdict="insufficient_evidence",
                severity=rule.severity,
                confidence=0.0,
                observation=(
                    "The vision judge could not be consulted: " + "; ".join(errors[:3])
                    if errors
                    else "The vision judge returned no usable response."
                ),
                evidence="",
                suggested_fix=None,
                bbox=None,
                vote_entropy=0.0,
                samples=[],
                cost_usd=cost,
                latency_ms=latency,
                prompt_hash=prompt_hash,
                temperature=temperature,
                self_consistency_k=k,
                error="; ".join(errors[:3]) or "no samples",
            )

        # -- escalate a lone low-confidence sample ---------------------------
        if (
            len(samples) == 1
            and self.config.escalate_k > 1
            and samples[0].confidence < max(self.config.abstain_below_confidence + 0.15, 0.7)
            and (budget_remaining is None or cost < budget_remaining)
        ):
            escalate_temp = max(self.config.temperature, self.settings.judge_sampling_temperature)
            for _ in range(self.config.escalate_k - 1):
                if budget_remaining is not None and cost >= budget_remaining:
                    break
                sample, completion, error = self._sample_once(system, user, images or [], escalate_temp)
                if completion is not None:
                    cost += completion.cost_usd
                    self.cost_usd += completion.cost_usd
                    self.calls += 1
                if sample is not None:
                    samples.append(sample)
                elif error:
                    errors.append(error)
            k = len(samples)
            temperature = escalate_temp

        verdicts = [s.verdict for s in samples]
        counts = Counter(verdicts)
        majority, majority_count = counts.most_common(1)[0]
        entropy = vote_entropy(verdicts)
        agreement = majority_count / len(samples)

        majority_samples = [s for s in samples if s.verdict == majority]
        self_reported = sum(s.confidence for s in majority_samples) / len(majority_samples)
        if len(samples) > 1:
            # Vote agreement is the better-calibrated signal; the model's own
            # number is a useful but secondary tiebreak.
            confidence = round(0.65 * (1.0 - entropy) * agreement + 0.35 * self_reported, 4)
        else:
            confidence = round(self_reported, 4)

        chosen = max(majority_samples, key=lambda s: s.confidence)

        # -- Set-of-Mark grounding: validate any geometry the model returned --
        bbox: tuple[float, float, float, float] | None = None
        dropped = False
        if mark_boxes:
            for ref in chosen.mark_refs:
                if 1 <= ref <= len(mark_boxes):
                    bbox = mark_boxes[ref - 1]
                    break
        if bbox is None and chosen.bbox and len(chosen.bbox) >= 4:
            candidate = (
                float(min(chosen.bbox[0], chosen.bbox[2])),
                float(min(chosen.bbox[1], chosen.bbox[3])),
                float(max(chosen.bbox[0], chosen.bbox[2])),
                float(max(chosen.bbox[1], chosen.bbox[3])),
            )
            # A free-hand bbox is only trusted when it lands on something the
            # detector actually found. Otherwise it is a hallucinated location
            # and pointing a reviewer at it destroys trust faster than no box.
            if mark_boxes and any(bbox_iou(candidate, m) > 0.1 for m in mark_boxes):
                bbox = candidate
            else:
                dropped = True

        verdict: Verdict = majority  # type: ignore[assignment]
        if confidence < float(self.config.abstain_below_confidence) and majority in ("pass", "fail"):
            verdict = "abstained"

        return JudgeOutcome(
            verdict=verdict,
            severity=chosen.severity or rule.severity,
            confidence=confidence,
            observation=chosen.observation,
            evidence=chosen.evidence,
            suggested_fix=chosen.suggested_fix,
            bbox=bbox,
            vote_entropy=entropy,
            samples=samples,
            cost_usd=cost,
            latency_ms=latency,
            prompt_hash=prompt_hash,
            temperature=temperature,
            self_consistency_k=len(samples),
            error="; ".join(errors[:3]) or None,
            dropped_bbox=dropped,
        )


# ---------------------------------------------------------------------------
# Crop selection — send the smallest image that answers the question
# ---------------------------------------------------------------------------
def select_crop(ctx: Any, rule: RuleDefinition, crop_to: str) -> tuple[bytes | None, list[tuple[float, float, float, float]], list[str], str]:
    """Return (png bytes, mark boxes, mark labels, crop description).

    Sending a 4000px canvas to answer "is this logo clear of the edge" wastes
    tokens and *reduces* accuracy — the relevant detail shrinks to nothing after
    the provider's own downscale.
    """
    img = ctx.image()
    if img is None:
        return None, [], [], "none"

    boxes: list[tuple[float, float, float, float]] = []
    labels: list[str] = []
    region: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)
    description = "full canvas"

    if crop_to == "logo":
        from .logo import detect_all

        detections = detect_all(ctx, rule)
        if detections:
            best = max(detections, key=lambda d: d.score)
            pad = 0.6
            w, h = best.bbox[2] - best.bbox[0], best.bbox[3] - best.bbox[1]
            region = (
                max(0.0, best.bbox[0] - w * pad),
                max(0.0, best.bbox[1] - h * pad),
                min(1.0, best.bbox[2] + w * pad),
                min(1.0, best.bbox[3] + h * pad),
            )
            boxes = [d.bbox for d in detections]
            labels = [f"logo:{d.variant_name}" for d in detections]
            description = "logo region with clear-space margin"
    elif crop_to == "text":
        spans = ctx.text_spans()
        if spans:
            boxes = [s.bbox for s in spans[:12]]
            labels = [s.text[:24] for s in spans[:12]]
            region = (
                max(0.0, min(b[0] for b in boxes) - 0.03),
                max(0.0, min(b[1] for b in boxes) - 0.03),
                min(1.0, max(b[2] for b in boxes) + 0.03),
                min(1.0, max(b[3] for b in boxes) + 0.03),
            )
            description = "text region"
    elif crop_to == "region":
        from .layout import collect_elements

        elements, _source = collect_elements(ctx)
        boxes = [e.bbox for e in elements[:12]]
        labels = [f"{e.kind}:{e.label[:20]}" for e in elements[:12]]
        description = "full canvas with detected elements marked"

    if not boxes and crop_to == "full":
        from .layout import collect_elements

        elements, _source = collect_elements(ctx)
        boxes = [e.bbox for e in elements[:10]]
        labels = [f"{e.kind}:{e.label[:20]}" for e in elements[:10]]

    crop = img.crop_norm(region)
    if crop.size == 0:
        crop = img.rgb
        region = (0.0, 0.0, 1.0, 1.0)

    # Re-express the mark boxes in the crop's coordinate frame before drawing.
    rw = max(region[2] - region[0], 1e-6)
    rh = max(region[3] - region[1], 1e-6)
    local_boxes = [
        (
            (b[0] - region[0]) / rw,
            (b[1] - region[1]) / rh,
            (b[2] - region[0]) / rw,
            (b[3] - region[1]) / rh,
        )
        for b in boxes
    ]
    visible = [
        (lb, b, label)
        for lb, b, label in zip(local_boxes, boxes, labels, strict=False)
        if lb[2] > 0 and lb[3] > 0 and lb[0] < 1 and lb[1] < 1
    ]
    local_boxes = [v[0] for v in visible]
    boxes = [v[1] for v in visible]
    labels = [v[2] for v in visible]

    marked = draw_set_of_mark(crop, local_boxes) if local_boxes else crop
    max_edge = int(ctx.judge_config.max_image_edge or 1568)
    return encode_png(resize_max_edge(marked, max_edge)), boxes, labels, description


# ---------------------------------------------------------------------------
# The vlm.* analyzers
# ---------------------------------------------------------------------------
def _judge_or_degrade(
    ctx: Any,
    rule: RuleDefinition,
    question: str,
    measurements: dict[str, Any],
    crop_to: str = "full",
    pass_when: str | None = None,
    fail_when: str | None = None,
    extra_context: str | None = None,
    require_image: bool = True,
) -> Any:
    judge = ctx.judge()
    if judge is None:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measurements,
            observation=(
                "This criterion requires the T2 vision judge, which is not available "
                f"({ctx.judge_unavailable_reason or 'no provider configured'})."
            ),
        )
    if ctx.deterministic_only:
        return build_result(
            rule,
            "insufficient_evidence",
            measured=measurements,
            observation=(
                "T2 was skipped for this run (deterministic-only mode or budget degradation), "
                "so this criterion was not judged."
            ),
        )

    image_bytes: bytes | None = None
    boxes: list[tuple[float, float, float, float]] = []
    labels: list[str] = []
    crop_desc = "none"
    if require_image:
        image_bytes, boxes, labels, crop_desc = select_crop(ctx, rule, crop_to)
        if image_bytes is None:
            return build_result(
                rule,
                "insufficient_evidence",
                measured=measurements,
                observation="This criterion needs an image and the asset could not be rasterised.",
            )

    outcome = judge.evaluate(
        rule=rule,
        question=question,
        measurements={**measurements, "cropSentToModel": crop_desc},
        images=[image_bytes] if image_bytes else [],
        mark_labels=labels,
        mark_boxes=boxes,
        pass_when=pass_when,
        fail_when=fail_when,
        extra_context=extra_context,
        budget_remaining=ctx.budget_remaining(),
    )
    ctx.spend(outcome.cost_usd)

    observation = outcome.observation
    if outcome.verdict == "abstained":
        observation = (
            f"Abstained below the {judge.config.abstain_below_confidence} confidence floor "
            f"(vote entropy {outcome.vote_entropy} over {outcome.self_consistency_k} samples). "
            f"Model observed: {outcome.observation}"
        )
    if outcome.dropped_bbox:
        ctx.warn(f"{rule.key}: judge returned a bounding box that matched no detected element; dropped it")

    return build_result(
        rule,
        outcome.verdict,
        severity=outcome.severity if outcome.severity in VALID_SEVERITIES else None,  # type: ignore[arg-type]
        measured={**measurements, "judgeEvidence": outcome.evidence},
        threshold={
            "abstainBelowConfidence": judge.config.abstain_below_confidence,
            "selfConsistencyK": outcome.self_consistency_k,
        },
        bbox=outcome.bbox,
        observation=observation,
        confidence=outcome.confidence,
        suggested_fix=outcome.suggested_fix,
        model=ModelTrace(
            provider=judge.provider.name,
            id=judge.provider.model,
            prompt_hash=outcome.prompt_hash,
            temperature=outcome.temperature,
            self_consistency_k=outcome.self_consistency_k,
            vote_entropy=outcome.vote_entropy,
        ),
        cost_usd=outcome.cost_usd,
        latency_ms=outcome.latency_ms,
        error=outcome.error,
    )


def check_voice_tone(ctx: Any, rule: RuleDefinition) -> Any:
    from .copy_checks import asset_copy, readability_metrics

    text, source = asset_copy(ctx)
    if not text.strip():
        return build_result(
            rule,
            "insufficient_evidence",
            observation="Voice and tone need copy, and none was available from fields, structure or OCR.",
            measured={"copySource": source},
        )
    metrics, _degraded = readability_metrics(text)
    attributes = [
        {"name": a.name, "weAre": a.we_are, "weAreNot": a.we_are_not, "weight": a.weight}
        for a in ctx.brand.voice_attributes
    ]
    if not attributes:
        return build_result(
            rule,
            "not_applicable",
            observation="No voice attributes are defined for this brand.",
            measured={"voiceAttributes": 0},
        )
    return _judge_or_degrade(
        ctx,
        rule,
        question=(
            "Does this copy match the brand's voice attributes? Judge each attribute against its "
            "'we are' / 'we are NOT' definition, then give one overall verdict."
        ),
        measurements={
            "copySource": source,
            "wordCount": metrics.get("words"),
            "readingEase": metrics.get("fleschReadingEase"),
            "gradeLevel": metrics.get("fleschKincaidGrade"),
            "voiceAttributes": attributes,
        },
        extra_context=f"COPY UNDER REVIEW:\n---\n{text[:6000]}\n---",
        require_image=False,
        fail_when="the copy reads as one of the 'we are NOT' descriptions on any weighted attribute",
    )


def check_mood(ctx: Any, rule: RuleDefinition) -> Any:
    from .imagery import extract_style_features

    img = ctx.image()
    measurements: dict[str, Any] = {"targetMood": rule.check.params.get("mood") or rule.statement}
    if img is not None:
        features = extract_style_features(img.rgb)
        measurements["styleFeatures"] = features.as_dict()
        measurements["note"] = (
            "Lightness, chroma and warmth are measured; the *reading* of them as a mood is your job."
        )
    return _judge_or_degrade(
        ctx,
        rule,
        question="Does the overall mood of this asset match the brand's intended mood?",
        measurements=measurements,
        crop_to=rule.rubric.crop_to if rule.rubric else "full",
        fail_when="the asset's mood contradicts the brand's stated intent",
    )


def check_subject_appropriateness(ctx: Any, rule: RuleDefinition) -> Any:
    params = rule.check.params
    return _judge_or_degrade(
        ctx,
        rule,
        question=(
            "Is the subject matter appropriate for this brand, market and channel? "
            "Consider cultural context for the stated market."
        ),
        measurements={
            "market": ctx.asset.market,
            "channel": ctx.asset.channel,
            "locale": ctx.asset.locale,
            "prohibitedSubjects": params.get("prohibitedSubjects")
            or (ctx.brand.image_style_profile.prohibited_subjects if ctx.brand.image_style_profile else None),
            "sensitivities": params.get("sensitivities"),
        },
        crop_to=rule.rubric.crop_to if rule.rubric else "full",
        fail_when="the subject is inappropriate for the stated market, channel or brand positioning",
    )


def check_rubric(ctx: Any, rule: RuleDefinition) -> Any:
    """The generic judge: ask THIS rule's own rubric.

    WHY THIS EXISTS
    ---------------
    Every other `vlm.*` analyzer hardcodes its question — voice_tone asks about
    voice, mood asks about mood. That means a semantic rule a brand actually
    wants ("the headline must be about the snowboarding experience", "the
    people in the hero must be centrally positioned") could not be written at
    all without shipping a new engine. The alternative was to smuggle such a
    rule through `vlm.mood`, which would put a rule about composition under a
    check named for atmosphere — a label that is confidently wrong, and the
    exact failure this codebase keeps finding.

    So: the rubric IS the criterion. The rule supplies the question, the pass
    and fail conditions, the ordinal anchors if it has them, and the crop.

    WHAT KEEPS IT FROM BECOMING THE VIBES ANALYZER
    ----------------------------------------------
    A judge with no measurements is a judge estimating, and this engine's whole
    position is that models judge but do not measure. So every rubric call is
    handed the geometry that is cheap and always available: the canvas, and for
    each element the crop already marks, its centre and its distance from the
    canvas centre — computed here, in code.

    That turns "is the subject centrally positioned" from a visual guess into a
    question anchored to numbers the judge can be held to, and it is why the
    marked-up crop and the measurement block have to describe the SAME
    elements. `select_crop` numbers them; this function measures the numbered
    ones; the model answers by referring to a number.
    """
    rubric = rule.rubric
    if rubric is None or not rubric.question.strip():
        # Not `not_applicable`: that means "this rule does not apply to this
        # asset", which is a statement about the asset. This is a malformed
        # rule, and saying so is the only way anybody finds out — a rubric-less
        # rule that quietly asked "is this good?" would return verdicts nobody
        # could trace to a question.
        return build_result(
            rule,
            "insufficient_evidence",
            observation=(
                f"{rule.key} uses vlm.rubric but carries no rubric question, so there is nothing to "
                "adjudicate. Add a rubric with a question, or point the rule at a specific analyzer."
            ),
            measured={"hasRubric": rubric is not None},
        )

    params = rule.check.params
    # A copy rubric must not fail because the asset would not rasterise. The
    # default follows the crop: `text` means the question is about words.
    require_image = bool(params.get("requireImage", rubric.crop_to != "text"))

    measurements: dict[str, Any] = {"rubricKind": rubric.kind}
    img = ctx.image()
    # Geometry only when the picture itself is going: a question about wording
    # gets no image, and shipping twelve element boxes alongside it would burn
    # tokens describing a canvas the judge was never shown.
    if img is not None and require_image:
        measurements["canvas"] = {
            "width": img.width,
            "height": img.height,
            "aspectRatio": round(img.width / max(img.height, 1), 4),
        }
        measurements["elements"] = _element_geometry(ctx, rule)

    if bool(params.get("includeCopy", rubric.crop_to == "text")):
        from .copy_checks import asset_copy

        text, source = asset_copy(ctx)
        if text.strip():
            measurements["copySource"] = source
            measurements["copy"] = text[: int(params.get("maxCopyChars", 4000))]

    return _judge_or_degrade(
        ctx,
        rule,
        question=rubric.question,
        measurements=measurements,
        crop_to=rubric.crop_to,
        pass_when=rubric.pass_when,
        fail_when=rubric.fail_when,
        require_image=require_image,
    )


def _element_geometry(ctx: Any, rule: RuleDefinition) -> list[dict[str, Any]]:
    """Where each detected element sits, measured rather than estimated.

    The `mark` number matches the number drawn on the crop, so the judge can
    answer "element 2 sits at 0.78 across" instead of "it looks off to the
    right" — and its bbox reference resolves to a real region rather than a
    hallucinated rectangle.

    `offsetFromCenter` is the euclidean distance from the canvas centre in
    normalised units: 0 is dead centre, ~0.71 is a corner. A composition rule
    can then be written against a number instead of an impression.
    """
    from .layout import collect_elements

    elements, _source = collect_elements(ctx)
    out: list[dict[str, Any]] = []
    for index, element in enumerate(elements[:12], start=1):
        # `float()` rather than the raw value: element boxes can arrive as numpy
        # scalars from the CV path, and a measurement dict that is half numpy
        # and half Python serialises inconsistently and reads as noise in logs.
        cx = float(element.bbox[0] + element.bbox[2]) / 2
        cy = float(element.bbox[1] + element.bbox[3]) / 2
        out.append(
            {
                "mark": index,
                "kind": element.kind,
                "label": element.label[:40],
                "bbox": [round(float(v), 4) for v in element.bbox],
                "center": [round(cx, 4), round(cy, 4)],
                "offsetFromCenter": round(math.hypot(cx - 0.5, cy - 0.5), 4),
                "areaFrac": round(
                    float(max(0.0, element.bbox[2] - element.bbox[0]))
                    * float(max(0.0, element.bbox[3] - element.bbox[1])),
                    4,
                ),
            }
        )
    return out


def check_overall_judgment(ctx: Any, rule: RuleDefinition) -> Any:
    """A holistic read, informed by everything already measured.

    Runs last so the deterministic and CV findings can be handed over. It is
    explicitly NOT the score — the headline number is deterministic aggregation
    in the control plane. This is a qualitative safety net for the failure a
    rule list does not encode.
    """
    prior = ctx.results_so_far()
    summary = [
        {
            "ruleKey": r.rule_key,
            "dimension": r.dimension,
            "verdict": r.verdict,
            "severity": r.severity,
            "observation": (r.evidence.observation or "")[:200],
        }
        for r in prior
        if r.verdict in ("fail", "abstained")
    ][:20]
    return _judge_or_degrade(
        ctx,
        rule,
        question=(
            "Taking the already-measured findings into account, would a brand guardian sign this asset off? "
            "Flag anything materially wrong that the itemised checks did not catch."
        ),
        measurements={
            "priorFindings": summary,
            "priorFindingCount": len(summary),
            "criteriaEvaluated": len(prior),
        },
        crop_to="full",
        fail_when="there is a material brand problem a guardian would refuse to sign off",
    )


def check_rule_adjudication(ctx: Any, rule: RuleDefinition) -> Any:
    """Hybrid tier: T1 measured, T2 decides whether an exception applies.

    The pattern for rules with legitimate documented exceptions — "the logo may
    sit closer to the edge on a co-branded lockup". Code produces the number;
    the model decides only whether the exception is in play. It is never asked
    to remeasure.
    """
    params = rule.check.params
    measured_fn = str(params.get("measuredBy") or "")
    measurements: dict[str, Any] = dict(params.get("measurements") or {})

    if measured_fn:
        from .registry import get_analyzer

        analyzer = get_analyzer(measured_fn)
        if analyzer is None:
            ctx.warn(f"{rule.key}: measuredBy={measured_fn!r} is not a registered analyzer")
        else:
            inner_rule = rule.model_copy(deep=True)
            inner_rule.check.fn = measured_fn
            inner_rule.check.params = dict(params.get("measureParams") or {})
            inner = analyzer(ctx, inner_rule)
            measurements["measuredBy"] = measured_fn
            measurements["measuredVerdict"] = inner.verdict
            measurements["measured"] = inner.evidence.measured
            measurements["threshold"] = inner.evidence.threshold
            measurements["measuredObservation"] = inner.evidence.observation
            # A clean pass needs no adjudication; spending a VLM call to confirm
            # a passing measurement is pure cost.
            if inner.verdict == "pass" and not params.get("adjudicatePasses", False):
                return inner

    return _judge_or_degrade(
        ctx,
        rule,
        question=(
            "The measurement below is authoritative. Decide only whether a documented brand exception "
            "applies that makes this acceptable despite the measurement."
        ),
        measurements=measurements,
        crop_to=rule.rubric.crop_to if rule.rubric else "full",
        pass_when="a documented exception applies and the asset is acceptable as-is",
        fail_when="no exception applies and the measurement stands as a violation",
    )


__all__ = [
    "MAX_PRECEDENTS",
    "VALID_SEVERITIES",
    "VALID_VERDICTS",
    "Judge",
    "JudgeOutcome",
    "JudgeSample",
    "balance_precedents",
    "check_rubric",
    "build_brand_ontology",
    "check_mood",
    "check_overall_judgment",
    "check_rule_adjudication",
    "check_subject_appropriateness",
    "check_voice_tone",
    "format_measurements",
    "format_precedents",
    "format_rubric",
    "parse_sample",
    "select_crop",
    "vote_entropy",
]
