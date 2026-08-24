# BrandLens Analysis Engine

The measurement and judgment half of BrandLens. The TypeScript control plane
(NestJS) owns orchestration, tenancy, persistence and the audit trail; this
service owns *deciding whether an asset is on-brand, and proving it with
numbers*.

It is **stateless**. Every request carries the brand ontology, the ruleset, the
precedents and the asset reference it needs, so the engine can be restarted,
scaled out or moved onto a GPU box with no coordination.

---

## The two rules that govern everything

**1. Prefer structured sources over pixels.** If the asset describes itself —
PDF, PPTX, Figma JSON, HTML — read the exact font, size, colour and bbox from
it. OCR guesses "Helvetica, about 11pt"; a PDF font descriptor *states*
`ABCDEF+HelveticaNeue-Bold, 10.5pt, fill #1A1A1A` at an exact rectangle. Both
pipelines converge on one `CriterionResult` schema, so a finding reads
identically whichever path produced it, and `evidence.measured.source` says
which one did.

**2. Feed measurements into the VLM; never ask the VLM to measure.** ΔE values,
contrast ratios, pixel margins and detected bounding boxes go *into* the prompt
as numbers. The model is never asked "is this logo too small" — it is told "the
logomark is 41px against a 64px minimum" and asked whether the brand's
documented exception applies.

---

## Tiered checks — never lead with a VLM

| Tier | Name | Cost | What it does |
|------|------|------|--------------|
| **T0** | `deterministic` | ~$0 | Channel-spec conformance, WCAG contrast maths, banned/required terms, disclaimer presence + size + contrast + proximity, readability, font names from structured source, dimensions/filesize/aspect. |
| **T1** | `cv` | ~$0 | Lab k-means palette + **CIEDE2000** ΔE against brand tokens, logo detection (SIFT/ORB + RANSAC homography, NCC fallback), clear-space annulus, distortion via homography decomposition, layout geometry, safe zones, grid residuals, pHash, image style features. |
| **T2** | `vlm` | $$ | Voice and tone, mood, subject appropriateness, contextual exceptions. |
| — | `hybrid` | $ | T1 measures, T2 adjudicates the measurement. |

Execution is strictly `deterministic -> cv -> hybrid -> vlm`. Cheap certainties
are banked first; the model runs last, on the smallest crop, one criterion at a
time, and only for what genuinely needs a semantic read.
`vlm.overall_judgment` is scheduled dead last so it can see everything the
itemised checks already found.

---

## The T2 judge

Every design decision in `judge.py` exists to raise precision, because a
compliance tool that cries wolf gets switched off.

- **One criterion per call.** Batched criteria contaminate each other.
- **Reasoning fields first**: `observation -> evidence -> verdict -> severity ->
  confidence -> suggested_fix`. Emitting the verdict first makes everything
  after it a rationalisation.
- **`not_applicable` and `insufficient_evidence` are always offered.** Without
  them the model must invent a verdict, and it will.
- **Balanced precedents**, k/2 pass and k/2 fail, capped at 8. An unbalanced
  few-shot block leaks a label prior and the judge degenerates into a
  yes-machine. If one side is short we shrink the block rather than top up from
  the other.
- **Set-of-Mark grounding.** Numbered boxes come from *our* detector; the model
  references numbers. Any bbox it emits anyway is checked against a real
  detection and dropped if it overlaps nothing — pointing a reviewer at a
  hallucinated rectangle destroys trust faster than no rectangle at all.
- **Self-consistency with vote entropy.** k samples at T=0.7 (sampling at T=0
  returns k identical answers and a meaningless entropy of 0), majority vote,
  and the normalised entropy of that vote is the confidence signal. It is far
  better calibrated than asking the model how sure it is.
- **Abstain, don't guess.** Below `abstainBelowConfidence` the verdict becomes
  `abstained`, which routes to a human instead of into the findings list.
- **Cache-friendly prompt order**: `[static system + brand ontology + rubric +
  exemplars]` then `[variable asset]`. With k=5 and a 4k-token ontology, cache
  hits are the difference between a viable per-asset cost and an unusable one.

---

## Registered analyzers

All 40 `rule.check.fn` values, mapped in `registry.py`:

```
logo.presence  logo.clearspace  logo.min_size  logo.distortion
logo.recolor   logo.placement   logo.occlusion

color.palette_conformance  color.forbidden  color.dominance_ratio

typography.approved_family  typography.min_size  typography.hierarchy
typography.fallback_font    typography.casing

layout.safe_zone  layout.margins  layout.grid_alignment
layout.element_overlap  layout.text_density

imagery.style_conformance  imagery.medium
imagery.prohibited_subject imagery.reuse

copy.banned_terms  copy.required_terms  copy.readability
copy.claim_substantiation  copy.disclaimer_present
copy.locale_spelling  copy.cta_allowlist

accessibility.contrast  accessibility.font_size_floor  accessibility.alt_text

channel_spec.conformance

vlm.voice_tone  vlm.mood  vlm.subject_appropriateness
vlm.overall_judgment  vlm.rule_adjudication
```

Every analyzer has the signature `(ctx: AnalysisContext, rule: RuleDefinition)
-> CriterionResult` and returns a real verdict with populated
`evidence.measured` and `evidence.threshold`. Where a capability genuinely
cannot run — OCR driver `none`, no structured source, no configured judge — the
result is `insufficient_evidence` with an explanation. **Never a fake pass.**

`ANALYZER_TIERS` records the tier an analyzer *actually* runs at, independent of
what a rule claims, so a rule that mislabels a VLM check as `cv` cannot smuggle
a paid call past the budget guard.

---

## Routes

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/analyze` | `X-Engine-Secret` |
| POST | `/v1/extract-rules` | `X-Engine-Secret` |
| POST | `/v1/induce-rules` | `X-Engine-Secret` |
| POST | `/v1/assemble` | `X-Engine-Secret` |
| POST | `/v1/predict` | `X-Engine-Secret` |
| POST | `/v1/embed` | `X-Engine-Secret` |
| GET | `/health` | none — liveness only, dependency-free |
| GET | `/health/deep` | none — capability probe |
| GET | `/version` | none |

`X-Engine-Secret` is compared to `ENGINE_SHARED_SECRET` in constant time. If the
secret is unset every authenticated route returns **503**, not 200: an engine
with no secret would accept analysis requests from anything that can reach the
port.

`/health/deep` probes OpenCV, PyMuPDF, python-pptx, scikit-image/learn,
imagehash, textstat and rapidfuzz, reports which LLM roles have credentials,
whether the OCR driver is usable and whether the scratch directory is writable.
Most "why did every logo check come back `insufficient_evidence`" questions are
answered there.

---

## Install and run

Every dependency resolves to a pure-Python or prebuilt `win_amd64` /
`manylinux` wheel. **Nothing builds from source** — the target is a Windows VM
with no Docker and no compiler toolchain.

```bash
cd apps/engine
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Linux/macOS

pip install -r requirements.txt          # runtime
pip install -r requirements-dev.txt      # + pytest, ruff, mypy

pytest                                    # 221 tests, no network, no API keys
python -m uvicorn brandlens_engine.main:app --host 0.0.0.0 --port 8000
```

Configuration comes from the repo-root `.env` (see `.env.example`) — the same
file the control plane reads, so both sides agree on `ENGINE_SHARED_SECRET`,
`LLM_JUDGE_*`, `OCR_DRIVER` and the cost ceilings. No engine-only env names are
invented.

### Dependency notes

- **`textstat` is pinned to `>=0.7.5,<0.7.8`.** From 0.7.8 it moved syllable
  counting onto NLTK's `cmudict`, which is a runtime *download*. This service
  must work air-gapped, so we stay on the pyphen-backed line (dictionaries ship
  in the wheel). `copy_checks.readability_metrics` additionally falls back to a
  vendored Flesch implementation if any metric raises, and flags
  `degradedToFallback` in the evidence.
- **Aho–Corasick is implemented in pure Python** (`copy_checks.AhoCorasick`)
  rather than adding `pyahocorasick`, which needs a C build.
- **Embeddings default to the `hash` provider** — a deterministic SimHash over
  character n-grams and image tiles. Zero model downloads, reproducible across
  restarts, good for near-duplicate detection and precedent retrieval. Semantic
  questions go to the VLM, which is the point of the tiering.
- **OCR defaults to `vlm`** (no native install). `tesseract` shells out to a
  configured binary; `none` is a first-class driver that makes dependent checks
  abstain honestly.

---

## Module map

| File | Responsibility |
|------|----------------|
| `main.py` | FastAPI app, routes, shared-secret auth, request-scoped logging |
| `config.py` | pydantic-settings over the repo-root `.env` |
| `logging.py` | structlog JSON logs carrying `request_id` |
| `models.py` | pydantic v2 mirror of `packages/contracts/src/{core,engine}.ts` |
| `registry.py` | `rule.check.fn` -> analyzer, plus the real-tier map |
| `pipeline.py` | `AnalysisContext`, tiered execution, budget guard, response assembly |
| `color.py` | sRGB↔linear↔XYZ↔Lab, full CIEDE2000, Lab k-means, tint/shade segment test, photo-region exclusion, and the three colour analyzers |
| `contrast.py` | WCAG 2.x luminance and ratio, per-glyph local sampling, APCA Lc (advisory) |
| `logo.py` | Feature/RANSAC + NCC detection, homography decomposition, clear-space annulus, min size, recolour, placement, occlusion, co-brand order |
| `typography.py` | Font-name normalisation, RapidFuzz alias resolution, fallback/faux-style detection, size floors, hierarchy, casing |
| `layout.py` | Ink bbox, margins, safe zones (from the placement's published spec when a rule names none), grid residuals, overlap IoU, advisory text density |
| `imagery.py` | Style features, manifold distance, medium heuristic, pHash reuse |
| `copy_checks.py` | Aho–Corasick, unicode/OCR normalisation with offset preservation, claims register join, four-way disclaimer check, readability, locale spelling, CTA allowlist |
| `channel_spec.py` | Registry-vocabulary spec validation: dimensions, ratios, bytes, formats, colour space, and the print set — trim, bleed, total ink coverage from real CMYK separations, crop marks, outlined fonts. `SPEC_KEYS` gives every key a role so none can go unread |
| `accessibility.py` | Contrast rollup, size floors, alt-text adequacy |
| `structured.py` | PDF/PPTX/HTML/Figma -> one normalised element tree |
| `media.py` | Loading, ICC→sRGB, resize/crop/tile, derivative and Set-of-Mark writing, plus the prepress probes: source colour model, declared resolution, PDF page boxes, CMYK separations |
| `ocr.py` | `vlm` / `tesseract` / `none` drivers returning spans with bbox + confidence |
| `embeddings.py` | Provider interface + deterministic SimHash fallback |
| `judge.py` | The T2 judge and the five `vlm.*` analyzers |
| `extract.py` | Brand book -> *proposed* rules with page + bbox citations |
| `induce.py` | Approved corpus -> proposed rules with `support` |
| `assemble.py` | Brief -> assembly plan constrained by the active ruleset |
| `predict.py` | Synthetic persona panel, relative ranking + interval |
| `cache.py` | Content-addressed in-process LRU over a bounded disk tier |
| `llm/` | `LLMProvider` ABC, Anthropic / OpenAI / Azure / Google / OpenAI-compatible, factory, pricing |

---

## Graceful degradation

There is no failure mode that produces a 500 from `/v1/analyze`.

| Failure | Behaviour |
|---------|-----------|
| Missing or unreadable asset | Pixel checks return `insufficient_evidence`; a warning names the file |
| Corrupt / encrypted PDF | Structured parse degrades to `kind="none"`; pixel path continues |
| Unregistered `rule.check.fn` | That criterion returns `insufficient_evidence` + `error`; siblings still run |
| Analyzer raises | Caught, logged with a stack trace, returned as `insufficient_evidence` + `error` |
| LLM timeout / 5xx | Retried with `tenacity` (exponential backoff + jitter) on 408/409/429/5xx only — a 400 is a bad prompt and retrying it just burns budget |
| No provider credentials | T2 criteria return `insufficient_evidence`; T0/T1 still return real verdicts |
| Cost ceiling reached | Run flips to `degraded`, remaining T2 criteria are skipped with an explanation, everything already measured is returned |
| OCR driver `none` | Checks needing pixel text location abstain and say why |

The budget guard forecasts from *observed* cost per call and refuses work it
cannot afford, rather than waiting for the ceiling to be breached. The first T2
call is always permitted — token pricing varies by an order of magnitude across
configurable models, so refusing to start means never learning what a call
actually costs on this tenant's model.

---

## Testing

```bash
pytest                        # 221 tests
pytest tests/test_color.py    # includes all 33 Sharma et al. CIEDE2000 vectors
ruff check brandlens_engine tests
```

Fixtures synthesise every asset with PIL and PyMuPDF at test time — no network,
no API keys, no checked-in binaries. Assertions are anchored to published
reference values wherever one exists: the Sharma CIEDE2000 dataset, `#000` on
`#FFF` == 21.0 exactly, `#767676` on white == 4.54, APCA Lc 106.04 / −107.88,
the WCAG 18pt / 14pt-bold large-text boundary.

Notable behavioural tests:

- No analyzer returns a pass without computed evidence behind it.
- Every logo check abstains when no logo is detected, rather than passing.
- Local contrast sampling catches text that whole-canvas averaging would hide.
- A hallucinated judge bbox is dropped; a mark reference resolves to a real box.
- A coin-flip vote abstains; a 4-of-5 majority stands.
- Unbalanced precedent pools shrink instead of topping up from the majority.
- The budget ceiling degrades the run rather than failing it.
- A raising analyzer does not take down its siblings.

---

## Scoring is not done here

The engine returns atomic `CriterionResult`s. The headline score is
deterministic aggregation over those criteria **in the control plane**. A raw
VLM score is never surfaced: judges rank well and score badly.
