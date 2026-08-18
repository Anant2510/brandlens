# BrandLens — API reference

Base URL: `http://localhost:4000` in development, whatever `API_PUBLIC_URL` is
set to in production.

Interactive OpenAPI: **`GET /docs`** (Swagger UI, generated from the live
controllers by `@nestjs/swagger` — it is always in sync with the running build).

Every request and response body is validated by a zod schema in
`packages/contracts`. That package is the single source of truth for the API,
the engine protocol and the web client, which is why they cannot drift.

**Contents**

1. [Authentication](#1-authentication)
2. [Conventions](#2-conventions)
3. [`POST /v1/checks` — the wedge endpoint](#3-post-v1checks--the-wedge-endpoint)
4. [Checks and findings](#4-checks-and-findings)
5. [Assets](#5-assets)
6. [Brands and the ontology](#6-brands-and-the-ontology)
7. [Rules and rulesets](#7-rules-and-rulesets)
8. [Review](#8-review)
9. [Assemble and predict](#9-assemble-and-predict)
10. [Analytics](#10-analytics)
11. [Platform](#11-platform)
12. [Webhooks](#12-webhooks)
13. [MCP](#13-mcp)
14. [Errors](#14-errors)

---

## 1. Authentication

Two credential types, both presented as `Authorization: Bearer <token>`. The
`CombinedAuthGuard` accepts either.

### API keys — for machines

The primary interface. BrandLens is API-first, and the "verify inside an agent
loop" wedge depends on these being first-class.

```bash
# Mint one (requires an admin session JWT)
curl -s -X POST http://localhost:4000/v1/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"name":"CI pipeline","scopes":["checks:read","checks:write","assets:write"]}'
```

```json
{
  "id": "6f0c1f1a-....",
  "prefix": "bl_live_a1b2c3",
  "plaintext": "bl_live_a1b2c3d4e5f6...",
  "scopes": ["checks:read", "checks:write", "assets:write"],
  "expiresAt": null,
  "warning": "Store this key now — it will not be shown again."
}
```

Only a peppered HMAC of the key is stored. Lookup is by the non-secret,
indexed `prefix` column followed by a constant-time compare, so authentication
is O(1) per request rather than O(keys), and the timing profile does not reveal
which org a key belongs to.

Scopes: `checks:read`, `checks:write`, `assets:read`, `assets:write`.

Revocation is a soft delete — the audit trail keeps the key's history:

```bash
curl -s -X DELETE http://localhost:4000/v1/api-keys/6f0c1f1a-... \
  -H "Authorization: Bearer $JWT"
```

### Session JWTs — for humans

```bash
curl -s -X POST http://localhost:4000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@northwind.test","password":"BrandLens!2026"}'
```

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "expiresIn": 900,
  "user": {
    "id": "...", "email": "owner@northwind.test", "name": "Dana Okonkwo",
    "orgId": "...", "orgName": "Northwind Coffee Co.",
    "orgSlug": "northwind-coffee", "role": "owner"
  }
}
```

Access tokens last `JWT_ACCESS_TTL` (default 15m). Refresh rotates: the
presented token is revoked and a new pair issued **in the same transaction**,
so reuse of a revoked token is detectable — which is the entire reason hashes
of them are stored.

| Route | Purpose |
|---|---|
| `POST /v1/auth/register` | Create an org and its owner |
| `POST /v1/auth/login` | Exchange credentials for tokens |
| `POST /v1/auth/refresh` | Rotate |
| `POST /v1/auth/logout` | Revoke |
| `GET /v1/auth/me` | The session user |

### Roles

`owner` › `admin` › `brand_manager` › `reviewer` › `creator` › `viewer`, plus
`service` for machine identities. `RolesGuard` treats these as a hierarchy: a
route marked `@Roles('reviewer')` also admits `brand_manager`, `admin` and
`owner`.

---

## 2. Conventions

**Tenancy.** The credential determines the tenant. There is no `orgId`
parameter anywhere, and there is no way to ask for another tenant's data —
`TenantBindingInterceptor` binds `app.tenant_id` for the request and PostgreSQL
RLS enforces it.

**Correlation.** Send `X-Correlation-Id` and it is echoed back, propagated to
the analysis engine as `X-Request-Id`, and carried through queue payloads. One
id follows a request across all four processes. If you do not send one, the API
generates it.

**Pagination.** Offset-based, on every list endpoint:

```
?page=1&pageSize=25          # pageSize max 200
```

```json
{ "data": [ ... ], "page": 1, "pageSize": 25, "total": 143, "hasMore": true }
```

**Timestamps.** ISO 8601 with timezone, always UTC.

**Content type.** `application/json`, except asset upload which is
`multipart/form-data`. The body limit is 25 MB — brand books are the single
most important onboarding upload and the default 100 kB would reject them.

---

## 3. `POST /v1/checks` — the wedge endpoint

Asset in, structured findings out. Everything else in the product exists
because this endpoint produces something worth looking at.

### Request

```jsonc
{
  "assetId": "uuid",          // or `asset` to register and check in one call
  "asset": {                  // alternative to assetId
    "name": "hero-1080.png",
    "url": "https://cdn.example.com/hero-1080.png",
    "kind": "image",
    "market": "en-US",
    "channel": "meta-feed",
    "assetType": "image",
    "copyFields": { "headline": "...", "body": "...", "cta": "Shop now" }
  },
  "brandId": "uuid",          // defaults to the asset's brand
  "rulesetId": "uuid",        // defaults to the brand's active ruleset
  "dimensions": ["logo", "color"],   // restrict — cheap targeted re-checks
  "deterministicOnly": false, // skip the vision judge entirely: fast and free
  "async": true,              // false blocks and returns the completed run
  "force": false,             // bypass the result cache. Costs real money.
  "idempotencyKey": "..."     // or the Idempotency-Key header
}
```

### Synchronous — the agent path

An agent in a generate → verify → fix loop has nothing to poll with, so
`async: false` blocks and returns the completed run.

```bash
curl -s -X POST http://localhost:4000/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "assetId": "0c1e...",
    "async": false,
    "deterministicOnly": true
  }'
```

```jsonc
{
  "id": "d252f402-2212-5c1a-b016-a08e29c1d242",
  "assetId": "0c1e...",
  "brandId": "9f21...",
  "status": "completed",
  "score": 70.38,
  "scoreBand": "fail",
  "hasBlocker": true,
  "dimensionScores": {
    "logo": 100, "color": 0, "typography": 100,
    "layout": 100, "copy": 88.89, "accessibility": 100,
    "channel_spec": 100, "legal": 0
  },
  "criteriaTotal": 39,
  "criteriaEvaluated": 38,
  "criteriaPassed": 25,
  "criteriaFailed": 5,
  "criteriaAbstained": 1,
  "coverageRate": 0.9744,
  "rulesetHash": "2c12859b3a7f6e4e...",
  "costUsd": 0.0303,
  "cacheHits": 0,
  "cacheMisses": 39,
  "durationMs": 9000,
  "createdAt": "2026-08-14T10:22:05.000Z",
  "completedAt": "2026-08-14T10:22:14.000Z",

  "traces": [
    {
      "id": "...",
      "traceKey": "8b41c2...",
      "ruleKey": "color.forbidden-competitor",
      "ruleVersion": 1,
      "dimension": "color",
      "tier": "cv",
      "verdict": "fail",
      "severity": "blocker",
      "confidence": 0.99,
      "evidence": {
        "measured": {
          "clusterHex": "#00704a",
          "surfaceSharePct": 47.8,
          "deltaEToForbidden": 0,
          "deltaEToNearestApprovedToken": 22.7,
          "nearestApprovedToken": "color.brand.pine"
        },
        "threshold": { "deltaEThreshold": 12, "minClusterSharePct": 2 },
        "bbox": [0, 0, 1, 0.3519],
        "observation": "A colour cluster covering 47.8% of the canvas is an exact match for a registered competitor equity colour."
      },
      "model": null,
      "citation": null,
      "suggestedFix": "Replace the green bands with Pine (#1F4D3D) or Espresso (#2B1B12)...",
      "cached": false,
      "costUsd": 0,
      "latencyMs": 4,
      "createdAt": "2026-08-14T10:22:06.000Z"
    }
  ],

  "findings": [
    {
      "id": "...",
      "traceId": "...",
      "ruleKey": "color.forbidden-competitor",
      "dimension": "color",
      "severity": "blocker",
      "title": "Competitor equity colour covers 48% of the canvas",
      "detail": "#00704A is registered as a forbidden colour on this brand...",
      "status": "open",
      "bbox": [0, 0, 1, 0.3519],
      "displayConfidence": 0.99,
      "isHighConfidence": true,
      "createdAt": "2026-08-14T10:22:14.000Z"
    }
  ]
}
```

### Asynchronous — the default

```bash
curl -si -X POST http://localhost:4000/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"0c1e..."}'
```

```
HTTP/1.1 202 Accepted
Location: /v1/checks/d252f402-2212-5c1a-b016-a08e29c1d242
```

Poll `GET /v1/checks/:id`, or subscribe to the `check.completed` webhook.

### Idempotency

`job_key = sha256(assetContentHash, rulesetHash, pipelineVersion,
modelVersion, promptHash, variant)`. Those are exactly the things that can
change the answer, so:

- **A repeated POST with identical inputs returns the previous run**, with
  `status: "reused"` in the envelope. That is not a shortcut — the same bytes
  under the same rules with the same model and prompt cannot produce a
  different answer.
- **`Idempotency-Key: <string>`** (or `idempotencyKey` in the body) feeds
  `variant`, partitioning the key space so a caller who deliberately wants a
  second run of identical inputs can get one.
- **`force: true`** bypasses the cache entirely. It costs real money; use it
  when you suspect a bug, not as a habit.
- **`dimensions` and `deterministicOnly` also feed `variant`**, so a partial
  re-check never collides with the full run it is a subset of.

```bash
curl -s -X POST http://localhost:4000/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Idempotency-Key: nightly-2026-08-17-batch-3' \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"0c1e...","async":false}'
```

### The agent loop

```bash
# 1. Free, instant, fully deterministic — run this on every iteration
curl -s -X POST http://localhost:4000/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"'"$ASSET"'","async":false,"deterministicOnly":true}' \
  | jq '.findings[] | {severity, ruleKey, title, suggestedFix: .detail}'

# 2. Full check, including the vision judge, on the final candidate only
curl -s -X POST http://localhost:4000/v1/checks \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"'"$ASSET"'","async":false}' | jq '.scoreBand'
```

### Notable status codes

| Code | Meaning |
|---|---|
| `200` | Completed run (`async: false`), or a reused run |
| `202` | Queued (`async: true`) |
| `400` | No active rules apply under the current ruleset and filters |
| `402` | `BudgetExceeded` — the tenant tripped its daily ceiling. Distinct from 429. |
| `409` | `NoActiveRuleset` — the brand has never published one |
| `503` | `EngineUnavailable` — the engine is unreachable or the circuit breaker is open |

---

## 4. Checks and findings

```bash
# List runs
curl -s "http://localhost:4000/v1/checks?brandId=$BRAND&scoreBand=fail&page=1&pageSize=25" \
  -H "Authorization: Bearer $TOKEN"

# One run with traces and findings
curl -s "http://localhost:4000/v1/checks/$RUN" -H "Authorization: Bearer $TOKEN"

# Traces only — the audit view
curl -s "http://localhost:4000/v1/checks/$RUN/traces" -H "Authorization: Bearer $TOKEN"

# Re-run, bypassing the cache
curl -s -X POST "http://localhost:4000/v1/checks/$RUN/rerun" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/findings/:id/explain`

Everything needed to answer "why did this fail?" in one response: the rule
text and rationale, the citation back to the brand book with page and bbox, the
measured value against its threshold, the cropped visual evidence, and the
precedent assets decided the same way.

```bash
curl -s "http://localhost:4000/v1/findings/$FINDING/explain" \
  -H "Authorization: Bearer $TOKEN"
```

### `POST /v1/findings/:id/decision`

Records a human decision. Requires the `reviewer` role. **Every override is a
training signal**, and `rationale` is consumed directly by prompt optimisation
as well as being rendered as precedent context on the next judgment of the same
rule — so it is required on overrides and worth writing well.

```bash
curl -s -X POST "http://localhost:4000/v1/findings/$FINDING/decision" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "override_pass",
    "rationale": "Disagree. \"Smoothest\" here describes our own range, not the category. The axis is about how we talk about the reader.",
    "isCalibrationLabel": true
  }'
```

Actions: `confirm`, `override_pass`, `override_fail`, `waive`, `escalate`,
`comment`. Set `isCalibrationLabel: true` on double- or triple-annotated items;
clean multi-annotator data produces far narrower judge intervals than
single-annotator data at the same sample size.

---

## 5. Assets

```bash
# Upload
curl -s -X POST http://localhost:4000/v1/assets \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@hero-1080.png' \
  -F 'brandId='"$BRAND" \
  -F 'market=en-US' \
  -F 'channel=meta-feed' \
  -F 'assetType=image' \
  -F 'copyFields={"headline":"Your morning, better sorted","cta":"Shop now"}'

# Register by URL instead
curl -s -X POST http://localhost:4000/v1/assets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"brandId":"'"$BRAND"'","name":"hero","url":"https://cdn.example.com/hero.png","kind":"image","market":"en-US","channel":"meta-feed"}'
```

| Route | Notes |
|---|---|
| `GET /v1/assets` | Filter by brand, campaign, status, exemplar flag |
| `GET /v1/assets/:id` | Includes a signed preview URL |
| `GET /v1/assets/:id/preview` | 302 to a signed URL |
| `GET /v1/assets/:id/derivatives` | Thumbnails, crops, page rasters, frames |
| `DELETE /v1/assets/:id` | Soft delete. Check history is retained. |

Ingestion is idempotent on `content_hash`: the same bytes uploaded twice
produce one blob, one asset and one set of measurements.

---

## 6. Brands and the ontology

```bash
curl -s http://localhost:4000/v1/brands -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:4000/v1/brands/$BRAND/overview" -H "Authorization: Bearer $TOKEN"
```

All ontology routes are nested under `/v1/brands/:brandId`:

| Resource | Routes |
|---|---|
| Design tokens | `GET/POST tokens`, `POST tokens/import`, `DELETE tokens/:id` |
| Logo variants | `GET/POST logos`, `DELETE logos/:id` |
| Type styles | `GET/POST type-styles`, `PATCH/DELETE type-styles/:id` |
| Voice | `GET/POST voice` |
| Lexicon | `GET/POST lexicon` |
| Claims | `GET/POST claims` |
| Disclaimers | `GET/POST disclaimers` |
| Documents | `GET/POST documents`, `POST documents/:id/extract`, `GET documents/:id/chunks` |
| Image style | `GET image-style` |
| Induction | `POST induce-rules` |

### Token import

`POST /v1/brands/:brandId/tokens/import` normalises DTCG, Style Dictionary,
Figma Variables and Tailwind config shapes into the DTCG representation, and
precomputes CIELAB for every colour so palette conformance never re-parses a
colour inside its per-cluster ΔE loop.

```bash
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/tokens/import" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"format":"dtcg","source":"figma","tokens":{"color":{"brand":{"espresso":{"$type":"color","$value":"#2B1B12"}}}}}'
```

### Brand-book extraction

```bash
# 1. Upload the PDF
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@brand-guidelines-v4.2.pdf' -F 'kind=brandbook'

# 2. Extract — queued; emits rule.proposed events
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/documents/$DOC/extract" \
  -H "Authorization: Bearer $TOKEN"
```

Extracted rules land as **`proposed`**, never `active`
([ADR-0008](adr/0008-rules-land-as-proposed.md)). Each carries a citation with
the page and a normalised bbox, so the review screen renders the source crop
beside the proposal.

---

## 7. Rules and rulesets

```bash
# List, filterable by status / dimension / tier
curl -s "http://localhost:4000/v1/brands/$BRAND/rules?status=proposed" \
  -H "Authorization: Bearer $TOKEN"

# Create — defaults to `proposed`
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/rules" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "key": "logo.clearspace",
    "statement": "Clear space must be at least 1.35x the logomark height on all four sides.",
    "dimension": "logo",
    "tier": "cv",
    "severity": "major",
    "weight": 1.5,
    "scope": { "channels": ["meta-feed", "meta-story"] },
    "check": { "fn": "logo.clearspace", "params": { "multiple": 1.35, "unit": "logomark_height" } }
  }'

# Bulk activate — the actual review workflow
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/rules/bulk-decision" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ruleIds":["...","..."],"decision":"activate"}'

# Every version of one key
curl -s "http://localhost:4000/v1/brands/$BRAND/rules/history/logo.clearspace" \
  -H "Authorization: Bearer $TOKEN"
```

Editing an **active** rule creates version + 1 rather than mutating in place,
so historical traces continue to reference the version that produced them.

### Brand compile

```bash
# Publish: compile the active rules into a frozen, hashed snapshot
curl -s -X POST "http://localhost:4000/v1/brands/$BRAND/rulesets" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"Autumn 2026 refresh"}'
```

```json
{ "id": "...", "version": 4, "hash": "2c12859b3a7f6e4e...", "ruleCount": 41, "reused": false }
```

Republishing an identical snapshot is idempotent (`reused: true`) — same rules,
same hash, and the unique index on `(brand_id, hash)` makes it a no-op rather
than a duplicate version.

```bash
# Resolve the effective ruleset for one concrete scope context
curl -s "http://localhost:4000/v1/brands/$BRAND/rulesets/effective?market=de-DE&channel=meta-story&assetType=image" \
  -H "Authorization: Bearer $TOKEN"
```

This is the endpoint a generation agent should call **before** generating, so
it can satisfy the constraints up front instead of failing verification
afterwards.

---

## 8. Review

A multi-stage, MLR-style gate: `creative` → `legal` → `brand` →
`marketing_ops`.

| Route | Purpose |
|---|---|
| `GET /v1/reviews` | The queue, filterable by state and assignee |
| `POST /v1/reviews` | Open a review |
| `GET /v1/reviews/:id` | Asset, run, findings and decisions |
| `POST /v1/reviews/:id/assign` | Assign |
| `POST /v1/reviews/:id/decision` | Record a decision within the review |
| `POST /v1/reviews/:id/submit` | Close with `approved`, `rejected` or `changes_requested` |

---

## 9. Assemble and predict

**Skill 2 — Instruct to Assemble.** Brief in; a plan out: which approved assets
to use, how to adapt them per channel, and the generation instructions that
keep the variants on-brand.

```bash
curl -s -X POST http://localhost:4000/v1/briefs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "brandId": "'"$BRAND"'",
    "title": "Autumn 2026 — Better Sorted",
    "objective": "Drive first orders on the new season blends",
    "keyMessage": "Freshness you can date",
    "targets": [
      { "platform": "meta", "placement": "feed",  "assetType": "image", "count": 3, "market": "en-US" },
      { "platform": "meta", "placement": "story", "assetType": "image", "count": 3, "market": "de-DE" }
    ]
  }'

curl -s -X POST "http://localhost:4000/v1/briefs/$BRIEF/assemble" \
  -H "Authorization: Bearer $TOKEN"
```

The plan records `constraints_applied` — the rules it was designed to satisfy —
so the plan is auditable too, not just the check.

**Skill 3 — Predict.** Synthetic audience panels score an asset before launch.
Reported as a **percentile against the tenant's own corpus with an explicit
confidence interval**, never as a bare number: judges rank far better than they
score.

```bash
curl -s -X POST http://localhost:4000/v1/panels \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"brandId":"'"$BRAND"'","name":"Coffee-curious 28-45","personas":[ ... ]}'

curl -s -X POST http://localhost:4000/v1/predictions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"assetId":"'"$ASSET"'","panelId":"'"$PANEL"'"}'
```

---

## 10. Analytics

| Route | Answers |
|---|---|
| `GET /v1/analytics/summary` | Runs, pass rate, open findings, review backlog |
| `GET /v1/analytics/rule-health` | **Per-rule override rate** — the key metric — plus agreement, beta, sample size |
| `GET /v1/analytics/cost` | Cost per asset, per rule, and the cache hit ratio |
| `GET /v1/analytics/coverage` | Auto-cleared rate and the rules currently routed to humans |

```bash
curl -s "http://localhost:4000/v1/analytics/rule-health?brandId=$BRAND" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | select(.overrideRate > 0.2)'
```

A rule with a high override rate is a rule that disagrees with the customer.
That is the single best product-health signal in the system; see
[operations.md](operations.md).

---

## 11. Platform

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | public | Liveness. **Dependency-free** by design — a stuck database must not make the process look dead. |
| `GET /health/deep` | public | Readiness: database, queue, storage, engine, vector driver, outbox depth, provider configuration. Each with the failure detail. |
| `GET /metrics` | public | Prometheus text exposition. Public so a scraper needs no credentials — which is exactly why the Caddyfile restricts it by source IP. |
| `GET /v1/channel-specs` | key/JWT | The shipped registry; tenant overrides shadow it |
| `GET /v1/members`, `POST /v1/members/invite`, … | JWT | Membership management |
| `GET /v1/organization`, `PATCH /v1/organization` | JWT | Settings and the spend limit |
| `GET /v1/audit-log` | JWT, admin | Query the append-only trail |
| `GET /v1/storage/object` | signed | Redeem a signed storage URL |

```bash
curl -s http://localhost:4000/health/deep | jq '{status, vector: .components.vector.detail.driver}'
```

---

## 12. Webhooks

Events are written to a **transactional outbox** in the same transaction as the
state change they describe, then delivered by a relay in the worker. A webhook
is never sent for a transaction that rolled back, and never lost for one that
committed.

### Register

```bash
curl -s -X POST http://localhost:4000/v1/webhooks \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{
    "url": "https://ops.example.com/hooks/brandlens",
    "description": "Slack relay",
    "events": ["check.completed", "finding.created", "review.decided"]
  }'
```

```json
{
  "id": "...", "url": "https://ops.example.com/hooks/brandlens",
  "events": ["check.completed", "finding.created", "review.decided"],
  "secret": "whsec_kQ2f...",
  "warning": "Store this signing secret now — it will not be shown again."
}
```

Use `["*"]` to subscribe to everything.

### Event types

```
asset.ingested            asset.derivative.ready     asset.embedded
ruleset.published         rule.proposed              rule.activated
check.started             check.completed            check.failed
finding.created           review.assigned            review.decided
precedent.indexed         calibration.updated        budget.threshold_crossed
brief.assembled           prediction.completed
```

### Delivery format

```
POST /hooks/brandlens
content-type: application/json
user-agent: BrandLens-Webhooks/1.0
x-brandlens-event: check.completed
x-brandlens-event-id: 0b6e...
x-brandlens-delivery-attempt: 1
x-brandlens-timestamp: 1786567334
x-brandlens-signature: sha256=6f1b0c...
```

```json
{
  "id": "0b6e...",
  "type": "check.completed",
  "version": 1,
  "orgId": "...",
  "aggregateType": "check_run",
  "aggregateId": "d252f402-...",
  "occurredAt": "2026-08-14T10:22:14.000Z",
  "payload": {
    "checkRunId": "d252f402-...",
    "assetId": "...",
    "brandId": "...",
    "score": 70.38,
    "scoreBand": "fail",
    "hasBlocker": true
  }
}
```

### Signature verification

The signature is HMAC-SHA256 over **`timestamp.body`**, not over the body
alone. Without the timestamp in the signed material a captured delivery can be
replayed forever.

```js
// Node — mirrors verifyWebhookSignature() in
// apps/worker/src/handlers/dispatch-outbox.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyBrandLensWebhook(req, rawBody, secret, toleranceSeconds = 300) {
  const timestamp = req.headers['x-brandlens-timestamp'];
  const header    = req.headers['x-brandlens-signature'];
  if (!timestamp || !header) return false;

  // Reject anything outside the replay window BEFORE comparing.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)   // rawBody, not JSON.parse -> stringify
    .digest('hex');

  const provided = header.includes('=') ? header.split('=')[1] : header;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;   // length differs -> not equal
  return timingSafeEqual(a, b);              // constant time otherwise
}
```

```python
# Python
import hashlib, hmac, time

def verify_brandlens_webhook(headers, raw_body: bytes, secret: str, tolerance=300) -> bool:
    ts = headers.get("x-brandlens-timestamp")
    sig = headers.get("x-brandlens-signature")
    if not ts or not sig:
        return False
    if abs(int(time.time()) - int(ts)) > tolerance:
        return False
    expected = hmac.new(
        secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    provided = sig.split("=", 1)[1] if "=" in sig else sig
    return hmac.compare_digest(expected, provided)
```

Two things that break verification and are easy to get wrong:

1. **Use the raw request body.** Re-serialising the parsed JSON changes key
   order and whitespace, and the signature will not match. In Express:
   `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`.
2. **Compare in constant time.** A naive `===` leaks the signature one byte at
   a time.

### Retries

Exponential backoff up to `WEBHOOK_MAX_ATTEMPTS` (default 8), with a
`WEBHOOK_TIMEOUT_MS` per attempt (default 10 000). Every attempt is recorded:

```bash
curl -s "http://localhost:4000/v1/webhooks/$ENDPOINT/deliveries" \
  -H "Authorization: Bearer $JWT"
```

Return `2xx` quickly and do the work asynchronously. A slow consumer is treated
the same as a failing one.

---

## 13. MCP

`POST /v1/mcp` speaks JSON-RPC 2.0. Agents in a generate → verify → fix loop
are the fastest-growing consumer of a verification API, so this is a
first-class surface rather than a demo.

Three tools, deliberately the minimum an agent needs to close the loop: check
the thing it made, read the rules it must satisfy, and understand why a finding
fired so it can fix it rather than guess.

```bash
# Discover
curl -s -X POST http://localhost:4000/v1/mcp \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Convenience mirror
curl -s http://localhost:4000/v1/mcp/tools -H "Authorization: Bearer $BRANDLENS_API_KEY"
```

| Tool | Purpose |
|---|---|
| `check_asset` | Run a check and return structured findings. Accepts `assetId`, or inline `copy` so an agent can verify text it just generated. **Returns synchronously.** |
| `get_brand_rules` | The effective, fully-resolved rules for a market/channel context — so generation satisfies them up front. |
| `explain_finding` | The rule text, the citation, the measured value against its threshold, and how similar cases were decided before. |

```bash
# Verify copy that was just generated, with no upload at all
curl -s -X POST http://localhost:4000/v1/mcp \
  -H "Authorization: Bearer $BRANDLENS_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 2,
    "method": "tools/call",
    "params": {
      "name": "check_asset",
      "arguments": {
        "brandId": "'"$BRAND"'",
        "copy": {
          "headline": "The smoothest cup you will drink",
          "body": "Northwind single origin, ground to order.",
          "cta": "Shop now"
        },
        "market": "en-US",
        "channel": "meta-feed",
        "deterministicOnly": true
      }
    }
  }'
```

Client configuration (Claude Desktop, Cursor, or any MCP client that supports
an HTTP transport):

```json
{
  "mcpServers": {
    "brandlens": {
      "url": "https://brandlens.example.com/v1/mcp",
      "headers": { "Authorization": "Bearer bl_live_..." }
    }
  }
}
```

---

## 14. Errors

One shape everywhere:

```json
{
  "statusCode": 409,
  "error": "NoActiveRuleset",
  "message": "Brand 9f21... has no published ruleset. Publish one via POST /v1/brands/9f21.../rulesets.",
  "correlationId": "3f2b9c1e-0a44-4d2f-9a7e-1b6c5d8e2f01"
}
```

`message` is a string, or an array of strings for validation failures.
`correlationId` is what to quote in a support request — it locates the request
across all four services.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `BadRequest` | Validation failed, or no rules apply under the current filters |
| 401 | `Unauthorized` | Missing, malformed, expired or revoked credential |
| 403 | `Forbidden` | Authenticated, but the role or scope does not permit this |
| 404 | `NotFound` | No such resource **in this tenant** |
| 409 | `Conflict` | Duplicate identity (slug, job key) |
| 409 | `NoActiveRuleset` | The brand has never published a ruleset |
| 402 | `BudgetExceeded` | Daily tenant spend ceiling reached. Distinct from 429 on purpose. |
| 422 | `UnprocessableEntity` | Well-formed but semantically invalid |
| 500 | `InternalServerError` | Unexpected. Quote the `correlationId`. |
| 503 | `EngineUnavailable` | Engine unreachable or the circuit breaker is open |

PostgreSQL `23505` (unique violation) is surfaced as `409`, and `23503`
(foreign key violation) as `400`. Neither is ever a 500 — a duplicate slug is a
client error.

**Not found means not found in your tenant.** RLS makes another tenant's
resource indistinguishable from a non-existent one, which is the correct
behaviour: a 403 would confirm the resource exists.
