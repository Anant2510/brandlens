# BrandLens demo runbook

A 12–15 minute walkthrough against the seeded **Northwind Coffee Co.** tenant on the
Windows VM. Every screen below is populated by `pnpm --filter @brandlens/db seed` —
you do not need to create anything to run this demo.

---

## 0. Pre-flight (do this 10 minutes before, not during)

```powershell
cd C:\brandlens
pm2 list                        # all 4 processes must say "online"
.\infra\windows\healthcheck.ps1 # database / engine / api / web
```

Expect: engine reports **40 analyzers**, `"warnings": []`, all providers
`configured: true`. If `api-deep` or `pm2` report a parse failure, that is the
known PowerShell 5.1 JSON bug in the healthcheck script — cosmetic, the services
themselves are fine. Confirm by opening the URLs in a browser.

Open these four tabs in advance so nothing loads cold in front of an audience:

| Tab | URL |
|---|---|
| 1 | `http://localhost:3000/dashboard` |
| 2 | `http://localhost:3000/brands` |
| 3 | `http://localhost:3000/checks` |
| 4 | `http://localhost:3000/analytics` |

**Login:** `owner@northwind.test` / `BrandLens!2026`
(also seeded: `reviewer@northwind.test`, `creator@northwind.test`, same password —
use the reviewer account for the review beat if you want to show role separation.)

### Known defect that will show on camera

Asset thumbnails on `/assets` render as broken-image icons. The underlying files
and the analysis are fine — it is a preview-URL resolution bug. Either fix it
before demoing or open assets from `/checks` instead of `/assets`, where the
evidence crops render from a different path.

---

## 1. The one-sentence framing (30 seconds)

> Every brand has a book of rules that lives in a PDF nobody reads and a senior
> designer's head. BrandLens turns that into a machine-checkable ontology, then
> grades every asset against it — and records *why* it decided what it decided.

Do not open with the score. Open with the trace. The score is a commodity; the
audit trail is the product.

---

## 2. The ontology — "what the brand actually is" (2 min)

`/brands` → **Northwind Coffee Co.** → **Ontology**

Point at, in this order:

- **Design tokens (27)** — W3C DTCG format, each with a precomputed CIELAB value.
  Say: *colour comparison is done in Lab with CIEDE2000, not hex equality, because
  "close enough" is a perceptual question, not a string question.*
- **Logo variants (4)** — with clear-space and minimum-size requirements attached.
- **Type styles (6)**, **voice axes (4)**, **lexicon (25 terms)**.
- **Claims (6)** — deliberately includes **one expired claim** and **one scoped to a
  jurisdiction it is not being used in**. This is the beat that lands with legal
  and compliance people: the brand system knows a claim has an expiry date.
- **Disclaimers (3)**.

## 3. The rules — "and how that becomes checkable" (2 min)

`/brands/{brandId}/rules` → **57 rules, 42 active, 15 proposed**

- Filter by **provenance**. Show one `deductive` rule and click through to its
  **citation** — document, page number, bounding box. *That rule came out of the
  brand book, and here is the paragraph it came from.*
- Show one `inductive` rule and open its **support** block — the statistical
  evidence from measuring an approved corpus. *Nobody wrote this rule down.
  We measured 40 approved assets and found the pattern.*
- Land the governance point: **every generated rule arrives as `proposed`.**
  Activation is an explicit human act. The machine proposes; a person decides.

`/brands/{brandId}/rulesets` — the **brand compile**. Global → sub-brand → market →
channel → campaign, resolved with CSS-like specificity into a frozen snapshot with
a `ruleset_hash`.

> Why it matters: a check is graded against a *frozen* ruleset. Re-run the same
> asset against the same hash a year from now and you get the identical verdict.
> That is what makes the audit defensible.

## 4. The check — "we measure, the model judges" (4 min — this is the core)

`/checks` → open the completed run → **39 decision traces, 6 findings**

Expand a single trace and walk the anatomy:

- **Which tier decided it.** T0 deterministic (~$0, ~100% precision) → T1 classical
  CV (~$0.001) → T2 VLM judge ($0.005–0.05).
- **The measured value.** ΔE00 = 4.7. Contrast ratio = 3.1:1. Clear-space = 0.83×.
  These are computed in code and *fed into* the prompt — the model is never asked
  to eyeball a number.
- **Cost and latency, per criterion.**

Then the two claims that distinguish this from a wrapper around GPT:

1. **The headline score is deterministic.** It is a weighted aggregation over atomic
   binary criteria with blockers overriding — never a number a VLM emitted.
   (Research backs this: VLM judges rank reliably but cannot score reliably.)
2. **Under 30% of criteria ever touch a VLM.** Show the tier mix. That is the cost
   story and the reliability story at once.

Open a **finding** — the evidence crop, the rule it violated, the recommended fix.

## 5. The learning loop (2 min)

`/review` → open a review → show the **human override** in the seeded run.

> A reviewer disagreed with the engine. That decision is now a gold label. It
> becomes a **precedent** — retrieved into future prompts for similar cases, half
> passing examples and half failing ones so the retrieval doesn't bias the judge.
> Thresholds recalibrate. Where the model's calibration slips below β = 0.3, that
> criterion auto-routes to a human instead of guessing.

This is the Adobe "decision traces" idea made concrete: the system gets better
because people used it, not because someone retrained something.

## 6. The other two skills (2 min)

- `/predict` — **Predict**: score a concept *before* production spend.
- `/assemble` — **Instruct-to-Assemble**: a brief plus the compiled ruleset produces
  a constrained assembly, not a free-form generation.

## 7. It is a platform, not just a UI (1 min)

- `/settings/api-keys` — the API is the product surface; the web app is one client.
- `/v1/mcp` — an **MCP endpoint**, so an agent can call BrandLens as a tool.
  This is the "agentic marketing" beat: the checker is callable by other agents.
- `/settings/audit-log`, `/settings/webhooks`, `/settings/models`.
- `/analytics` — pass rates by rule, cost per check, VLM touch rate, calibration
  drift.

Close on multi-tenancy if the audience is technical: shared schema with Postgres
row-level security, forced on ~40 tables, tenant set per-transaction so it cannot
leak across a pooled connection.

---

## What NOT to promise in this demo

- **There is no "paste a URL, get a brand report" flow yet.** Nothing in the
  codebase crawls or scrapes a website. If asked, say it is the next feature and
  that the ontology, analyzers and scoring it would feed are already built.
- Do not click into asset thumbnails on `/assets` until the preview bug is fixed.
- Do not promise the seeded numbers are benchmarks. They are a seeded demo tenant.

## Housekeeping before anyone else can reach this host

Revoke the seeded demo API key `bl_live_demo_northwind_seed_2026`. It is a demo
credential committed to the seed script.
