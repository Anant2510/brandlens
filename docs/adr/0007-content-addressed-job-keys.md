# 0007 — Content-addressed job and trace keys

**Status** Accepted · **Date** 2026-02-13 · **Deciders** Platform

## Context

Four requirements arrived separately and turned out to be the same requirement.

**Idempotency.** `POST /v1/checks` is called by agents, by CI, by webhook
handlers and by humans double-clicking. A duplicate must not create a second
run or bill a second time. pg-boss delivers at least once, so the analysis
handler *will* be invoked twice for the same run.

**Caching.** VLM calls cost real money. Re-checking an unchanged asset under an
unchanged ruleset should cost nothing. A 60%+ hit ratio is the difference
between a viable unit economic and an unviable one.

**Invalidation.** When a brand manager activates a rule, every affected result
must be recomputed — and nothing else. Invalidating the whole tenant on every
rule edit destroys the cache; invalidating nothing produces stale verdicts.

**Reproducibility.** A regulator asking "why did you approve this in March"
needs an answer that identifies precisely which bytes, which rules, which code
and which model produced the verdict.

## Decision

Derive the identity of a run — and of each individual criterion — from a hash
of **exactly the things that can change the answer**.

```
job_key   = sha256(canonicalJson([
              'bl.job.v1',
              assetContentHash,     // sha256 of the bytes
              rulesetHash,          // frozen ruleset snapshot
              pipelineVersion,      // orchestration contract version
              modelVersion,         // judge model identity
              promptHash,           // rendered prompt template
              variant               // optional narrowing
            ]))

trace_key = sha256(canonicalJson([
              'bl.trace.v1',
              assetContentHash, rulesetHash,
              ruleKey, ruleVersion,
              modelVersion, promptHash
            ]))
```

`UNIQUE (org_id, job_key)` on `check_runs` makes idempotency a database
constraint rather than an application convention.

Three supporting decisions:

**Canonical JSON.** Object keys sorted recursively, `undefined` dropped, arrays
left in order (arrays are ordered data, objects are not), `Date` normalised to
ISO, non-finite numbers to null. `JSON.stringify` preserves insertion order, so
two structurally identical objects built by different code paths would
stringify differently, hash differently, and miss the cache forever.

**Two granularities.** `trace_key` is finer than `job_key` on purpose. Editing
one rule changes the ruleset hash and therefore the job key — but every *other*
rule's trace key is unchanged, so the expensive verdicts for untouched rules
replay from cache instead of being re-purchased. Editing one rule in a
forty-rule ruleset costs one rule's worth of judgment.

**`variant` partitions the key space.** A dimension-filtered re-check, a
`deterministicOnly` pass, and a caller-supplied `Idempotency-Key` all feed
`variant`, so a partial re-check never collides with the full run it is a
subset of, and a caller who genuinely wants a second run of identical inputs
can have one without `force: true`.

Every function in `apps/api/src/common/hash.ts` is a **pure function of its
inputs**. That is not a style preference: if any of them picked up ambient state
— a timestamp, a uuid, map iteration order — the cache would silently miss
forever and the audit trail would stop being reproducible.

## Consequences

**Good**

- Idempotency is enforced by Postgres. Application bugs cannot create duplicate
  runs.
- Caching is automatic and correct by construction. Nobody has to remember to
  invalidate.
- Invalidation is precise. Publishing a ruleset re-runs exactly the affected
  criteria.
- Reproducibility is a property of the data model, not of a logging
  convention. `pipelineVersion` and `modelVersion` mean a code change or a model
  swap correctly produces a new key rather than reusing a verdict the new code
  would not have reached.
- Deduplication is free at the asset layer too: content-addressed storage means
  the same file uploaded by five people occupies one blob and shares one set of
  measurements.

**Costs**

- The hash inputs are load-bearing and easy to get wrong. Forgetting to bump
  `PIPELINE_VERSION` after changing orchestration means serving verdicts the
  new code would not produce. There is a unit test asserting hash stability,
  which is a partial mitigation, not a complete one.
- `force: true` needs an escape hatch, and the implementation is ugly:
  `${jobKey.slice(0, 56)}${randomUUID().slice(0, 8)}`. It works — the row no
  longer collides — but the resulting run has a key that is not a hash of
  anything, so it is deliberately not reusable.
- A prompt-template edit invalidates every cached verdict for the affected
  rules. Correct, and occasionally expensive; it is why prompt optimisation is
  a deliberate, versioned operation rather than a hot-reloaded file.
- Debugging a cache miss means reconstructing six inputs and comparing hashes.
  `GET /v1/checks/:id/traces` exposes `traceKey` for exactly this reason.

## Alternatives

**A random uuid per run, with an `Idempotency-Key` header for dedupe.** The
conventional REST approach. Rejected: it gives idempotency alone. Caching,
invalidation and reproducibility would each need separate machinery, and the
three would drift.

**Cache keyed on the request body.** Rejected: the body does not contain the
ruleset, the model or the pipeline version, so a rule change would not
invalidate anything.

**Cache with a TTL.** Rejected: it is wrong in both directions. A verdict on
unchanged inputs is valid indefinitely, so a TTL wastes money; a verdict on
changed rules is invalid immediately, so a TTL serves stale answers.

**Store the whole input as JSONB and compare structurally.** Correct, and it
would make debugging easier. Rejected on index size and comparison cost: a
64-character hash with a unique index is dramatically cheaper than deep
equality over a document containing forty compiled rules.
