# Contributing to BrandLens

## Getting set up

```bash
git clone <repo> brandlens && cd brandlens
cp .env.example .env

# PostgreSQL. Either a local install, or:
docker compose -f infra/docker/docker-compose.yml up -d

pnpm install
pnpm db:migrate && pnpm db:seed

cd apps/engine
python -m venv .venv
./.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cd ../..
```

Then four terminals:

```bash
pnpm dev:api       # :4000
pnpm dev:worker
pnpm dev:web       # :3000
cd apps/engine && ./.venv/bin/python -m uvicorn brandlens_engine.main:app --reload   # :8000
```

Sign in with `owner@northwind.test` / `BrandLens!2026`.

On Windows, `infra/windows/bootstrap.ps1` does all of the above.

---

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format

cd apps/engine
./.venv/bin/pytest
./.venv/bin/ruff check .
./.venv/bin/mypy brandlens_engine
```

---

## Repository layout

| Path | What lives here |
|---|---|
| `apps/api` | NestJS control plane: tenancy, ontology CRUD, orchestration, scoring, audit |
| `apps/worker` | pg-boss handlers, the outbox relay, reconciliation |
| `apps/web` | Next.js console |
| `apps/engine` | Python analysis engine. **Stateless** — no database, no tenancy |
| `packages/contracts` | zod schemas. The single source of truth for API, engine and client |
| `packages/db` | Drizzle schema, migrations, RLS policies, the demo seed |
| `infra/windows` | The supported production path |
| `docs/` | Architecture, API, data model, deployment, operations, product, ADRs |

---

## Things that will get a pull request rejected

These are not style preferences. Each one corresponds to a decision with a
recorded rationale, and breaking it breaks a property the product depends on.

### 1. Querying tenant data without `withTenant`

```ts
// NO — bypasses RLS entirely
const rows = await db.select().from(brands);

// YES
const rows = await repo.runAs(orgId, userId, (tx) => tx.select().from(brands));
```

`withTenant` opens a transaction and uses `set_config(..., true)` — `SET
LOCAL`. A plain `SET` is session-scoped and leaks across pooled connections.
See [ADR-0004](docs/adr/0004-shared-schema-rls.md).

### 2. Adding a tenant table without RLS

Every new tenant-scoped table needs `org_id`, an entry in the `tenant_tables`
array in `packages/db/src/sql/10_rls.sql`, and an index that **leads with
`org_id`**.

### 3. Making a hash function impure

Everything in `apps/api/src/common/hash.ts` is a pure function of its inputs.
Introducing a timestamp, a uuid or anything order-dependent means the cache
misses forever and the audit trail stops being reproducible.
See [ADR-0007](docs/adr/0007-content-addressed-job-keys.md).

If you change what a hash covers, bump `PIPELINE_VERSION`.

### 4. Letting a model produce a score

Models answer binary or small-ordinal rubric leaves. Arithmetic produces the
number. See [ADR-0006](docs/adr/0006-deterministic-scoring.md).

### 5. Auto-activating a machine-derived rule

Every extracted or induced rule lands as `proposed` and becomes `active` only
through an explicit human action that is recorded.
See [ADR-0008](docs/adr/0008-rules-land-as-proposed.md).

### 6. Adding a VLM call for something measurable

If it can be parsed or computed, it belongs in T0 or T1. Check
`registry.py` before adding a `vlm.*` analyzer, and be ready to explain in the
PR why the question is genuinely semantic.
See [ADR-0005](docs/adr/0005-tiered-checks.md).

### 7. Requiring pgvector

The `real[]` path must keep working. Any query that uses `vec_p` needs a
fallback. See [ADR-0003](docs/adr/0003-pgvector-optional.md).

### 8. A non-idempotent job handler

pg-boss delivers at least once and **will** invoke your handler twice. A
handler that re-bills a check run or double-posts a webhook is a real bug, not
a theoretical one.

### 9. A Python dependency that builds from source

Every pin in `apps/engine/requirements.txt` must resolve to a prebuilt
`win_amd64` wheel. The target VM has no compiler toolchain. If pip starts
building, pin the previous version and open an issue — do not tell operators
to install Visual Studio Build Tools.

### 10. Documentation that describes intent rather than behaviour

`docs/` describes what the code does. If you change behaviour, change the doc
in the same PR. Aspirational documentation is worse than none.

---

## Adding a check

Four steps.

**1. The analyzer** (`apps/engine/brandlens_engine/<dimension>.py`). Signature
is always `(ctx, rule) -> CriterionResult`, which is what lets the control
plane add a rule without an engine deploy.

```python
def check_min_size(ctx: AnalysisContext, rule: RuleDefinition) -> CriterionResult:
    params = rule.check.params
    minimum = float(params.get("minWidthPx", 120))
    detection = ctx.logo_detection()
    if detection is None:
        # Not a failure. The rule could not be evaluated, and saying so is
        # the whole reason `insufficient_evidence` exists.
        return build_result(rule, "insufficient_evidence",
                            observation="No logo detected")
    return build_result(
        rule,
        "pass" if detection.width_px >= minimum else "fail",
        measured={"renderedWidthPx": detection.width_px},
        threshold={"minWidthPx": minimum},
        bbox=detection.bbox,
    )
```

**2. Register it** in `apps/engine/brandlens_engine/registry.py`, in **both**
`ANALYZERS` and `ANALYZER_TIERS`. The tier in `ANALYZER_TIERS` is the truth;
`effective_tier()` takes the stricter of it and whatever the rule declares.

**3. Test it** in `apps/engine/tests/`. A pass case, a fail case, and an
insufficient-evidence case. The third is the one that gets forgotten and the
one that matters.

**4. Seed a rule that uses it**, in
`packages/db/src/seed/data/rules.ts`, so the demo tenant exercises it.

---

## Adding a database table

```bash
# 1. Edit packages/db/src/schema/<module>.ts
# 2. Add it to the tenant_tables array in packages/db/src/sql/10_rls.sql
# 3. Generate and apply
pnpm db:generate
pnpm db:migrate
# 4. Document it in docs/data-model.md, including the ER diagram
```

Checklist:

- `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
- every index leads with `org_id`
- `created_at`/`updated_at` as `timestamptz`
- append-only? Add the `REVOKE UPDATE, DELETE` to `10_rls.sql`

---

## Adding an API endpoint

1. The zod schema goes in `packages/contracts/src/api.ts` — never a
   controller-local shape.
2. Controller method with `@ApiOperation`, `@Scopes(...)` or `@Roles(...)`.
3. Business logic in the service; controllers stay thin.
4. Every tenant query through `TenantRepository`.
5. Emit an outbox event if the change is externally interesting.
6. Write an `audit_log` entry if a human would ever ask "who did that".
7. Document it in `docs/api.md` with a working `curl`.

---

## Migrations

Forward-only and additive. There is no down migration; rolling back means
restoring a backup.

For a breaking change, use the expand/contract pattern:

1. add the new column, nullable;
2. deploy code that writes both and reads the old;
3. backfill;
4. deploy code that reads the new;
5. drop the old, in a **later** release.

`packages/db/src/sql/*.sql` must stay idempotent — `pnpm db:migrate` runs on
every deploy.

---

## Commit and PR conventions

Conventional commits:

```
feat(api): add POST /v1/checks/batch
fix(engine): handle CMYK PDFs without an ICC profile
docs(adr): supersede 0003 now that pgvector ships a Windows binary
chore(deps): bump drizzle-orm to 0.36.5
```

A pull request should say what changed, **why**, and what you did to convince
yourself it works. If it touches scoring, hashing, RLS or the tier model, say
which ADR it is consistent with — or propose superseding it.

---

## Writing an ADR

If a decision would be expensive to reverse, write one. Template and index:
`docs/adr/README.md`.

Four sections: **Context** (what forced a choice), **Decision** (what you
chose, plainly), **Consequences** (what it buys *and* what it costs — both
sides, honestly), **Alternatives** (what else was considered and why it lost).

Do not edit an accepted ADR to reflect a new decision. Write a new one that
supersedes it. The value is in the record of what was believed at the time.

---

## Reporting a security issue

Do **not** open a public issue. Email `security@brandlens.example` with a
description, reproduction steps and the affected version. Expect an
acknowledgement within two business days.

Particularly interested in: cross-tenant data access, RLS bypass, path
traversal in storage keys, and authentication or signature-verification
weaknesses.
