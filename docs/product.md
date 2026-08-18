# BrandLens — What it is and who it is for

**BrandLens is the verification layer for brand compliance.** API-first,
generator-agnostic, model-agnostic, with an auditable decision trace behind
every verdict.

**Contents**

1. [The problem](#1-the-problem)
2. [The three skills](#2-the-three-skills)
3. [The two concepts that matter](#3-the-two-concepts-that-matter)
4. [Positioning](#4-positioning)
5. [Who buys it](#5-who-buys-it)
6. [How it gets adopted](#6-how-it-gets-adopted)
7. [What it is not](#7-what-it-is-not)
8. [Roadmap](#8-roadmap)

---

## 1. The problem

Generative tools made creative production roughly an order of magnitude
cheaper. Nothing made brand *governance* cheaper.

The result is arithmetic. A brand that produced 200 assets a quarter now
produces 2 000, reviewed by the same two people, against a 68-page PDF that
lives in SharePoint. Three things follow:

**Review became the bottleneck.** It is manual, inconsistent between reviewers
and between weeks, and it does not scale with volume.

**Generated variants drift.** An agent asked for "twelve resizes, on brand"
produces twelve plausible assets, two of which use last year's logo lockup and
one of which carries a claim that expired in October. Nobody catches it,
because catching it requires reading forty things per asset.

**In regulated categories, drift is expensive.** Pharma MLR, financial
services, food and supplements, alcohol, gambling and insurance all have the
same shape of problem: an unsubstantiated claim, a missing disclaimer or a
disclaimer nobody can read is a regulatory event, not a style note.

The tempting answer — hand the asset to a vision model and ask "does this
comply" — fails in production for four separate reasons, set out in
[ADR-0005](adr/0005-tiered-checks.md). The short version: a model cannot count
pixels, forty probabilistic checks compound to near-certain false positives,
the cost is an order of magnitude too high, and "the model said it looked
tight" is not a finding anyone can act on.

---

## 2. The three skills

### Skill 1 — Validate

**Asset in, structured findings out.** The wedge, and the thing everything else
is built on.

```bash
curl -s -X POST https://brandlens.example.com/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"0c1e...","async":false}'
```

Every finding carries a severity, the rule it violated, the measured value
against its threshold, a bounding box, a citation back to the brand book, and a
suggested fix. Nine dimensions: logo, colour, typography, layout, imagery,
copy, accessibility, channel spec, legal.

Checks run in tiers — deterministic first, computer vision second, the vision
judge last and least. Roughly 85% of a typical ruleset is arithmetic, and
arithmetic is both free and correct.

### Skill 2 — Instruct to Assemble

**Brief in, plan out.** Which approved assets to use, how to adapt each one per
channel, and the generation instructions that keep the variants on-brand.

The output is a plan, not an image. BrandLens does not generate; it tells a
generator what the constraints are, in a form a generator can act on. The plan
records `constraints_applied` — the rules it was designed to satisfy — so the
plan is auditable too, not just the check.

The key move is that constraints go in **before** generation. An agent that
calls `get_brand_rules` for its market and channel and satisfies them up front
fails verification far less often than one that generates and hopes.

### Skill 3 — Predict

**Score an asset before it launches**, against a synthetic audience panel of
personas with demographics, psychographics, media habits and objections.

Reported as a **percentile against the tenant's own past assets, with an
explicit confidence interval** — never as a bare number. That is not modesty;
it is the same finding as [ADR-0006](adr/0006-deterministic-scoring.md).
Judges rank far better than they score, so BrandLens asks them to rank.

Skill 3 is the least mature of the three and is positioned that way.

---

## 3. The two concepts that matter

### The brand ontology

A brand book is a PDF. An ontology is a queryable, versioned, scoped structure
that a machine can actually check against:

| Object | What it captures |
|---|---|
| **Design tokens** | W3C DTCG shape, with CIELAB precomputed, roles, legal tints, and *forbidden* competitor colours |
| **Logo variants** | Each approved file, its canonical geometry, its logomark height (the "X" unit), and its constraints |
| **Type styles** | Family, every alias that must resolve to it, weights, size floors, scale rank — plus the fonts that indicate a broken template |
| **Voice attributes** | Axes with `we are` / `we are not` and three exemplars on each side |
| **Lexicon** | Banned, required, preferred and trademark terms, scoped by market |
| **Claims register** | The approved claim, its substantiation, its jurisdictions and its expiry |
| **Disclaimers** | The text, plus minimum size, minimum contrast and maximum distance from the claim it qualifies |
| **Image style profile** | Fitted from the approved corpus, not written down |
| **Channel specs** | Safe zones, aspect ratios, byte ceilings, codecs — per platform, per placement, versioned |

Two properties make it work.

**Rules are scoped, not global.** A five-axis lattice — sub-brand, market,
channel, asset type, campaign — resolved most-specific-wins with CSS-like
specificity. "Our German legal line must be 9pt on Stories but 8pt everywhere
else" is one rule, not a fork of the ruleset.

**Rules are cited.** A machine-extracted rule carries the page and bounding box
it came from; an induced rule carries the statistical support that produced it.
A reviewer can see *why* the system thinks this is a rule, which is what makes
machine extraction acceptable at all.

And rules **always land as `proposed`**. A rule the customer has not confirmed
can never influence a verdict ([ADR-0008](adr/0008-rules-land-as-proposed.md)).

### The decision trace

**This is the product.** Not the score.

Every criterion produces an immutable, content-addressed row recording the
rule, the tier, the verdict, the confidence, the model identity, the measured
value, the threshold, the evidence crop, the precedents used, and the citation.

"Why did this fail?" renders as: *the rule text, page 11 of the brand book with
the source crop, "measured 0.41X against a required 1.35X", the cropped region,
and three similar assets a reviewer decided the same way last quarter.*

That artifact is what makes the tool usable in regulated review. It is also
what makes the machine correctable: a reviewer who disagrees has something
specific to disagree with, and that disagreement becomes a training signal.

`decision_traces` and `audit_log` have `UPDATE` and `DELETE` revoked at the
grant level, which makes "immutable trail" a claim defensible in a compliance
review rather than a promise in the UI.

---

## 4. Positioning

### Versus Adobe Brand Intelligence

Adobe's product is a generator that also checks its own output. Three
consequences follow, and none of them are fixable within that design:

**It only sees Adobe's assets.** A brand's creative comes from agencies,
freelancers, partners, in-house teams and half a dozen tools. Verification that
covers one of them is not verification.

**Grading your own homework is a conflict of interest.** A model asked to
evaluate output from its own family exhibits measurable self-preference bias.
BrandLens deliberately runs a judge from a *different* family than the
generator, and the configuration makes that explicit.

**Adobe's trace is not built for audit.** Their surface answers "is this on
brand". A regulated reviewer needs "which rule, which page, which measured
value, which threshold, who decided, when, and can you reproduce it in three
years".

BrandLens is not competing on generation. It is the **verification layer** —
the thing you put *after* any generator, including Adobe's.

### Versus the wider field

| Category | Examples | What they do | Where BrandLens differs |
|---|---|---|---|
| DAM with brand controls | Bynder, Frontify, Brandfolder | Store and distribute approved assets; templates | They govern the assets they hold. BrandLens verifies assets from anywhere, at generation time. |
| Creative automation | Celtra, Storyteq, Bannerflow | Produce variants from templates | Templates guarantee compliance only while nobody leaves the template. BrandLens checks the output regardless. |
| Ad QA / spec checkers | Platform preflight tools | Dimensions, file size, codec | One of nine dimensions, and the cheapest one. BrandLens ships the same channel-spec registry and adds the other eight. |
| Regulatory review | Veeva Vault PromoMats, Aprimo | Workflow and record-keeping for MLR | Workflow around a human decision. BrandLens does the checking that makes the human faster, and feeds the same audit trail. |
| Generic LLM wrappers | Various | Prompt a VLM with the brand book | Fails on precision, cost, determinism and auditability. See [ADR-0005](adr/0005-tiered-checks.md). |

The honest summary: **nobody owns the verification layer.** DAMs own storage,
CAPs own production, MLR tools own workflow, generators own creation. The gap
is between generation and distribution, and it is widening at the rate
generation is getting cheaper.

### The five defensible claims

1. **Generator-agnostic.** Any tool, any format, any pipeline.
2. **Model-agnostic, and deliberately different from the generator.**
   Anthropic, OpenAI, Azure OpenAI, Google, or an OpenAI-compatible endpoint on
   your own hardware.
3. **Tiered, so it is affordable and correct.** ~85% of checks are arithmetic.
4. **Auditable by construction.** Immutable content-addressed traces, citations,
   reproducible verdicts.
5. **It learns without training.** Calibration, precedent retrieval and prompt
   optimisation — no GPU, no training run, no model to version.

---

## 5. Who buys it

### ICP 1 — Regulated brand, in-house

*Pharma, financial services, insurance, food and supplements, alcohol,
gambling.*

50-500 marketing staff, an MLR or legal review gate, and a brand book that is
also a compliance document.

**Pain.** Review is the bottleneck and the risk. A missed claim expiry or an
illegible disclaimer is a regulatory event.

**What they buy.** The claims register, the disclaimer checks (present, large
enough, readable, adjacent), the audit trail, and the coverage rate.

**Why they pay.** They already spend the money on review. BrandLens moves it
from "checking everything by hand" to "checking the 15% the machine could not
settle".

**Buyer.** VP Marketing Operations or Head of Brand, with legal as the veto.

### ICP 2 — Creative agency or production studio

20-500 people, producing at volume for several brands, each with a different
brand book.

**Pain.** Client rejections cost margin, and every brand's rules live in a
different PDF.

**What they buy.** Multi-brand ontologies, `deterministicOnly` checks in the
production pipeline, and a compliance report they can attach to a delivery.

**Why they pay.** One avoided reprint or one avoided round of client revisions
covers a year.

**Buyer.** Head of Production or Creative Operations.

### ICP 3 — Platform and tooling teams

The team building an internal creative pipeline, or a SaaS product that
generates marketing assets.

**Pain.** They need brand compliance and do not want to build it.

**What they buy.** The API and the MCP surface. They may never open the console.

**Why they pay.** Building the ontology, the tiering, the calibration loop and
the audit trail is a multi-year project that is not their product.

**Buyer.** Engineering lead or Head of Product.

### ICP 4 — Agentic creative pipelines

The fastest-growing segment, and the one the MCP surface exists for. An agent
in a generate → verify → fix loop needs a verification API that answers
synchronously, cheaply, and in a form it can act on.

`deterministicOnly: true` is free and instant, which makes it usable on every
iteration of an inner loop. `get_brand_rules` lets the agent satisfy
constraints before generating rather than failing afterwards.

---

## 6. How it gets adopted

The order matters, because each step earns the right to the next.

**1. One brand, one channel, deterministic only.** Upload the brand book,
review the proposals, activate maybe fifteen rules. Every check is free and
100% precise. This is where trust is established, and it costs nothing.

**2. Turn on CV.** Palette conformance, logo geometry, safe zones. Still
effectively free, and now it is catching things humans miss.

**3. Turn on the judge, for two or three rules.** Voice and tone, prohibited
subjects. Watch the override rate. Calibration and precedents make it better
over a few weeks, visibly.

**4. Put it in the pipeline.** CI, the DAM webhook, the agent loop. This is
where the volume — and the value — is.

**5. Open the review queue.** Now that findings are trustworthy, reviewers use
it instead of a spreadsheet, and their decisions feed the loop.

The failure mode to avoid is starting at step 3. Turning on forty VLM rules on
day one produces a wall of low-precision findings, and the reviewer's
conclusion — "this tool does not understand our brand" — is not recoverable.

---

## 7. What it is not

- **Not a generator.** Being generator-agnostic is the position, and shipping a
  generator would forfeit it.
- **Not a DAM.** It stores assets because it must analyse them, not because it
  wants to be the system of record.
- **Not a workflow tool.** The review queue exists to close the learning loop.
  It is not a replacement for Veeva or Aprimo, and it integrates with them.
- **Not a taste engine.** BrandLens checks conformance to rules the customer
  wrote and confirmed. It has no opinion about whether the rules are good.
- **Not a compliance guarantee.** It is a tool that makes human review faster
  and more consistent. The `coverage_rate` metric is deliberately honest about
  the share it did not settle.

---

## 8. Roadmap

### Shipped

- The three-tier check engine, 38 analyzers, nine dimensions
- The brand ontology with scope-lattice resolution and brand compile
- Immutable, content-addressed decision traces with citations
- Brand-book extraction to `proposed` rules with page + bbox citations
- Rule induction from an approved corpus with statistical support
- The learning loop: calibration, precedent retrieval, prompt optimisation,
  selective abstention, the beta kill switch
- REST API, MCP surface, webhooks with HMAC signatures
- Multi-tenancy via RLS; append-only audit trail
- Assemble and Predict, first versions
- Native Windows deployment with no Docker

### Next

**Video, properly.** Frame sampling exists; per-scene analysis, safe zones over
time, and caption checking do not. Video is where the channel-spec registry
earns most, and where the current coverage is weakest.

**Figma plugin.** Check inside the design tool, before export. Structured
source means near-perfect T0 coverage — exact fonts, exact colours, exact
boxes — so this is the highest-precision surface available and the cheapest to
run.

**Batch variant checking.** `POST /v1/checks/batch` with variant-family
awareness: run the expensive semantic checks once on the master, geometry
per variant. The data model already supports it; the endpoint does not exist.

**Rule authoring in natural language.** "Legal copy must be 9pt in Germany" →
a typed, scoped rule proposal with the right analyzer and parameters, presented
for confirmation. Extraction already does this from a PDF; doing it from a
sentence is a smaller problem.

**Shadow mode for proposed rules.** Run proposals without letting them affect
the score, so reviewers see real data before activating. The reason it is not
shipped is cost: it means paying for T2 criteria that cannot change an outcome.
Gated on a per-tenant budget setting.

### Later

- **Competitive drift monitoring.** Track a competitor's palette and imagery
  over time and alert when their equity colour moves toward yours.
- **Multi-brand portfolio view.** For holding companies with a dozen brands.
- **On-premises model support, first-class.** `OPENAI_COMPATIBLE_BASE_URL`
  already works; what is missing is a documented, benchmarked local judge
  configuration for air-gapped deployments.
- **Cross-tenant rule library.** WCAG, IAB, platform specs and regulatory
  frameworks as a curated, versioned, importable set. Careful design required —
  it must not become auto-activation by another name.
- **Reviewer agreement analytics.** Where two reviewers disagree with each
  other, the rule is ambiguous. That is a better signal than either reviewer's
  agreement with the machine, and the data model already stores it.

### Explicitly not planned

- A generator.
- A fine-tuned model per tenant. The learning loop gets most of the benefit with
  none of the machinery, and a per-tenant model is a per-tenant liability.
- A model-produced score. See [ADR-0006](adr/0006-deterministic-scoring.md).
- Auto-activation of extracted rules. See
  [ADR-0008](adr/0008-rules-land-as-proposed.md).
