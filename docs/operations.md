# BrandLens — Operations

Day-2: what to watch, what to alert on, what to do when it breaks, and how to
keep the cost curve flat.

**Contents**

1. [The metrics that matter](#1-the-metrics-that-matter)
2. [Monitoring](#2-monitoring)
3. [Alert thresholds](#3-alert-thresholds)
4. [Scaling levers](#4-scaling-levers)
5. [Cost control](#5-cost-control)
6. [Backup and restore drill](#6-backup-and-restore-drill)
7. [Incident runbook](#7-incident-runbook)
8. [Routine maintenance](#8-routine-maintenance)

---

## 1. The metrics that matter

Six numbers. Everything else is diagnostic detail for when one of these moves.

### 1.1 Job age p95

**Time from enqueue to completion, 95th percentile.**

The single best indicator of whether the system is keeping up. It rises before
anything visibly breaks, and it rises for every possible reason — worker down,
engine slow, provider throttling, database contention — which makes it the
right first alarm.

```sql
SELECT
  name,
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (COALESCE(completed_on, now()) - created_on))
  ) AS p95_seconds,
  count(*) FILTER (WHERE state = 'created') AS waiting,
  count(*) FILTER (WHERE state = 'active')  AS running,
  count(*) FILTER (WHERE state = 'failed')  AS failed
FROM brandlens_queue.job
WHERE created_on > now() - interval '1 hour'
GROUP BY name
ORDER BY p95_seconds DESC;
```

Healthy: `analyze.asset` p95 under 90 seconds; `ingest.asset` under 30.

### 1.2 Cache hit ratio

**`cache_hits / (cache_hits + cache_misses)` across check runs.**

Directly proportional to margin. Target **> 60%**. A sudden drop is almost
always self-inflicted: a ruleset republished for a cosmetic reason, a
`PIPELINE_VERSION` bump, a model swap, or someone using `force: true` in a loop.

```sql
SELECT
  date_trunc('day', created_at) AS day,
  sum(cache_hits)::float / NULLIF(sum(cache_hits + cache_misses), 0) AS hit_ratio,
  count(*) AS runs,
  round(sum(cost_usd)::numeric, 2) AS cost_usd
FROM check_runs
WHERE created_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

Also exposed at `GET /v1/analytics/cost`.

### 1.3 Human override rate, per rule

**The share of a rule's findings a human overturned.**

This is the best product-health metric in the system. A rule with a 40%
override rate is not helping — it is generating work and eroding trust. It is
also the metric that tells you *which* rule to fix, which no aggregate score
can.

```sql
SELECT
  rd.rule_key,
  count(*) AS decisions,
  count(*) FILTER (WHERE rd.action IN ('override_pass','override_fail')) AS overrides,
  round(
    count(*) FILTER (WHERE rd.action IN ('override_pass','override_fail'))::numeric
    / NULLIF(count(*), 0), 3
  ) AS override_rate
FROM review_decisions rd
WHERE rd.created_at > now() - interval '30 days'
GROUP BY rd.rule_key
HAVING count(*) >= 5
ORDER BY override_rate DESC;
```

`GET /v1/analytics/rule-health` returns this joined to the calibration state.

Response ladder:

| Override rate | Meaning | Action |
|---|---|---|
| < 10% | Working | Nothing |
| 10-25% | Threshold drift | Let calibration adjust; watch it |
| 25-40% | The rule means something different to this customer | Rewrite the statement or the rubric; add precedents |
| > 40% | The rule is wrong for this tenant | Deprecate it, or set `auto_route_to_human` |

### 1.4 Per-rule agreement and beta

**Agreement rate**: how often the human confirmed the machine.
**Beta**: the slope of the logistic fit of `P(human rejects | machine
confidence)`.

Beta is the one that matters operationally. `|beta| < 0.3` means the machine's
confidence carries essentially no information about what these reviewers will
accept — the model is not measuring what these humans mean by this rule. The
rule is then routed 100% to human review.

```sql
SELECT DISTINCT ON (rule_key)
  rule_key, beta, agreement_rate, cohens_kappa, ece,
  sample_size, auto_route_to_human, created_at
FROM rule_calibrations
ORDER BY rule_key, created_at DESC;
```

A rule with a *high* agreement rate and a *low* beta is the interesting case:
the machine agrees with humans, but not for reasons its confidence tracks. That
usually means the rule is nearly always `pass` and the fit has no signal, which
is fine — check `sample_size` before acting.

### 1.5 Coverage rate

**The share of criteria the machine settled without a human.**

The headline customer-facing number: it is what "this saves us time" means
numerically. Abstentions are the entire point of its denominator.

```sql
SELECT
  date_trunc('week', created_at) AS week,
  round(avg(coverage_rate)::numeric, 4) AS avg_coverage,
  round(avg(score)::numeric, 2)         AS avg_score,
  count(*) FILTER (WHERE score_band = 'pass') AS passed,
  count(*)                                     AS runs
FROM check_runs
WHERE status IN ('completed','degraded') AND created_at > now() - interval '90 days'
GROUP BY 1 ORDER BY 1;
```

Healthy: **> 85%** and rising as calibration and precedents accumulate.
Falling coverage with stable volume means rules are being auto-routed to
humans — check 1.4.

### 1.6 Cost per asset

```sql
SELECT
  date_trunc('day', cr.created_at) AS day,
  count(DISTINCT cr.asset_id)      AS assets,
  round(sum(cr.cost_usd)::numeric, 2) AS total_usd,
  round((sum(cr.cost_usd) / NULLIF(count(DISTINCT cr.asset_id), 0))::numeric, 4) AS usd_per_asset
FROM check_runs cr
WHERE cr.created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;
```

Healthy: **\$0.03-\$0.10 per asset** on a forty-criterion ruleset with the
cache warm. Above \$0.25 something is wrong — usually a cold cache, a
misconfigured `JUDGE_SELF_CONSISTENCY_K`, or a ruleset with too many T2 rules.

Which rules are spending the money:

```sql
SELECT rule_key, count(*) AS evaluations,
       round(sum(cost_usd)::numeric, 2) AS total_usd,
       round(avg(cost_usd)::numeric, 5) AS avg_usd
FROM decision_traces
WHERE created_at > now() - interval '7 days' AND cost_usd > 0
GROUP BY rule_key ORDER BY total_usd DESC LIMIT 20;
```

---

## 2. Monitoring

### Prometheus

`GET /metrics` is text exposition, `Public` so a scraper needs no credentials —
which is exactly why the Caddyfile restricts it by source IP. It exposes
per-tenant job counts and cost totals.

```yaml
scrape_configs:
  - job_name: brandlens
    scrape_interval: 30s
    static_configs:
      - targets: ['brandlens.internal:4000']
```

### Health probes

| Endpoint | Use |
|---|---|
| `GET /health` | Liveness. **Dependency-free** — a stuck database must not make the process look dead. |
| `GET /health/deep` | Readiness. Database, queue, storage, engine, vector driver, outbox depth, provider configuration, each with the failure detail rather than a bare `false`. |

```powershell
schtasks /create /tn "BrandLens health" /sc minute /mo 5 /ru SYSTEM `
  /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\brandlens\infra\windows\healthcheck.ps1 -Quiet"
```

`healthcheck.ps1` exits non-zero when any required check fails, so it plugs
into any monitor that reads exit codes. `-Json` gives a machine-readable object.

### Logs

JSON lines everywhere — pino for Node, structlog for Python. A correlation id
is generated per request, echoed as `x-correlation-id`, propagated to the
engine as `x-request-id` and carried through queue payloads, so one id follows
a request across all four processes.

```powershell
.\infra\windows\logs.ps1 -Grep '<correlation-id>'
```

Ship them with Promtail, Vector or the Grafana Agent if you have somewhere to
ship to; they are already structured.

### The dashboard worth building

Six panels, in this order:

1. Job age p95 by queue (time series)
2. Cache hit ratio (time series, with a 60% reference line)
3. Cost per asset, last 30 days (time series)
4. Coverage rate (time series, with an 85% reference line)
5. Top 10 rules by override rate (table)
6. `/health/deep` component status (stat panel)

---

## 3. Alert thresholds

| # | Alert | Condition | Severity | First action |
|---|---|---|---|---|
| 1 | API down | `/health` fails twice in a row | **page** | `status.ps1`; `pm2 restart brandlens-api` |
| 2 | Any dependency degraded | `/health/deep` returns `degraded` for 5 min | **page** | Read `components`; the failing one names itself |
| 3 | Job age p95 high | `analyze.asset` p95 > 300 s for 10 min | **page** | Worker up? Engine healthy? Provider throttling? |
| 4 | Queue backlog | `state='created'` > 500 for 15 min | warn | Raise `QUEUE_CONCURRENCY_LLM` or worker `instances` |
| 5 | Job failure rate | > 10% failed in an hour | **page** | `logs.ps1 -Process worker -Errors` |
| 6 | Cache hit ratio collapsed | < 40% for 6 h (was > 60%) | warn | Ruleset churn? `PIPELINE_VERSION` bump? `force: true` in a loop? |
| 7 | Cost spike | Daily spend > 2× the 7-day mean | warn | `GET /v1/analytics/cost`; check `JUDGE_SELF_CONSISTENCY_K` |
| 8 | Budget ceiling hit | `budget.threshold_crossed` event | warn | Expected under load; raise the ceiling or investigate |
| 9 | Override rate spiking | Any rule > 40% over 20+ decisions | warn | The rule is wrong for this tenant. See §1.3 |
| 10 | Rule auto-routed | `auto_route_to_human` flips true | info | Expected behaviour. Track how many rules are in this state |
| 11 | Outbox backing up | `pending` > 1 000 for 10 min | **page** | Relay running? Endpoint dead? Check `webhook_deliveries` |
| 12 | Engine breaker open | `/health/deep` → `engine.breaker = open` | **page** | `logs.ps1 -Process engine -Errors` |
| 13 | Disk | Free space < 15% | **page** | Expire derivatives; check `.storage` and `logs` |
| 14 | Connections | `pg_stat_activity` > 80% of `max_connections` | warn | Lower `DATABASE_POOL_MAX`, or raise `max_connections` |
| 15 | Backup missed | No new folder in 26 h | **page** | Check the scheduled task and the destination disk |
| 16 | Coverage falling | 7-day mean < 70% | warn | How many rules are auto-routed? Judge configured? |
| 17 | Replication of vector scans | `embeddings` > 250k rows, fallback driver | info | Consider installing pgvector |

Alerts 1-3, 5, 11-13 and 15 wake someone. The rest wait for morning.

---

## 4. Scaling levers

Pull them in this order. Each is cheaper and less disruptive than the next.

### 4.1 Improve the cache hit ratio

The cheapest capacity is work you do not do.

- **Stop republishing rulesets for cosmetic reasons.** The hash covers only
  semantic fields, so a label edit is already free — but activating one rule
  invalidates that rule's traces on every asset.
- **Use variant families.** A master with resized derivatives runs the
  expensive semantic checks **once** on the master; per-variant only geometry
  and channel-spec checks run. For ad production this alone cuts VLM spend by
  10-20×.
- **Use `deterministicOnly: true` in agent inner loops** and reserve the full
  check for the final candidate.

### 4.2 Worker concurrency

```ini
QUEUE_CONCURRENCY_LLM=24      # bound by provider latency, not by CPU
QUEUE_CONCURRENCY_CPU=8       # keep at or below vCPU count
```

`llm_io` work is waiting on a remote call, so high concurrency is cheap and
correct. `cpu_media` is not — raising it past the core count just adds context
switching.

```powershell
pm2 restart brandlens-worker
```

### 4.3 Worker instances

```ini
WORKER_INSTANCES=3
```

```powershell
pm2 delete brandlens-worker
pm2 start C:\brandlens\infra\windows\ecosystem.config.cjs --only brandlens-worker
pm2 save
```

Each instance registers all twelve queues; pg-boss distributes with
`FOR UPDATE SKIP LOCKED`, so two instances never take the same job. Watch
`DATABASE_POOL_MAX` — each instance opens its own pool.

### 4.4 Engine instances

The engine is stateless, so more copies are safe. PM2 cannot load-balance
non-Node processes, so this means distinct ports plus Caddy in front:

```
reverse_proxy 127.0.0.1:8000 127.0.0.1:8001 {
    lb_policy least_conn
    health_uri /health
}
```

Point `ENGINE_URL` at Caddy. Do **not** raise uvicorn's own `--workers`: PM2
cannot see the forked children, so a hung child would never be restarted and
`pm2 status` would lie about the process count.

### 4.5 PostgreSQL

```ini
# postgresql.conf, for a 16 GB VM
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 32MB
maintenance_work_mem = 512MB
max_connections = 200
random_page_cost = 1.1          # SSD
```

The queue tables churn; make sure autovacuum keeps up:

```sql
SELECT relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

### 4.6 Install pgvector

Only worth it above roughly 250 000 embeddings per tenant, where the sequential
scan starts pushing the embeddings table out of shared buffers and hurting
everything else. See [deployment-windows.md §5](deployment-windows.md#5-database).

### 4.7 Split the host

The last resort. The natural seam is the engine — it is stateless and has no
database. Move it first, point `ENGINE_URL` at the new host, and keep the
shared secret on a private network segment.

---

## 5. Cost control

### The guard rails

```ini
COST_TENANT_DAILY_USD_LIMIT=25    # platform default
COST_JOB_USD_LIMIT=2.5            # per check run
COST_DEGRADE_GRACEFULLY=true      # degrade rather than fail
```

Per-tenant overrides live on `organizations.daily_usd_limit`.

`budget_allows_t2()` forecasts from observed cost per call rather than waiting
until the budget is drained — waiting lets a run overshoot its ceiling by a
whole criterion, which is precisely what the ceiling exists to prevent. The
first T2 call is always permitted, because token pricing varies by an order of
magnitude across the models a tenant may configure and refusing to start means
never learning what a call actually costs here.

### The levers, in order of leverage

**1. Prompt caching.** `JUDGE_ENABLE_PROMPT_CACHE=true`. The brand context is
large and identical across criteria for the same asset. This is usually a
70-90% reduction in input-token cost, and it is on by default.

**2. Self-consistency.** `JUDGE_SELF_CONSISTENCY_K=1` for normal criteria,
escalating to `JUDGE_SELF_CONSISTENCY_ESCALATE_K=3` only on ambiguous ones.
Setting `K=3` globally triples the T2 bill for a marginal precision gain.

**3. Image size.** `JUDGE_MAX_IMAGE_EDGE=1568`. Larger images cost more tokens
and rarely change the verdict — the judge is answering a bounded rubric
question, not appreciating the composition.

**4. Crop to the question.** Rules with `rubric.cropTo: logo | text | region`
send a fraction of the pixels. Cheaper *and* more accurate, because the model
is not distracted by the rest of the canvas.

**5. Audit the tier mix.**

```sql
SELECT r.tier, count(*) AS rules
FROM rules r
WHERE r.status = 'active' AND r.brand_id = '<brand>'
GROUP BY r.tier;
```

If more than about 20% of active rules are `vlm`, most of them can probably be
expressed deterministically. That is the biggest single cost win available.

**6. Cheaper judge for cheap rules.** `LLM_JUDGE_MODEL` is per-tenant
overridable via `organizations.settings`. A small model is often adequate for
binary rubrics with strong precedents.

### Where the money went

```sql
SELECT provider, model, operation,
       count(*) AS calls,
       round(sum(cost_usd::numeric), 2) AS usd,
       round(avg(cached_input_tokens::numeric / NULLIF(input_tokens::numeric, 0)), 3) AS cache_frac
FROM cost_ledger
WHERE created_at > now() - interval '7 days'
GROUP BY 1,2,3 ORDER BY usd DESC;
```

---

## 6. Backup and restore drill

**An untested backup is a hypothesis.** Run this quarterly on a spare VM and
write down the elapsed time — that number is your real RTO.

### What is backed up

| | How | Where |
|---|---|---|
| PostgreSQL | `pg_dump -Fc -Z6 --no-owner --no-privileges` | `backups\<stamp>\brandlens-<stamp>.dump` |
| Storage | Incremental copy (skips existing files of the same size) | `backups\<stamp>\storage\` |
| Manifest | Schema version, pgvector state, row counts, dump role, RLS mode | `backups\<stamp>\manifest.json` |

### Why `pg_dump -U brandlens` does not just work

Every tenant table carries `FORCE ROW LEVEL SECURITY`, which applies policies
even to the table's owner. `pg_dump` connects with `row_security = off` and,
rather than silently dumping a subset, **aborts**:

```
pg_dump: error: query failed: ERROR:  query would be affected by
                              row-level security policy for table "api_keys"
```

That abort is a feature — a backup that silently omitted every tenant row
would be far worse. There are two correct ways to take the dump, and
`backup.ps1` implements both:

| Mode | How | When |
|---|---|---|
| `app.bypass_rls` (default) | `PGOPTIONS='-c app.bypass_rls=on'` plus `--enable-row-security`, so every policy's `USING` clause evaluates true | No extra credentials needed |
| `superuser` | `.\backup.ps1 -DumpUser postgres` — superusers have `BYPASSRLS` natively | You would rather not depend on the escape hatch |

The default path is only safe if the bypass genuinely works: with
`--enable-row-security` and **no** bypass, `pg_dump` succeeds and writes a
silently incomplete backup. So `backup.ps1` **verifies**
`SELECT brandlens_rls_bypassed()` before dumping and refuses to continue if it
cannot confirm it. `manifest.json` records which mode was used.

The same applies to any ad-hoc dump you take by hand:

```powershell
$env:PGPASSWORD = '<password>'
$env:PGOPTIONS  = '-c app.bypass_rls=on'
pg_dump -h localhost -U brandlens -d brandlens -Fc --enable-row-security `
        --no-owner --no-privileges -f manual.dump
```

Restoring needs no special handling: `pg_restore` runs the DDL and the
`COPY`s as the owner, and the RLS policies come back with the schema.

`.env` is **not** backed up — it contains secrets. Store it in your secret
manager and keep a sealed copy somewhere you can reach during an incident.

### The drill

```powershell
# --- 1. Take a fresh backup on production
C:\brandlens\infra\windows\backup.ps1 -Destination D:\backups\brandlens

# --- 2. On a CLEAN VM: bootstrap only
.\infra\windows\bootstrap.ps1
.\infra\windows\setup-database.ps1 -SkipMigrate -SkipSeed
.\infra\windows\setup-python.ps1

# --- 3. Restore the database
$env:PGPASSWORD = '<password>'
pg_restore --clean --if-exists --no-owner -h localhost -U brandlens -d brandlens `
  "D:\backups\brandlens\2026-08-17T0230\brandlens-2026-08-17T0230.dump"

# --- 4. Restore storage
Copy-Item "D:\backups\brandlens\2026-08-17T0230\storage\*" C:\brandlens\.storage -Recurse -Force

# --- 5. Copy .env from the secret manager, then build and start
pnpm install --frozen-lockfile
pnpm build
.\infra\windows\start-all.ps1
```

### Verify — do not skip this

```powershell
# Row counts must match manifest.json
Get-Content "D:\backups\brandlens\2026-08-17T0230\manifest.json" | ConvertFrom-Json | Select-Object -Expand counts

$env:PGPASSWORD = '<password>'
# PGOPTIONS is required: with no tenant bound, RLS filters every row and
# these counts all read 0 — which looks like a failed restore.
$env:PGOPTIONS = '-c app.bypass_rls=on'
psql -h localhost -U brandlens -d brandlens -c "
  SELECT (SELECT count(*) FROM organizations)   AS orgs,
         (SELECT count(*) FROM assets)          AS assets,
         (SELECT count(*) FROM check_runs)      AS runs,
         (SELECT count(*) FROM decision_traces) AS traces;"
Remove-Item Env:PGOPTIONS
```

Then confirm the isolation survived the restore — 40 tables with RLS both
enabled and forced, and zero rows visible without a tenant bound:

```powershell
psql -h localhost -U brandlens -d brandlens -tAc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity;"
psql -h localhost -U brandlens -d brandlens -tAc "SELECT count(*) FROM assets;"   # expect 0
```

```powershell
.\infra\windows\healthcheck.ps1

# Sign in, open a historical check run, confirm the asset preview renders.
# That last step is the one that catches a storage restore that silently
# missed files: the database will look perfect either way.
```

### Targets

| | Target | How |
|---|---|---|
| **RPO** | 24 h | Nightly backup. For lower, add WAL archiving. |
| **RTO** | 2 h | Prepared VM + this runbook. Measure it; do not assume it. |

Lower RPO means continuous archiving:

```ini
# postgresql.conf
archive_mode = on
archive_command = 'copy "%p" "D:\\wal-archive\\%f"'
```

---

## 7. Incident runbook

### 7.1 Everything is down

```powershell
.\infra\windows\status.ps1
.\infra\windows\healthcheck.ps1
```

**Triage in dependency order — each layer depends on the ones above it.**

1. **PostgreSQL.** `Get-Service postgresql*`. If down, start it; check the disk
   first, because a full disk is the usual reason it stopped.
2. **The PM2 daemon.** `pm2 list`. Empty → `PM2_HOME` mismatch (see
   [deployment-windows.md §15](deployment-windows.md#15-troubleshooting)) or the
   service is not running.
3. **Individual processes.** `pm2 describe <name>` for the exit reason;
   `logs.ps1 -Process <name> -Errors`.
4. **The engine.** Most likely to be memory-killed. `pm2 restart
   brandlens-engine` and look at `max_memory_restart`.

If nothing obvious: `.\stop-all.ps1; .\start-all.ps1`. If that fixes it, find
out why before you go back to bed.

### 7.2 Checks are queued but never run

```sql
SELECT name, state, count(*)
FROM brandlens_queue.job
WHERE created_on > now() - interval '1 hour'
GROUP BY 1,2 ORDER BY 1,2;
```

| Symptom | Cause | Fix |
|---|---|---|
| Many `created`, none `active` | Worker down or not subscribed | `pm2 restart brandlens-worker`; check `handler registered` lines at boot |
| Many `active`, none completing | Engine hung or provider timing out | `logs.ps1 -Process engine`; check `ENGINE_TIMEOUT_MS` |
| Many `failed` | Handler throwing | `logs.ps1 -Process worker -Errors`; read the stack |
| Runs stuck in `running` with no job | Handler `SIGKILL`ed | `platform.reconcile` recovers within 5 minutes |

### 7.3 Cost spike

```sql
SELECT date_trunc('hour', created_at) AS hour,
       round(sum(cost_usd::numeric), 2) AS usd, count(*) AS calls
FROM cost_ledger
WHERE created_at > now() - interval '48 hours'
GROUP BY 1 ORDER BY 1 DESC;
```

Then: which rule (query in §1.6), and which tenant.

**Immediate mitigation** — lower the ceiling and reload:

```ini
COST_TENANT_DAILY_USD_LIMIT=5
```

```powershell
pm2 reload C:\brandlens\infra\windows\ecosystem.config.cjs
```

Runs will degrade rather than fail, so deterministic findings still ship.

Common root causes, in order of frequency: a cold cache after a ruleset
republish; `force: true` in a caller's loop; `JUDGE_SELF_CONSISTENCY_K` raised
globally; a newly activated batch of `vlm`-tier rules.

### 7.4 Reviewers say the findings are wrong

This is the most important incident class in the product, and it is not an
outage.

```sql
-- Which rules are being overturned? (query in §1.3)
```

1. Identify the offending rules by override rate.
2. Read three or four of the reviewer **rationales**. They almost always say
   exactly what is wrong, in plain language.
3. Then choose:
   - the *rule statement* is ambiguous → rewrite it and bump the version;
   - the *rubric* asks the wrong question → rewrite the rubric;
   - the *threshold* is wrong → let calibration adjust, or set it explicitly;
   - the rule *does not apply to this tenant* → deprecate it;
   - the judge simply cannot do it → set `auto_route_to_human` and stop
     pretending.

Do not respond by lowering the display-confidence threshold. Hiding
low-confidence findings makes the dashboard look better and the product worse.

### 7.5 Webhooks are not arriving

```sql
SELECT status, count(*) FROM outbox_events
WHERE created_at > now() - interval '1 hour' GROUP BY 1;
```

```bash
curl -s "$API/v1/webhooks/$ENDPOINT/deliveries" -H "Authorization: Bearer $JWT" | jq '.[0:5]'
```

- `pending` growing → the relay is not running. `pm2 restart brandlens-worker`.
- `failed` with 4xx → the consumer is rejecting. Almost always signature
  verification: sign `timestamp.rawBody`, using the **raw** bytes, and compare
  in constant time. See [api.md §12](api.md#12-webhooks).
- `dead` → exceeded `WEBHOOK_MAX_ATTEMPTS`. Fix the consumer, then replay by
  resetting `status` and `next_attempt_at`.
- Nothing at all → no endpoint matches the event type. Nobody listening is a
  *successful* dispatch, not a failure.

### 7.6 Disk full

```powershell
Get-ChildItem C:\brandlens\.storage -Recurse | Measure-Object -Property Length -Sum
Get-ChildItem C:\brandlens\logs      -Recurse | Measure-Object -Property Length -Sum
```

Reclaim in this order — safest first:

```powershell
pm2 flush                                # truncate logs
```

```sql
-- Derivatives are reproducible from the originals.
DELETE FROM asset_derivatives
WHERE created_at < now() - interval '90 days' AND kind IN ('thumbnail','tile','frame');
```

Then delete the corresponding files from `.storage/derivatives`. Never delete
from `.storage/originals` — those are the assets, and the traces reference
their hashes.

### 7.7 Suspected cross-tenant data exposure

Treat as a security incident.

1. **Verify RLS is actually on.** This is the check that matters:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
ORDER BY 1;
```

Any tenant table appearing here is a hole. `relforcerowsecurity = false` is the
dangerous one: policies exist and are bypassed for the owner.

2. **Look for bypass use.** `grep -rn "bypassRls" apps/`. There should be
   exactly four legitimate sites: migrations, registration, API-key resolution,
   the outbox relay.

3. **Check for session-scoped `SET`.** `grep -rn "set_config" packages/db apps/`
   — every call must pass `true` as the third argument. A plain `SET` leaks
   across pooled connections.

4. Re-run `10_rls.sql`, which is idempotent, and audit
   `audit_log` for the window in question.

---

## 8. Routine maintenance

### Daily (automated)

- Backup — `backup.ps1` at 02:30
- Health probe — `healthcheck.ps1` every 5 minutes
- Outbox relay — every minute (worker cron)
- Reconciler — every 5 minutes (worker cron)

### Weekly (5 minutes)

```powershell
.\infra\windows\status.ps1
```

- Restart counts in `pm2 list`. A process with 40 restarts is telling you
  something.
- Cache hit ratio and cost per asset trend.
- Rules above 25% override rate.
- Backup folder — a real folder, of a plausible size, from last night.

### Monthly

- Windows Update, then reboot, then `healthcheck.ps1`.
- `pnpm audit` and `pip list --outdated`.
- Disk trend — project three months out.
- Review rules with `auto_route_to_human = true`. Have they improved? Should
  they be deprecated?
- Review the audit log for unexpected admin actions.

### Quarterly

- **Restore drill (§6).** Non-negotiable.
- **Channel spec review.** Every platform changes its safe zones two to four
  times a year. Check the `docsUrl` on each row in `channel_specs` and bump the
  `version` field on anything that moved. This is the least glamorous and most
  reliably valuable hour in the calendar.
- Rotate `API_KEY_PEPPER` and `JWT_*` if policy requires it. Rotating the
  pepper invalidates every API key; plan the customer communication.
- Re-read [architecture.md](architecture.md) against the code. Documentation
  that has drifted is worse than none.

### Annually

- PostgreSQL major upgrade. Reinstall pgvector for the new major if you use it,
  then `setup-database.ps1 -SkipSeed`.
- Node LTS upgrade.
- Python minor upgrade, then `setup-python.ps1 -Recreate`.
- Review retention: `decision_traces` at seven years is the regulated default
  and is why the table is large.
