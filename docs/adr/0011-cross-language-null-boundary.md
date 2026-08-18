# ADR 0011 — Optional means nullish at the Python/TypeScript boundary

Status: Accepted · 2026-08-17

## Context

BrandLens spans two languages by design (see [ADR 0001](0001-hybrid-ts-python-split.md)):
a TypeScript control plane and a Python analysis engine, talking over JSON and
validated on both sides.

The two ecosystems disagree about what "optional" means on the wire:

| | unset field serialises as | validator accepts |
|---|---|---|
| Pydantic v2 (`Optional[str]`) | `"note": null` | — |
| zod (`z.string().optional()`) | — | key **absent**, not `null` |

So the engine emits a field that the control plane's own contract rejects. The
failure is not cosmetic and not local. During integration it produced:

- `GET /health/deep` reporting a healthy engine as **unreachable**, because one
  of forty analyzers had `note: null`.
- `POST /v1/checks` returning **HTTP 500** on a completed, correct analysis,
  because a single deterministic check had no `threshold` to report.

Both surfaced as infrastructure failures — "engine down", "internal server
error" — when the engine had in fact done its job perfectly. That is the
expensive part: the symptom points away from the cause.

## Decision

**Wherever the Python engine is the producer, `optional` is expressed as
`.nullish()`, never `.optional()`.**

This applies to `EngineHealth`, `EngineCriterionResult`, `AnalyzeResponse`,
`Evidence`, `RuleDefinition` and the extract / induce / assemble / predict
response schemas in `packages/contracts`. Request schemas the control plane
*produces* keep plain `.optional()`, because TypeScript omits undefined keys and
Pydantic accepts a missing key for an `Optional` field.

The corresponding Drizzle `$type<>` declarations for columns that store engine
payloads verbatim (`decision_traces.evidence`, `decision_traces.model`,
`rules.citation`, `rules.support`) declare their members `| null` for the same
reason.

## Consequences

**Good**

- The contract describes what actually travels over the wire, so validation
  failures now mean a genuine protocol change rather than an unset field.
- No scrubbing pass between receiving a response and persisting it. Decision
  traces stay a faithful record of what the engine said — which matters,
  because the trace is the audit artifact we sell.
- The rule is mechanical and reviewable: producer-side schema, nullish
  optionals.

**Bad**

- `T | null | undefined` is a wider type than `T | undefined`, so consumers
  handle one more case. In practice these values are either persisted as JSONB
  or rendered behind a truthiness check, so the cost is close to zero.
- The asymmetry between request and response schemas has to be *known*. Hence
  this ADR and the comment on `Evidence` in `packages/contracts/src/core.ts`.

## Alternatives considered

**`model_dump(exclude_none=True)` on the engine side.** Strips nulls so plain
`.optional()` works. Rejected: it cannot distinguish "unset" from
"meaningfully null". `confidence: null` is the *correct*, required value for a
deterministic verdict — a deterministic check has no confidence to report — and
stripping it turns a required field into a missing one, trading a null-typing
bug for a harder missing-key bug.

**Scrub nulls in the API client after parsing.** Rejected: it puts a
lossy transformation between the engine's output and the audit record, so the
stored trace would no longer be exactly what the engine returned.

**Generate the contracts from a single IDL (OpenAPI / Protobuf).** The right
long-term answer, and the generator would settle this question by construction.
Deferred: it is a build-system project, and the hand-written zod schemas are
currently also the API's validation layer and the web client's types. Worth
revisiting if a third language joins.
