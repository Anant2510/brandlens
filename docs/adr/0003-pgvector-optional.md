# 0003 — pgvector optional, with a `real[]` fallback

**Status** Accepted · **Date** 2026-02-12 · **Deciders** Platform

## Context

Three features need vector similarity:

- **logo detection** — crop candidate regions, embed them, kNN against the
  tenant's approved logo gallery. Open-set by design, so adding a customer
  never requires retraining a detector;
- **precedent retrieval** — at judge time, find the k nearest past decisions
  for a specific rule and inject them as few-shot context;
- **image style conformance** — distance from the fitted centroid of the
  tenant's approved corpus.

The obvious answer is pgvector. On Linux it is one `apt install`. On Windows it
is not: pgvector ships no official Windows binary, building it needs Visual
Studio Build Tools plus the PostgreSQL development headers, and the community
prebuilt binaries have to match the server's exact major version.

Requiring it would mean the product could not be installed on the machine most
of these customers already have.

## Decision

pgvector is **optional**. The schema is designed so that it is a pure speedup,
never a requirement.

- `embeddings.vec` is `real[]` and is **always** populated, on both paths.
- `00_extensions.sql` attempts `CREATE EXTENSION vector` inside an exception
  handler and continues on failure with a `RAISE NOTICE`.
- `brandlens_cosine_similarity(real[], real[])` is a plpgsql function marked
  `IMMUTABLE PARALLEL SAFE` so the planner can push it into parallel scans.
- When pgvector *is* present, `20_vector.sql` adds a shadow `vec_p vector(N)`
  column, keeps it in sync by trigger, and builds an HNSW index.
- `VectorSearchService` resolves the driver at boot (`VECTOR_DRIVER=auto` by
  default, forceable to `pgvector` or `fallback`) and records the choice in
  `system_state`, so the API and the worker agree and the answer appears on
  `/health/deep`.

`setup-database.ps1` reports which path is active in plain language, and
documents how to add prebuilt binaries later. Adding pgvector afterwards and
re-running `pnpm db:migrate` backfills the shadow column by trigger — no
re-embedding.

## Consequences

**Good**

- BrandLens installs on any PostgreSQL 15+, including the stock EnterpriseDB
  Windows installer, with no extension and no compiler.
- The same schema runs everywhere. There is no "pgvector build" and "portable
  build" to keep in sync, and no conditional migration path.
- The decision is visible rather than implicit: `/health/deep` reports
  `vector.driver`, and the seed and setup script both say which one is in use.
- Upgrading is non-destructive and does not invalidate any stored vector.

**Costs**

- The fallback is a sequential scan with a per-row plpgsql call. On a tenant
  with 250 000 embeddings, a top-k query costs roughly a second rather than
  single-digit milliseconds. Below about 50 000 the difference is not
  noticeable in a workflow where the surrounding VLM call takes two seconds.
- Two code paths in `VectorSearchService`, both of which need testing.
- `real[]` costs 4 bytes per dimension plus array overhead; `vector(N)` is more
  compact. At `EMBEDDING_DIM=1024` that is about 4 KB per row either way — real
  but not decisive.
- Sequential scans on a large embeddings table push it out of shared buffers
  and hurt everything else on the box. This is the thing to watch, and
  [operations.md](../operations.md) sets an alert on it.

## Alternatives

**Require pgvector.** Simpler code, better performance, one path. Rejected: it
makes the product uninstallable on the target machine, and "install Visual
Studio Build Tools on your production VM" is not an acceptable first step.

**Ship a bundled pgvector binary.** Considered. Rejected because the binary
must match the PostgreSQL major version exactly, we would be redistributing a
compiled artifact we did not build, and a mismatched `.dll` fails at
`CREATE EXTENSION` in a way that is confusing rather than obvious.

**An external vector database** (Qdrant, Weaviate, Chroma). Rejected for the
same reason as Redis in [ADR-0002](0002-pg-boss-not-redis.md): another service
to install, supervise and back up on a VM where Docker was ruled out. It also
splits the transaction boundary — a precedent and its embedding would no longer
commit together.

**In-process brute force in Node.** Load every candidate vector and compute
cosine in JavaScript. Rejected: it moves gigabytes over the wire on every
query, and Postgres is far better at scanning a table than the application is.

**Approximate search via `pg_trgm` or LSH buckets on a hash prefix.**
Rejected as premature: it adds a tuning surface and an accuracy cliff to solve
a problem that only exists above a scale no current tenant is near.
