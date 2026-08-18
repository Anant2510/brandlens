# 0004 — Shared-schema multi-tenancy enforced by RLS

**Status** Accepted · **Date** 2026-02-11 · **Deciders** Platform

## Context

BrandLens is multi-tenant. A tenant's brand ontology, creative assets and
decision traces are commercially sensitive, and in the regulated segments the
product targets — pharma MLR, financial services, insurance — a cross-tenant
leak is not a bug report, it is the end of the relationship.

Three standard options: a database per tenant, a schema per tenant, or a shared
schema with a tenant column. The deployment target is a single Windows VM,
often with fewer than fifty tenants, sometimes with exactly one.

Whatever the isolation mechanism, the risk is the same: application code that
forgets a `WHERE org_id = ?`. There are 38 tenant-scoped tables and dozens of
query sites. Relying on discipline across all of them is not a strategy.

## Decision

**Shared schema, `org_id` on every tenant table, isolation enforced by
PostgreSQL row-level security.**

```sql
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands FORCE  ROW LEVEL SECURITY;

CREATE POLICY brands_tenant_isolation ON public.brands
  USING      (brandlens_rls_bypassed() OR org_id = brandlens_current_tenant())
  WITH CHECK (brandlens_rls_bypassed() OR org_id = brandlens_current_tenant());
```

Applied uniformly to all 38 tables by the `DO $$ ... $$` loop in `10_rls.sql`.

Four supporting decisions carry most of the weight:

**1. `SET LOCAL`, never `SET`.** `withTenant()` in `packages/db/src/client.ts`
is the only sanctioned way to run a tenant query, and it uses
`set_config('app.tenant_id', $1, true)` inside an explicit transaction. The
`true` makes the setting transaction-local. A plain `SET` is session-scoped:
with any transaction-pooling proxy — PgBouncer, RDS Proxy, or just a connection
returned to the pool mid-request — the setting outlives the request and the
next tenant to borrow that connection inherits it. That failure is invisible in
single-tenant testing, which is what makes it dangerous.

**2. `FORCE ROW LEVEL SECURITY`.** `ENABLE` alone does not apply policies to
the table's *owner*. Migrations run as the owner and, on a typical single-role
install, so does the application. Without `FORCE`, every policy is present,
correct, and silently bypassed.

**3. One explicit escape hatch.** `app.bypass_rls = 'on'` is used in exactly
four places: migrations, registration (creating an org necessarily precedes the
org existing), API-key resolution (which runs before any tenant context
exists), and the outbox relay (which dispatches across tenants). Each is a
named method on `TenantRepository`, so the escape hatch is greppable rather
than ambient.

**4. Append-only tables are append-only at the grant level.**

```sql
REVOKE UPDATE, DELETE ON public.decision_traces FROM PUBLIC;
REVOKE UPDATE, DELETE ON public.audit_log       FROM PUBLIC;
```

**Bespoke policies.** `channel_specs` and `result_cache` additionally admit
`org_id IS NULL` for reads — the shipped global registry — while `WITH CHECK`
still requires the tenant's own id for writes. A tenant override shadows a
shipped spec without being able to corrupt it for anyone else.

## Consequences

**Good**

- A forgotten `WHERE org_id = ?` returns zero rows instead of another tenant's
  data. The database, not the developer, is the last line of defence.
- One database, one connection pool, one migration run, one backup. On a
  single-VM deployment that is a very large operational simplification.
- Cross-tenant analytics (platform-level usage, aggregate rule health) are a
  normal query behind an audited bypass, not a fan-out over N databases.
- Every index leads with `org_id`, so the tenant predicate the policy adds is
  index-supported rather than a filter applied after the fact.

**Costs**

- RLS is not free. Every query gains a predicate; on large scans it is a few
  percent. Measurable, and worth it.
- A connection that forgets to set `app.tenant_id` sees nothing at all. That is
  the correct failure direction, but it makes "no rows returned" ambiguous
  during debugging. `withTenant` existing as the only entry point is what keeps
  this rare.
- A `DELETE FROM organizations` cascades across every tenant table. Backups and
  the `deleted_at` soft-delete convention matter more than they would with
  physical separation.
- Noisy-neighbour effects are real. A tenant running a 50 000-asset backfill
  competes for buffers with everyone else. Mitigated by `COST_TENANT_DAILY_USD_LIMIT`
  and by queue concurrency limits, not eliminated.
- The largest residual risk is a *policy* mistake rather than an application
  mistake: a table added without RLS. `10_rls.sql` enumerates tables
  explicitly and `RAISE NOTICE`s on any it cannot find, so adding a table
  without adding it to the list is visible in the migration output — but it
  still requires someone to read it.

## Alternatives

**Database per tenant.** The strongest isolation. Rejected: N migration runs, N
connection pools, N backup jobs, and on a single Windows VM with 50 tenants it
is 50 databases to keep in lockstep. Onboarding becomes a provisioning workflow
rather than an INSERT.

**Schema per tenant.** Middle ground. Rejected: `search_path` juggling is its
own footgun (and has the same session-versus-transaction hazard as `SET`),
Drizzle's schema-as-TypeScript assumes one schema, and cross-tenant queries
become dynamic SQL over `information_schema`.

**Application-level filtering only.** Simplest, fastest, and one missed
predicate away from a breach. Rejected on the strength of exactly that
sentence.

**RLS with a per-tenant database role.** Genuinely stronger — `SET ROLE` instead
of `set_config`, and the policy keys on `current_user`. Rejected: it requires
creating a role per tenant (a DDL operation on the signup path), and connection
pooling across roles is substantially harder. Revisit if a tenant ever requires
role-level separation for compliance.
