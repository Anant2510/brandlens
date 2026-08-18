# 0006 — Deterministic score aggregation; VLM judges rank but cannot score

**Status** Accepted · **Date** 2026-02-14 · **Deciders** Platform, Product

## Context

Every check run needs a headline number. A brand manager wants to know whether
this asset is fine, borderline or broken, without reading forty criteria.

The obvious implementation is to ask the vision model: "rate this asset's brand
compliance from 0 to 100". It is one call and it returns a number.

That number is not usable, for reasons that are consistent and well documented
in the LLM-as-judge literature:

- **It is not stable.** Identical calls at temperature 0 move by several points.
  A compliance score that changes between runs is not a compliance score.
- **It correlates with the wrong thing.** Model scores track aesthetic quality
  and image polish far more than they track rule conformance. A beautiful asset
  with the wrong logo scores well.
- **It is not explainable.** "78" cannot be decomposed. A reviewer who disagrees
  has nothing to argue with.
- **It is not comparable.** Scores drift between model versions, so a
  time-series of compliance is measuring the model, not the brand.
- **It clusters.** Judges pile answers on round numbers and avoid the extremes,
  so the effective resolution is far lower than the scale suggests.

The same models are, however, *good at ranking*. "Which of these two is more
on-brand" and "does this satisfy criterion X, yes or no" are questions they
answer reliably.

## Decision

**The headline score is deterministic arithmetic over atomic criteria. No model
output is ever a score.**

```
severity weight   blocker 4 · major 3 · minor 1 · advisory 0

per criterion     contribution = max(0, rule.weight) × severityWeight[severity]
                  only pass and fail participate

per dimension     score = 100 × earned / possible

headline          weighted mean of the DIMENSION scores,
                  using ruleset.scoringConfig.dimensionWeights

band              hasBlocker  -> fail
                  >= 85       -> pass
                  >= 70       -> conditional
                  else        -> fail
```

Models contribute **binary or small-ordinal leaves** — `pass`, `fail`,
`not_applicable`, `insufficient_evidence`, `abstained` — and arithmetic turns
those leaves into the number.

Where relative judgment is genuinely wanted, it is expressed as a **rank, not a
score**: `predictions.percentile_vs_corpus` ranks a candidate against the
tenant's own past assets and is reported with an explicit confidence interval,
never as a bare number.

Four details in `apps/api/src/scoring/scoring.ts` that carry weight:

- **`advisory` weighs 0.** An advisory must never move the number. The moment a
  false-positive advisory costs a customer a point, they stop trusting the
  score and start arguing with it. Advisories still raise findings.
- **`not_applicable` and abstentions are excluded from the denominator.**
  Scoring them as passes inflates; as failures it punishes the customer for our
  uncertainty.
- **Aggregation is per dimension first.** Otherwise a dimension with fifty
  typographic leaves drowns out one with three legal ones.
- **A failed blocker forces `fail` at score 99.** "Everything is perfect except
  the mandatory legal disclaimer is missing" is not a conditional pass in any
  jurisdiction that matters. Severity is a gate, not a weight — a blocker is
  recorded even when its rule weight is zero.

The module has **no framework imports**, so the worker shares it with the API.
A score computed in the queue must equal the score computed inline, or the same
asset gets two different answers depending on which process happened to run it.

## Consequences

**Good**

- Reproducible. The same criteria always produce the same number, so a
  compliance trend measures the brand rather than the model.
- Explainable. "83 because typography is 100, colour is 60 and colour is
  weighted 1.0" is a sentence a reviewer can act on.
- Auditable. The arithmetic is in version control and can be recomputed from
  the stored traces by anyone, years later.
- Tunable per tenant. `dimensionWeights` lives in the published ruleset, so a
  pharma customer weighting `legal` at 3.0 gets a different — and defensible —
  number from the same criteria.
- Free. No model call for the score at all.

**Costs**

- The weights are a judgement call. `blocker 4 / major 3 / minor 1 / advisory 0`
  is defensible but not derived from anything; a customer can reasonably want
  different numbers, and today that means changing `SEVERITY_WEIGHT`.
- Arithmetic cannot express interactions. "Slightly off-palette *and* slightly
  small logo" is worse than the sum of the two, and the score does not know
  that.
- Score quality is bounded by criterion quality. A ruleset that omits the rules
  a brand actually cares about produces a confident, meaningless 95.
- A number computed from criteria the customer has not curated can be worse
  than no number. This is the strongest argument for
  [ADR-0008](0008-rules-land-as-proposed.md).

## Alternatives

**Ask the model for a score.** One call, no weights to argue about. Rejected on
every ground above.

**Model score blended with the deterministic score.** Rejected: it inherits the
instability and destroys reproducibility, in exchange for a number that is
harder to explain than either input.

**Learned weights fitted to human approve/reject decisions.** Genuinely
appealing, and a plausible future. Rejected for now: it needs hundreds of
labelled runs per tenant, and the weights would then drift as reviewers change,
making historical scores incomparable. The learning loop currently spends its
labels on per-rule calibration, where they buy more.

**Pass/fail only, no number.** Honest and defensible. Rejected on product
grounds: buyers want to see improvement over time and to compare agencies, and
a binary cannot show a trend.
