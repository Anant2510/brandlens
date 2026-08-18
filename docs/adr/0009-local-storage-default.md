# 0009 — Local-filesystem storage driver by default

**Status** Accepted · **Date** 2026-02-11 · **Deciders** Platform

## Context

BrandLens stores original creative assets, brand documents, logo files, and
derived artifacts: thumbnails, page rasters, evidence crops, video frames.
Volumes are modest — a busy tenant produces single-digit gigabytes a month —
but the objects are commercially sensitive and some of them are personal data.

The default answer is S3, and in a cloud deployment it is the right one. The
target deployment is a single Windows VM, frequently on-premises, sometimes
air-gapped, and in more than one case at a customer whose procurement process
treats "sends our creative to a third-party object store" as a blocking
question.

MinIO would provide an S3 API locally, but it is another service to install,
supervise, secure and back up on a machine where Docker was already ruled out
as too heavy.

## Decision

**Three drivers behind one `StorageDriver` interface. `local` is the default.**

```
STORAGE_DRIVER=local | s3 | azure
STORAGE_LOCAL_ROOT=./.storage
```

The local driver:

- **Content-addressed layout.**
  `originals/<org_id>/<first 2 hex of sha256>/<sha256>.<ext>`. Sharding on the
  first byte keeps directory sizes sane — on NTFS a single folder with 200 000
  entries turns every `readdir` into a stall. Addressing by hash makes
  deduplication free: the same file uploaded by five people occupies one blob.
- **Signed URLs, served by the API.** HMAC-SHA256 over
  `key|expiry|disposition`, redeemed at `GET /v1/storage/object`. There is no
  static file server to misconfigure and no directory left world-readable on
  the VM.
- **Path-traversal defence.** Every key is normalised, resolved and re-checked
  against the root before use. A storage key is partly caller-influenced —
  asset names end up in it — so `../../` in one would otherwise be an
  arbitrary-file-write primitive.
- **A local path for the engine.** `engineUri()` returns a filesystem path
  rather than a URL, because the engine is on the same host and streaming the
  bytes twice would be pure waste.

Derivatives are keyed by `(asset_id, kind, transform_hash)` so they dedupe and
can be expired aggressively — they are reproducible from the original.

`backup.ps1` copies the storage tree alongside the `pg_dump`, skipping
destination files that already exist at the same size. Because content-addressed
files are immutable once written, that skip is correct by construction and
turns an incremental backup into an O(new files) operation.

## Consequences

**Good**

- Zero additional infrastructure. Install BrandLens, and storage works.
- No creative asset leaves the VM. For several target segments that is not a
  nice-to-have, it is the reason the deal is possible.
- Fast. Local disk beats S3 on latency for the read-heavy derivative workload,
  and the engine reads a path rather than a stream.
- Backup is a file copy. Restore is a file copy. Both are inspectable with
  Explorer, which matters more than it should when someone is debugging at 2am.
- Migration to S3 or Azure is a config change plus a one-time sync, because the
  key layout is driver-independent.

**Costs**

- No redundancy. Disk failure loses the originals. This is the single largest
  operational risk of the default configuration, and it is why
  [operations.md](../operations.md) treats the nightly backup as mandatory
  rather than advisory.
- No horizontal scale. A second application host would need shared storage.
  The interface exists precisely so that the answer is "switch to s3", not
  "rewrite the storage layer".
- Disk fills up. There is no lifecycle policy in the local driver; derivative
  cleanup is a maintenance job rather than a bucket rule.
- The API serves object bytes, so a large download occupies a Node event-loop
  slot. Fine at this scale; it would not be behind a CDN.
- **`STORAGE_LOCAL_ROOT` is resolved relative to `process.cwd()`**, and the
  four processes have four different working directories. The default
  `./.storage` therefore resolves differently for the API (`apps/api`) than for
  the seed (`packages/db`). The seed anchors to the repository root explicitly,
  and the deployment runbook instructs setting an absolute path
  (`C:\brandlens\.storage`) in production. This is the sharpest edge in the
  default configuration and it is called out in
  [deployment-windows.md](../deployment-windows.md).

## Alternatives

**S3 as the default.** Better durability, lifecycle policies, CDN integration,
horizontal scale. Rejected as a *default* because it makes the simplest
deployment depend on a cloud account and an egress path. It is fully supported
and is the right choice for a cloud deployment — `STORAGE_DRIVER=s3`.

**MinIO on the VM.** An S3 API locally, one code path. Rejected: another
service to install, supervise, secure and back up, on a machine where the
customer explicitly rejected Docker. It also adds an HTTP hop to every
derivative read for no benefit on a single host.

**Blobs in PostgreSQL (`bytea` or large objects).** Genuinely attractive for
transactional consistency: an asset and its row would commit together, and one
backup would cover everything. Rejected on bloat. Multi-megabyte blobs in a
table destroy the shared-buffer hit ratio for everything else, and `pg_dump`
times grow with total bytes rather than with row count.

**A pluggable driver with no default.** Force an explicit choice at install.
Rejected: it makes `git clone && pnpm dev` fail, and the first five minutes of
a new contributor's experience are worth more than the configuration purity.
