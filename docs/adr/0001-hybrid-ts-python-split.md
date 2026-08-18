# 0001 — Hybrid TypeScript + Python split

**Status** Accepted · **Date** 2026-02-10 · **Deciders** Platform

## Context

BrandLens has two workloads with almost nothing in common.

The **control plane** is transactions, tenancy, an audit trail, HTTP, a job
queue and a typed contract shared with a web client. It is I/O-bound and its
correctness properties are about isolation and idempotency.

The **analysis engine** is CIELAB colour clustering, perceptual hashing, logo
detection by embedding kNN, contrast arithmetic over OCR spans, PDF and PPTX
span extraction, and vision-model orchestration. It is CPU-bound and its
correctness properties are numerical.

The mature libraries for the second workload — `numpy`, `scipy`,
`scikit-image`, `scikit-learn`, `opencv`, `pymupdf`, `python-pptx`,
`rapidfuzz`, `ImageHash` — are all Python. The mature libraries for the first —
NestJS, Drizzle, zod, pg-boss — are all TypeScript.

A further constraint: the deployment target is a Windows VM with no compiler
toolchain, so every Python dependency has to resolve to a prebuilt
`win_amd64` wheel.

## Decision

Two runtimes, four processes, one repository.

- `apps/api` (NestJS), `apps/worker` (pg-boss), `apps/web` (Next.js) in
  TypeScript.
- `apps/engine` (FastAPI) in Python.
- The contract between them lives in `packages/contracts` as zod schemas, and
  is mirrored by pydantic models in `apps/engine/brandlens_engine/models.py`.

The engine is **stateless**: no database, no tenancy, no persistence. It
receives an asset reference, a brand context and a list of rules; it returns
criterion results, measurements, artifacts and a cost figure. It authenticates
exactly one caller — the control plane — over a shared secret on a loopback
hop.

Every engine dependency is pinned to a version that ships a prebuilt wheel.
`torch`, `paddlepaddle`, `tensorflow`, `dlib` and `pyahocorasick` are
explicitly excluded; the Aho-Corasick matcher is implemented in pure Python in
`copy_checks.py`.

## Consequences

**Good**

- Each workload uses the ecosystem that is actually good at it. Palette
  clustering is twenty lines of `scikit-image`; the same thing in TypeScript
  would be a bespoke implementation nobody wants to own.
- The engine being stateless makes it trivially horizontally scalable and
  trivially testable — `apps/engine/tests` runs with no database at all.
- Tenancy lives in exactly one place. Duplicating it into the engine would
  create a second location for an isolation bug to live.
- No compiler on the target VM. `setup-python.ps1` verifies this by refusing to
  proceed if pip starts building from source.

**Costs**

- Two toolchains to install, two dependency files, two test runners. The
  Windows bootstrap is meaningfully longer for it.
- The contract is defined twice — zod on one side, pydantic on the other — and
  they can drift. Mitigated by `packages/contracts` being the single source of
  truth and by round-trip tests, but not eliminated.
- A process hop on every analysis. On one VM that is loopback HTTP with the
  asset passed as a filesystem path rather than as bytes, so the cost is small,
  but it is not zero.
- Two languages raises the bar for a contributor working across the boundary.

## Alternatives

**All TypeScript.** Would have meant reimplementing CIELAB conversion,
k-means clustering, perceptual hashing and PDF span extraction. `sharp` covers
some image work but needs a native build, which is precisely what the Windows
target rules out. Rejected: worse code producing worse answers.

**All Python.** FastAPI plus SQLAlchemy plus Pydantic is a perfectly good
control plane, but the web console is Next.js and sharing zod contracts with it
is a real, daily benefit. It would also have meant giving up Drizzle's
schema-as-TypeScript, which is what makes the RLS-aware `withTenant` helper
type-safe. Rejected: the loss on the front-end contract outweighed the gain.

**A Python sidecar invoked as a subprocess.** No HTTP hop, no second service to
supervise. Rejected: process spawn per analysis is expensive, streaming large
results over stdio is fragile, and it makes the engine impossible to scale or
test independently.

**Rust for the engine.** Genuinely tempting for the CV work. Rejected: the
brand-compliance domain moves fast and the Python CV ecosystem is where the
algorithms are. A rewrite is available later if profiling ever justifies it.
