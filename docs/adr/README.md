# Architecture Decision Records

One file per decision that would be expensive to reverse. Each follows the same
template:

```
# NNNN — Title

Status · Date · Deciders

## Context      what forced a choice
## Decision     what we chose, stated plainly
## Consequences what this buys and what it costs — both sides
## Alternatives what else was considered, and why it lost
```

A decision recorded here is not permanent. It is *documented*, so that when
someone proposes reversing it they are arguing with the reasoning rather than
with a habit. If the reasoning no longer holds, supersede the ADR — do not
edit it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-hybrid-ts-python-split.md) | Hybrid TypeScript + Python split | Accepted |
| [0002](0002-pg-boss-not-redis.md) | pg-boss instead of Redis | Accepted |
| [0003](0003-pgvector-optional.md) | pgvector optional, `real[]` fallback | Accepted |
| [0004](0004-shared-schema-rls.md) | Shared-schema multi-tenancy via RLS | Accepted |
| [0005](0005-tiered-checks.md) | Tiered checks, never VLM-first | Accepted |
| [0006](0006-deterministic-scoring.md) | Deterministic score aggregation | Accepted |
| [0007](0007-content-addressed-job-keys.md) | Content-addressed job and trace keys | Accepted |
| [0008](0008-rules-land-as-proposed.md) | Rules always land as `proposed` | Accepted |
| [0009](0009-local-storage-default.md) | Local-filesystem storage driver by default | Accepted |
| [0010](0010-pm2-on-windows.md) | PM2 on Windows, no Docker | Accepted |
| [0011](0011-cross-language-null-boundary.md) | Optional means nullish at the Python/TS boundary | Accepted |
