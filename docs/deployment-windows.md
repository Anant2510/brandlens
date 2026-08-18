# Deploying BrandLens on Windows

The supported production target is **one Windows Server 2022 or Windows 11 VM,
without Docker**. Everything installs natively. No containers, no Redis, no
MinIO, no WSL2.

Reading time: about ten minutes. Install time on a prepared VM: about thirty.

**Contents**

1. [Sizing](#1-sizing)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [Configure `.env`](#4-configure-env)
5. [Database](#5-database)
6. [Python engine](#6-python-engine)
7. [Build](#7-build)
8. [Run as a service](#8-run-as-a-service)
9. [Verify](#9-verify)
10. [Reverse proxy and TLS](#10-reverse-proxy-and-tls)
11. [Firewall](#11-firewall)
12. [Backups](#12-backups)
13. [Upgrades](#13-upgrades)
14. [Logs](#14-logs)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Sizing

| | vCPU | RAM | Disk | Suits |
|---|---|---|---|---|
| **Minimum** | 4 | 8 GB | 100 GB SSD | Evaluation, one brand, low volume |
| **Recommended** | 8 | 16 GB | 250 GB SSD | 5-20 brands, a few thousand checks a month |
| **Busy** | 16 | 32 GB | 500 GB SSD | Agency workload, video, several thousand assets a month |

Steady-state memory on the recommended tier:

| Process | Typical | `max_memory_restart` |
|---|---|---|
| `brandlens-api` | 250-400 MB | 900 MB |
| `brandlens-worker` | 300-600 MB | 1400 MB |
| `brandlens-web` | 200-350 MB | 800 MB |
| `brandlens-engine` | 400 MB-1.5 GB | 2 GB |
| PostgreSQL | `shared_buffers` + connections | — |

The engine is the memory-hungry one: `scikit-image` plus `opencv` plus a
decoded 4K frame is the peak allocation, and video probing is worse.

**Disk.** Assets are content-addressed and deduplicated, so the real driver is
distinct creative volume rather than upload count. Budget roughly 2-5 GB per
1 000 image assets including derivatives, and considerably more for video.
Derivatives are reproducible from the originals and can be expired.

**Where.** Install near the drive root — `C:\brandlens` — rather than under a
deep user profile path. A checkout plus `node_modules` plus `.venv` gets close
to `MAX_PATH` quickly, and long-path errors are the most common install failure.

---

## 2. Prerequisites

| Component | Version | Installed by |
|---|---|---|
| Windows Server 2022 / Windows 11 | — | — |
| PowerShell | 5.1 or 7.x | Built in |
| Node.js | 20.11+ (22 LTS recommended) | `bootstrap.ps1` |
| pnpm | 9.12.3 | `bootstrap.ps1` (corepack) |
| Python | 3.11 or 3.12, **64-bit** | `bootstrap.ps1` |
| PostgreSQL | 16 or 17 | `bootstrap.ps1` |
| PM2 | latest | `bootstrap.ps1` |
| Caddy | latest | `bootstrap.ps1 -IncludeCaddy` (optional) |
| Git | any recent | Manual |

**Before you start:**

- Administrator on the VM.
- Outbound HTTPS to your model provider — or an OpenAI-compatible endpoint on
  the local network if the VM is air-gapped.
- An LLM API key (Anthropic, OpenAI, Azure OpenAI or Google), unless you are
  running deterministic-only.

**Enable long paths first.** This prevents the most common install failure:

```powershell
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
git config --system core.longpaths true
```

---

## 3. Install

```powershell
# Elevated PowerShell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

New-Item -ItemType Directory -Path C:\brandlens -Force | Out-Null
Set-Location C:\brandlens
git clone <your-repo-url> .

.\infra\windows\bootstrap.ps1 -IncludeCaddy -InstallDependencies
```

`bootstrap.ps1` checks and installs Node, pnpm, Python, PostgreSQL, PM2 and
optionally Caddy via `winget`, verifies every version, creates `.env` from
`.env.example`, creates `logs\`, `.storage\` and `backups\`, and prints an
OK/FAIL line for each step.

It is **idempotent** — anything already present and new enough is left strictly
alone — and it never leaves the machine half-configured: each component is
installed and then re-verified before the next is attempted.

```powershell
.\infra\windows\bootstrap.ps1 -SkipInstall   # verify only; exits 1 if anything is missing
```

**If `winget` is unavailable** (common on Windows Server), the script prints
manual instructions per component and exits non-zero. Install by hand, then
re-run with `-SkipInstall` to confirm.

**After installing anything, open a new PowerShell window.** `winget` updates
the machine `PATH`, but the running process keeps its stale copy. The script
refreshes `PATH` in-process where it can and tells you when it cannot.

---

## 4. Configure `.env`

```powershell
notepad C:\brandlens\.env
```

### Must change before going anywhere near production

```ini
NODE_ENV=production

DATABASE_URL=postgresql://brandlens:<STRONG-PASSWORD>@localhost:5432/brandlens

# 32+ random characters each. Generate them, do not invent them.
JWT_ACCESS_SECRET=<random-32+>
JWT_REFRESH_SECRET=<random-32+>
API_KEY_PEPPER=<random-32+>
ENGINE_SHARED_SECRET=<random-32+>
STORAGE_SIGNING_SECRET=<random-32+>

ANTHROPIC_API_KEY=sk-ant-...
```

Generate secrets:

```powershell
# 5 independent 48-character secrets
1..5 | ForEach-Object {
  -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
}
```

Rotating `API_KEY_PEPPER` invalidates every existing API key. Rotating
`JWT_*` invalidates every session. Rotating `STORAGE_SIGNING_SECRET`
invalidates outstanding signed URLs (they are short-lived, so this is cheap).

### Set an absolute storage path

```ini
STORAGE_LOCAL_ROOT=C:\brandlens\.storage
```

**Do this. It is not optional in production.** A relative
`STORAGE_LOCAL_ROOT` is resolved against `process.cwd()`, and the four
processes have four different working directories — so `./.storage` means
`apps\api\.storage` for the API and something else for a maintenance script.
An absolute path removes the ambiguity entirely.

### Bind services to loopback

```ini
API_HOST=127.0.0.1
```

With Caddy in front, nothing but Caddy should listen publicly. The engine
already defaults to `127.0.0.1`.

### Public URLs

```ini
API_PUBLIC_URL=https://brandlens.example.com
WEB_PUBLIC_URL=https://brandlens.example.com
NEXT_PUBLIC_API_URL=https://brandlens.example.com
```

`NEXT_PUBLIC_*` is **inlined at build time**. Change it and you must rebuild
the console — `pnpm build` — or the browser will keep calling the old host.

### Models

```ini
LLM_JUDGE_PROVIDER=anthropic
LLM_JUDGE_MODEL=claude-sonnet-4-5-20250929
```

Use a **different model family for the judge than for whatever generated the
asset**. A model asked to grade its own output exhibits measurable
self-preference bias, and being generator-agnostic is the entire position.

### Cost control

```ini
COST_TENANT_DAILY_USD_LIMIT=25
COST_JOB_USD_LIMIT=2.5
COST_DEGRADE_GRACEFULLY=true
```

With `COST_DEGRADE_GRACEFULLY=true` a run that hits the ceiling returns its
deterministic findings and marks the remaining T2 criteria
`insufficient_evidence`, flagged `degraded`, rather than failing outright.

### Concurrency

Start with `QUEUE_CONCURRENCY_CPU` ≈ vCPU count and leave the rest alone:

```ini
QUEUE_CONCURRENCY_CPU=8      # 8 vCPU VM
QUEUE_CONCURRENCY_LLM=12     # bound by provider latency, not by CPU
QUEUE_CONCURRENCY_DEFAULT=8
DATABASE_POOL_MAX=20
```

---

## 5. Database

```powershell
.\infra\windows\setup-database.ps1
```

This creates the `brandlens` role and database, synchronises the role password
with `DATABASE_URL`, grants ownership of `schema public` (PostgreSQL 15+ removed
`CREATE` from `PUBLIC`, and getting this wrong fails the first migration
halfway through), attempts `CREATE EXTENSION vector`, then runs
`pnpm db:migrate` and `pnpm db:seed`. It does **not** run `db:generate` — migrations are committed to the repository and applied verbatim, so the server executes the exact SQL that was reviewed in a pull request. See [github-workflow.md](github-workflow.md).

Useful variants:

```powershell
.\infra\windows\setup-database.ps1 -DbHost db01.corp.local -SuperUser postgres
.\infra\windows\setup-database.ps1 -SkipSeed        # existing production database
.\infra\windows\setup-database.ps1 -WhatIf          # show every statement, change nothing
```

### pgvector

The script reports, in plain language, which vector path is active:

```
Vector search: real[] FALLBACK (pgvector not installed)
```

**This is a fully supported configuration.** BrandLens always populates a
portable `real[]` column and ranks with an in-SQL cosine function. Nothing is
disabled; precedent retrieval does a sequential scan instead of an index scan.
The difference is negligible below roughly 50 000 embeddings per tenant and
noticeable above 250 000.

To add it later, without a compiler:

1. Download prebuilt binaries matching your PostgreSQL **major version** from
   the [pgvector releases](https://github.com/pgvector/pgvector/releases) or a
   community Windows build.
2. `vector.dll` → `C:\Program Files\PostgreSQL\16\lib\`
3. `vector*.sql` and `vector.control` → `C:\Program Files\PostgreSQL\16\share\extension\`
4. `Restart-Service postgresql-x64-16`
5. Re-run `setup-database.ps1` (idempotent) — the shadow `vector(N)` column is
   backfilled by trigger. No re-embedding.

### The seed

`pnpm db:seed` creates the **Northwind Coffee Co.** demo tenant: a full brand
ontology, generated logo and creative PNGs, a published ruleset, ten registered
assets and one completed check run with traces, findings, a human override and
a precedent — so the console has something true to show on first boot.

It is idempotent and safe to re-run. On a production install, either skip it
(`-SkipSeed`) or delete the demo organisation afterwards.

**The seed creates a fixed demo API key**
(`bl_live_demo_northwind_seed_2026`). Revoke it before the host is reachable by
anyone else: `DELETE /v1/api-keys/{id}`.

---

## 6. Python engine

```powershell
.\infra\windows\setup-python.ps1
```

Creates `apps\engine\.venv`, installs `requirements.txt`, verifies that all 19
runtime imports actually load, imports the engine package itself, and prints the
absolute interpreter path that `ecosystem.config.cjs` will use.

Every dependency resolves to a prebuilt `win_amd64` wheel. **If pip starts
building from source, that is a bug in the pin — do not install a compiler.**

```powershell
.\infra\windows\setup-python.ps1 -Recreate     # after a Python upgrade
.\infra\windows\setup-python.ps1 -IncludeDev   # pytest, ruff, mypy

# Air-gapped: build a wheelhouse on a connected machine with the same Python
#   pip download -r apps\engine\requirements.txt -d D:\wheels
.\infra\windows\setup-python.ps1 -Offline -WheelDir D:\wheels
```

If `cv2` fails to import with a DLL error, install the VC++ redistributable:
`winget install Microsoft.VCRedist.2015+.x64`.

---

## 7. Build

```powershell
Set-Location C:\brandlens
pnpm install --frozen-lockfile
pnpm build
```

This compiles `packages/*`, then `apps/api`, `apps/worker` and `apps/web`.
`apps/web` in particular **must** be built — `next start` refuses to run
without `.next`.

Expect 2-5 minutes on the recommended tier.

---

## 8. Run as a service

```powershell
.\infra\windows\install-services.ps1
```

`pm2 startup` does not support Windows, so something else has to own the daemon
at boot. The script prefers
[pm2-installer](https://github.com/jessety/pm2-installer) and falls back to
NSSM running `pm2-runtime`. Both end with `PM2_HOME=C:\ProgramData\pm2` set
machine-wide, so the ordinary `pm2` CLI talks to the same daemon the service
runs.

```powershell
# No internet on the VM? Download NSSM from https://nssm.cc, then:
.\infra\windows\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe

.\infra\windows\install-services.ps1 -WhatIf     # print every change first
```

Day-to-day:

```powershell
.\infra\windows\start-all.ps1        # preflight, start, pm2 save, probe
.\infra\windows\stop-all.ps1         # graceful
.\infra\windows\status.ps1           # PM2 processes, services, listening ports
.\infra\windows\logs.ps1 -Follow     # live stream, all four
.\infra\windows\healthcheck.ps1      # functional probe of everything
```

**`pm2 save` after every deploy.** Without it, the boot-time resurrect restores
the *previous* process list. `start-all.ps1` and `install-services.ps1` both
run it.

**Reboot before you call the install done.** It is the only way to know the
service configuration is right:

```powershell
Restart-Computer
# after it comes back
C:\brandlens\infra\windows\healthcheck.ps1
```

---

## 9. Verify

```powershell
.\infra\windows\healthcheck.ps1
```

```
  Component     Status    ms   Detail
  ---------     ------  ----   ------
  database      OK        12   localhost:5432/brandlens, 1 org(s)
  engine        OK        34   v1.0.0 status=ok
  api           OK         9   v0.1.0, up 412s
  api-deep      OK       118   status=ok, vector=fallback
    · database  OK         3   {}
    · queue     OK        21   {"queues":{...}}
    · storage   OK         1   {"driver":"local"}
    · engine    OK        30   {"status":"ok","breaker":"closed"}
    · vector    OK         2   {"driver":"fallback"}
    · outbox    OK         2   {"pending":0}
    · providers OK         0   {"judge":{...,"configured":true}}
  web           OK        61   http://localhost:3000 (HTTP 200)
  pm2           OK         0   4 online
```

Exit code is 0 only when every required check passes, so it is safe to drive
from a scheduled task:

```powershell
schtasks /create /tn "BrandLens health" /sc minute /mo 5 /ru SYSTEM `
  /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\brandlens\infra\windows\healthcheck.ps1 -Quiet"
```

Then sign in at `http://localhost:3000` with `owner@northwind.test` /
`BrandLens!2026` (seed credentials) and open the completed check run.

Smoke-test the API:

```powershell
curl.exe -s http://localhost:4000/health/deep | ConvertFrom-Json | Select-Object status
```

---

## 10. Reverse proxy and TLS

Caddy is a single `.exe` with automatic HTTPS, which makes it the right front
door for a VM that is deliberately not running Docker.

```powershell
# Validate first
caddy.exe validate --config C:\brandlens\infra\caddy\Caddyfile

# Foreground, to watch it work
caddy.exe run --config C:\brandlens\infra\caddy\Caddyfile
```

`infra/caddy/Caddyfile` ships with a `:80` block active, which matches any
hostname — so it works on `http://localhost`, `http://<vm-name>` and
`http://<ip>` with no DNS at all. Routing:

```
/v1/*, /docs, /health*  ->  127.0.0.1:4000   API
/metrics                ->  127.0.0.1:4000   restricted by source IP
/                       ->  127.0.0.1:3000   console
```

The engine on `:8000` is **not** proxied. It authenticates with a shared secret
intended for a loopback hop and has no per-tenant authorisation of its own —
publishing it would be a direct path around the control plane's RLS.

### Going to production HTTPS

1. Point an A/AAAA record at the VM's public IP.
2. `.\infra\windows\firewall.ps1` (opens 80 and 443).
3. In the Caddyfile: comment out the `:80` block, uncomment the
   `brandlens.example.com` block, set the hostname and the `email`.
4. Update `.env` (`API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `NEXT_PUBLIC_API_URL`),
   then **`pnpm build`** — `NEXT_PUBLIC_*` is inlined at build time.
5. `.\infra\windows\start-all.ps1`
6. `caddy.exe reload --config C:\brandlens\infra\caddy\Caddyfile`

Port 80 must stay open: it carries the ACME HTTP-01 challenge and the redirect
to HTTPS.

While testing, uncomment the `acme_ca` staging line in the global block.
Let's Encrypt rate-limits duplicate certificates to five per week, and a
misconfigured DNS record will burn through that quickly.

Alternatives are documented inline in the Caddyfile: `tls internal` for an
air-gapped VM, a certificate from a file for a corporate CA, and DNS-01 for
wildcards or when port 80 cannot be opened.

Run Caddy as a service with NSSM, mirroring `install-services.ps1`:

```powershell
nssm install Caddy "C:\brandlens\bin\caddy.exe" run --config "C:\brandlens\infra\caddy\Caddyfile"
nssm set Caddy AppDirectory C:\brandlens
nssm set Caddy Start SERVICE_AUTO_START
Start-Service Caddy
```

---

## 11. Firewall

```powershell
.\infra\windows\firewall.ps1 -RemoteAddress 'LocalSubnet'
```

Opens only 80 and 443, on the Domain and Private profiles (deliberately not
Public). The four application ports stay bound to loopback and are never added
to the firewall at all — which is stronger than a rule, because a service that
is not listening on `0.0.0.0` cannot be reached even if a rule is later added
by mistake.

The script also **audits the bindings** and reports anything listening on every
interface that should not be, with the fix (which is a configuration change,
not a firewall change).

```powershell
.\infra\windows\firewall.ps1 -Mode Direct -RemoteAddress 10.20.0.0/16  # no proxy, internal only
.\infra\windows\firewall.ps1 -Mode LocalOnly                            # audit only
.\infra\windows\firewall.ps1 -List
.\infra\windows\firewall.ps1 -Remove
```

Also restrict PostgreSQL:

```ini
# postgresql.conf
listen_addresses = 'localhost'
```

---

## 12. Backups

```powershell
.\infra\windows\backup.ps1 -Destination D:\backups\brandlens -RetentionDays 30
```

Produces a timestamped folder containing a `pg_dump` in custom format
(compressed, selectively restorable), a copy of the storage tree, and a
`manifest.json` recording the schema version, the pgvector state and row
counts — so a restore can be verified rather than assumed.

Storage copying skips destination files that already exist at the same size.
Because content-addressed files are immutable once written, that skip is
correct by construction and turns an incremental backup into an O(new files)
operation.

Retention prunes only **after a successful backup**, and never below
`-MinimumKeep` (default 3). Deleting yesterday's good backup because today's
failed is the classic way to end up with none.

Schedule it nightly:

```powershell
schtasks /create /tn "BrandLens backup" /sc daily /st 02:30 /ru SYSTEM `
  /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\brandlens\infra\windows\backup.ps1 -Destination D:\backups\brandlens -RetentionDays 30"
```

Restore:

```powershell
.\infra\windows\stop-all.ps1
$env:PGPASSWORD = '<password>'
pg_restore --clean --if-exists --no-owner -h localhost -U brandlens -d brandlens `
  "D:\backups\brandlens\2026-08-17T0230\brandlens-2026-08-17T0230.dump"
Copy-Item "D:\backups\brandlens\2026-08-17T0230\storage\*" C:\brandlens\.storage -Recurse -Force
.\infra\windows\start-all.ps1
```

Restoring needs no special RLS handling. **Verifying** does: with no tenant
bound, every count reads 0. Prefix a verification query with
`SET app.bypass_rls = 'on';`.

**Drill this quarterly on a spare VM.** An untested backup is a hypothesis. The
full drill is in [operations.md](operations.md).

The local storage driver has **no redundancy** — disk failure loses the
originals. That is the single largest operational risk of the default
configuration, and it is why the nightly backup is mandatory rather than
advisory.

---

## 13. Upgrades

```powershell
Set-Location C:\brandlens

# 1. Back up first. Always.
.\infra\windows\backup.ps1

# 2. Fetch
git fetch --all
git log --oneline HEAD..origin/main     # read what you are about to deploy
git pull

# 3. Dependencies
pnpm install --frozen-lockfile
.\infra\windows\setup-python.ps1        # picks up requirements.txt changes

# 4. Build
pnpm build

# 5. Migrate. Idempotent and safe to re-run.
pnpm db:migrate

# 6. Reload — zero downtime for the Node processes
pm2 reload C:\brandlens\infra\windows\ecosystem.config.cjs
pm2 save

# 7. Verify
.\infra\windows\healthcheck.ps1
```

**Notes**

- `pm2 reload` is graceful for the Node processes. The Python engine is
  restarted rather than reloaded — uvicorn has no zero-downtime reload under
  PM2 — so expect a 2-5 second engine gap. The API's circuit breaker absorbs
  it: in-flight checks retry.
- Migrations are forward-only and additive. There is no automated down
  migration; rolling back means restoring the backup.
- `pnpm db:seed` is safe to re-run (it is idempotent) but is not part of an
  upgrade. Skip it in production.
- Recreate the Python venv after a **Python** upgrade:
  `.\infra\windows\setup-python.ps1 -Recreate`. A venv keeps a hard reference
  to the interpreter that created it and breaks silently when that interpreter
  is replaced.
- After a **PostgreSQL major** upgrade, re-run
  `.\infra\windows\setup-database.ps1 -SkipSeed` so the extension state is
  re-checked, and reinstall pgvector for the new major version if you use it.

---

## 14. Logs

| Source | Location |
|---|---|
| API | `C:\brandlens\logs\api-out.log`, `api-error.log` |
| Worker | `C:\brandlens\logs\worker-out.log`, `worker-error.log` |
| Console | `C:\brandlens\logs\web-out.log`, `web-error.log` |
| Engine | `C:\brandlens\logs\engine-out.log`, `engine-error.log` |
| PM2 service | `C:\brandlens\logs\pm2-service-*.log` (NSSM method) |
| Caddy | `C:\brandlens\logs\caddy.log`, `caddy-access.log` |
| PostgreSQL | `C:\Program Files\PostgreSQL\16\data\log\` |

All four services log JSON lines — pino for Node, structlog for Python — so a
plain substring search over the raw line finds a correlation id, a rule key or
a check-run uuid.

```powershell
.\infra\windows\logs.ps1 -Follow
.\infra\windows\logs.ps1 -Process engine -Errors -Lines 200
.\infra\windows\logs.ps1 -Grep 3f2b9c1e-0a44-4d2f-9a7e-1b6c5d8e2f01   # one request, all services
.\infra\windows\logs.ps1 -Since -2h
```

Rotation is PM2's (`pm2 install pm2-logrotate` to configure size and retention).
`pm2 flush` truncates everything.

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `CREATE EXTENSION vector` fails; setup reports the fallback | pgvector is not installed. **This is supported.** | Nothing required. To add it: copy prebuilt `vector.dll` to `...\PostgreSQL\16\lib\` and `vector*.sql` + `vector.control` to `...\share\extension\`, restart the service, re-run `setup-database.ps1`. |
| `ERROR: extension "vector" has no installation script nor update path` | The binary does not match the PostgreSQL major version | Download the build for your exact major version. A 15 binary will not load on 16. |
| Vector queries slow, disk churning | `real[]` fallback with a large embeddings table | Install pgvector, or raise `shared_buffers`. Check `SELECT count(*) FROM embeddings`. Above ~250k per tenant, pgvector is worth the install. |
| `pm2` is not recognised | PM2 installed but `PATH` not refreshed | Open a **new** PowerShell. Or `npm install -g pm2` and re-run `bootstrap.ps1 -SkipInstall`. |
| Service is running but `pm2 list` is empty | `PM2_HOME` mismatch — the service account has its own daemon under `C:\Windows\system32\config\systemprofile\.pm2` | `[Environment]::SetEnvironmentVariable('PM2_HOME','C:\ProgramData\pm2','Machine')`, restart the service, `pm2 save`. |
| Processes do not come back after reboot | `pm2 save` was never run, or was run before the processes started | `.\start-all.ps1` (which saves), then `Restart-Computer` and verify. |
| PM2 `Script not found` | Relative `script` resolved against the service's cwd (`C:\Windows\system32`) | The shipped `ecosystem.config.cjs` uses absolute paths. If you edited it, use `path.join(__dirname, ...)`. |
| `brandlens-web` restarts in a loop | `.next` is missing | `pnpm build`. `next start` refuses to run without a production build. |
| `brandlens-engine` exits immediately | Venv missing or Python upgraded underneath it | `.\setup-python.ps1 -Recreate`, then `.\start-all.ps1`. |
| Engine: `ModuleNotFoundError: brandlens_engine` | Wrong cwd or `PYTHONPATH` | The ecosystem file sets both. Verify with `pm2 describe brandlens-engine`. |
| Engine: `ImportError` from `cv2` about a DLL | Missing VC++ runtime | `winget install Microsoft.VCRedist.2015+.x64` |
| pip tries to **build** a package | The pin no longer resolves to a `win_amd64` wheel | Do **not** install a compiler. Pin the previous version and open an issue. |
| `python -m venv` fails | Partial Python install | Settings → Apps → Python → Modify, tick `pip` and `tcl/tk`. Or reinstall 64-bit. |
| Venv creation fails with a path error | `MAX_PATH` | Enable long paths (§2) and move the checkout to `C:\brandlens`. |
| `EADDRINUSE` on 3000/4000/8000 | Another process holds the port | `Get-NetTCPConnection -LocalPort 4000 -State Listen \| Select OwningProcess`, then `Get-Process -Id <pid>`. Change the port in `.env` or stop the other process. |
| API starts, `/health/deep` reports `database: false` | Wrong `DATABASE_URL`, service down, or `pg_hba.conf` | `Get-Service postgresql*`; test with `psql`; add `host brandlens brandlens 127.0.0.1/32 scram-sha-256` above the defaults and restart. |
| `password authentication failed for user "brandlens"` | `.env` and the role disagree | `.\setup-database.ps1 -SkipMigrate` resynchronises the role password from `DATABASE_URL`. |
| `pg_dump: query would be affected by row-level security policy` | Every tenant table uses `FORCE ROW LEVEL SECURITY`; `pg_dump` aborts rather than dumping a subset | Use `backup.ps1`, which handles it. By hand: set `PGOPTIONS='-c app.bypass_rls=on'` and add `--enable-row-security`, or dump as a superuser. See [operations.md §6](operations.md#6-backup-and-restore-drill). |
| Restored database looks empty (`SELECT count(*) FROM assets` → 0) | No tenant bound, so RLS filters everything. The restore is probably fine. | `SET app.bypass_rls = 'on';` in the session before counting. |
| `permission denied for schema public` | PostgreSQL 15+ removed `CREATE` from `PUBLIC` | `GRANT ALL ON SCHEMA public TO brandlens; ALTER SCHEMA public OWNER TO brandlens;` — `setup-database.ps1` does this. |
| Migrations: `No generated migrations found` | This VM was set up by copying files instead of `git clone`, so `packages/db/drizzle/` is missing | Re-provision with `git clone`. Never run `db:generate` on the server — generate on a dev machine and commit the SQL |
| Assets 404 in the console after seeding | `STORAGE_LOCAL_ROOT` is relative and resolved from a different cwd | Set an **absolute** path in `.env` and re-run the seed. See §4. |
| Uploads fail with `Storage key escapes root` | Path-traversal guard fired | Expected on a malformed key. If it fires on normal uploads, `STORAGE_LOCAL_ROOT` is probably misconfigured. |
| Checks return `409 NoActiveRuleset` | The brand has never published a ruleset | `POST /v1/brands/{id}/rulesets`, or activate the proposed rules first. |
| Checks return `402 BudgetExceeded` | Daily tenant ceiling reached | Raise `COST_TENANT_DAILY_USD_LIMIT`, or the org's `dailyUsdLimit`. Inspect `GET /v1/analytics/cost`. |
| Checks return `503 EngineUnavailable` | Engine down or the circuit breaker is open | `.\logs.ps1 -Process engine -Errors`. The breaker closes automatically after the cooldown. |
| Runs stay `queued` | Worker down, or pg-boss cannot reach the queue schema | `pm2 restart brandlens-worker`; check `/health/deep` → `queue`. |
| Runs stuck in `running` | A handler was `SIGKILL`ed | `platform.reconcile` picks these up within 5 minutes. Check `logs.ps1 -Process worker`. |
| Webhooks not arriving | No matching endpoint, or delivery failing | `GET /v1/webhooks/{id}/deliveries`. Nobody listening is a *successful* dispatch. |
| Webhook signature verification fails | Body re-serialised, or the timestamp not included | Sign `timestamp.rawBody`, using the **raw** bytes. See [api.md §12](api.md#12-webhooks). |
| Console shows stale API URL after a domain change | `NEXT_PUBLIC_API_URL` is inlined at build time | `pnpm build`, then `pm2 reload`. |
| `pnpm install` fails on a long path | `MAX_PATH` | Enable long paths (§2), move to `C:\brandlens`, delete `node_modules` and retry. |
| `winget` unavailable on Server | App Installer is not present | Install App Installer from the Microsoft Store, or install each prerequisite manually — `bootstrap.ps1` prints the instructions. |
| Everything is slow, high disk I/O | PostgreSQL under-tuned for the VM | Raise `shared_buffers` to ~25% of RAM and `work_mem` to 16-32 MB in `postgresql.conf`, then restart. |

### When you are stuck

```powershell
.\infra\windows\status.ps1 -Detailed
.\infra\windows\healthcheck.ps1 -Json | ConvertFrom-Json
.\infra\windows\logs.ps1 -Errors -Lines 200
```

Then find the correlation id in the error and trace it across all four
services:

```powershell
.\infra\windows\logs.ps1 -Grep '<correlation-id>'
```

---

## See also

- [operations.md](operations.md) — metrics, alerts, scaling, incident runbook
- [architecture.md](architecture.md) — how it works and why
- [api.md](api.md) — the REST surface
- [adr/0010](adr/0010-pm2-on-windows.md) — why PM2 rather than Docker
