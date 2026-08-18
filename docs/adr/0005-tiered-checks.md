# 0005 — Tiered checks: T0 → T1 → T2, never VLM-first

**Status** Accepted · **Date** 2026-02-14 · **Deciders** Platform, Product

## Context

The tempting architecture for a brand-compliance product in 2026 is: hand the
asset and the brand guidelines to a vision model, ask "does this comply", parse
the JSON. It is a weekend to build and it demos well.

It is also wrong in four separate ways, and every one of them shows up in
production rather than in the demo.

**Precision.** A VLM asked "is the logo at least 120px wide" answers with a
guess. It cannot count pixels. On a forty-criterion ruleset with 85% per-check
precision, the probability that a compliant asset passes cleanly is
`0.85^40 ≈ 0.1%`. Every asset gets flagged. Reviewers stop reading.

**Cost.** Forty vision calls per asset at \$0.015 each is \$0.60. An agency
running 5 000 variants a month spends \$3 000 on a check nobody trusts.

**Auditability.** "The model said the clear space looked tight" is not a
finding a brand manager can act on or a regulator can accept. "Measured 0.41X
against a required 1.35X, brand book page 11" is.

**Determinism.** Two identical calls to a VLM produce different answers. A
compliance verdict that changes between runs is not a compliance verdict.

Meanwhile, most brand rules are not semantic at all. Font names, term matching,
contrast ratios, claim expiry dates, aspect ratios, file sizes, safe-zone
geometry — all of it is parsing and arithmetic.

## Decision

**Three tiers, executed in strict order, with the model used last and least.**

| Tier | What it is | Cost | Precision |
|---|---|---|---|
| **T0** deterministic | Parse + arithmetic over structured sources and OCR spans | ~$0 | ~100% given correct extraction |
| **T1** CV | ΔE clustering, logo kNN, geometry, style-manifold distance | ~$0.001 | 90-97% |
| **T2** VLM | One rubric leaf, smallest crop, precedent-conditioned | $0.005-0.05 | 70-90% |
| **hybrid** | T1 measures, T2 adjudicates the measurement | T2 | between |

Enforcement mechanisms, in the code rather than in the guidance:

- `TIER_ORDER = ("deterministic", "cv", "hybrid", "vlm")` in
  `registry.py`. `vlm.overall_judgment` runs last so it can see everything
  already decided.
- `ANALYZER_TIERS` records the tier an analyzer *actually* runs at, and
  `effective_tier()` returns the stricter of that and the tier the rule
  declares. A rule mislabelled `cv` cannot smuggle a paid VLM call past the
  budget guard.
- **Code measures, the model only judges.** Every T2 prompt is given the
  measured numbers T1 produced. The model is never asked to estimate a quantity.
- **The rubric is binary wherever the criterion allows it.** LLMs are poorly
  calibrated on continuous scales. Ordinal rubrics require a fully labelled
  anchor on every level, because unlabelled or asymmetric anchors bias
  responses.
- **`not_applicable` and `insufficient_evidence` are mandatory verdicts.**
  Without them the model fabricates.
- **The judge sees the smallest crop that answers the question** (`cropTo:
  full | logo | text | region`), which cuts both cost and distraction.

## Consequences

**Good**

- A forty-criterion run costs roughly \$0.03–\$0.10 instead of \$0.60–\$2.00,
  and the 85% of criteria that are arithmetic are *right* rather than probably
  right.
- Findings carry measured values and thresholds, so they are actionable and
  auditable.
- `deterministicOnly: true` gives an agent a free, instant, fully deterministic
  check in its inner loop — with the paid semantic pass reserved for the final
  candidate.
- Budget exhaustion degrades gracefully: remaining T2 criteria return
  `insufficient_evidence` with an explanation and the run is flagged
  `degraded`. A partial answer with an honest gap beats an error, and beats a
  fabricated pass by a much wider margin.
- Adding a rule needs no engine deploy, because analyzers are looked up by name
  from `rule.check.fn`.

**Costs**

- Far more code. Thirty-eight analyzers exist because thirty-eight things are
  measurable, and each one has to be written, tested and maintained.
- T0 depends entirely on extraction quality. `source_fidelity` distinguishes
  `structured` (PDF/Figma/PPTX/HTML — exact fonts, sizes, colours, boxes) from
  `raster` (flattened, everything is inference). A raster asset gets weaker T0
  coverage, and the product has to be honest about that rather than pretending
  otherwise.
- Rule authors must choose a tier, and getting it wrong is a real error mode.
  `effective_tier()` limits the blast radius to "runs at a higher tier than
  intended", never lower.
- The demo is less magical. "We measured the clear space at 0.41X" impresses a
  brand manager and underwhelms a room expecting AI.

## Alternatives

**VLM-first, deterministic checks as a post-filter.** Rejected on all four
grounds above. The cost and precision arithmetic is not close.

**Deterministic only, no model at all.** Cheap, fast, perfectly auditable — and
unable to answer "does this photograph feel like our brand" or "is this
headline arrogant", which are the questions that make a brand manager care.
Rejected as insufficient. A tenant that wants it can set
`deterministicOnly: true` on every check.

**A trained classifier per rule.** Better precision than a VLM on rules with
enough labelled data. Rejected: no tenant has that data at onboarding, it needs
GPUs and a training pipeline, and each new customer becomes a training job.
Precedent retrieval gets much of the benefit with none of the machinery.

**Two tiers, folding CV into deterministic.** Rejected: the distinction is
operationally load-bearing. T0 is exact given correct extraction; T1 is
statistical and has a failure mode. Merging them would mean reporting a
palette-cluster estimate with the same confidence as a parsed font name.
