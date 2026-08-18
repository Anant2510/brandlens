# 0010 — PM2 on Windows, without Docker

**Status** Accepted · **Date** 2026-02-16 · **Deciders** Platform, Operations

## Context

The supported production target is **one Windows Server 2022 or Windows 11 VM**.
The customer stated directly that installing Docker Desktop or Docker Engine on
it was too heavy — a position that is entirely reasonable on a Windows host,
where Docker means either Hyper-V isolation with its own resource overhead or
WSL2 with a second operating system to patch, back up and explain to a security
review.

So there are four long-running processes to supervise:

| Process | Runtime | Port |
|---|---|---|
| `brandlens-api` | Node | 4000 |
| `brandlens-worker` | Node | — |
| `brandlens-web` | Node | 3000 |
| `brandlens-engine` | Python | 8000 |

They must start at boot, restart on crash, restart on memory growth, write logs
somewhere an operator can find, and be startable and stoppable by someone who
is not the person who installed them.

Windows offers the Service Control Manager, but the SCM expects a service
binary. `node main.js` is not one, and neither is `python -m uvicorn`.

## Decision

**PM2 as the process manager, installed as a Windows service so the whole set
survives a reboot.**

- `infra/windows/ecosystem.config.cjs` defines all four processes with absolute
  paths, per-process memory ceilings, log paths under `logs/`, and a shared
  restart policy.
- `install-services.ps1` registers PM2 as a service, preferring
  [pm2-installer](https://github.com/jessety/pm2-installer) and falling back to
  NSSM running `pm2-runtime`. Both end with `PM2_HOME=C:\ProgramData\pm2` set
  machine-wide.
- Seven thin wrappers — `start-all`, `stop-all`, `status`, `logs`,
  `healthcheck`, `backup`, `firewall` — so day-to-day operation needs no PM2
  knowledge.
- Caddy, as a single `.exe`, is the optional reverse proxy with automatic
  HTTPS. `infra/docker/docker-compose.yml` exists for developer machines and is
  labelled as such.

Four details that took real effort to get right and are easy to regress:

**Absolute paths, built with `path.join`.** PM2 resolves a relative `script`
against *its own* cwd, not the config file's. Under a service-managed PM2 that
is `C:\Windows\system32`, which is the usual cause of "Script not found".

**`exec_mode: 'fork'` everywhere.** PM2's cluster mode depends on Node's
`cluster` module: it cannot host a Python process at all, and for the worker it
would be actively wrong — pg-boss already fans out per pool, and
cluster-forking would multiply the configured concurrency by the instance count
without anyone asking for it. The worker's `instances` is separate and
configurable because it is the only process whose throughput scales with copies.

**`interpreter: 'none'` for the engine.** `script` is the venv's `python.exe`
and `args` begins `-m uvicorn`, so PM2 execs the interpreter directly. Pointing
`interpreter` at Python and `script` at a module *name* does not work — PM2
stats the script path first and refuses a name that is not a file.

**`.env` is parsed inside the ecosystem file.** PM2's own `env_file` key exists
only in recent releases and is silently ignored by older ones, which produces a
service that starts happily with no configuration at all. Reading the file with
`fs` makes the behaviour identical on every PM2 version and lets the config
warn loudly when the file is absent.

**`PM2_HOME` must be machine-wide.** Without it the service account keeps its
own daemon in `C:\Windows\system32\config\systemprofile\.pm2`, invisible to the
operator's `pm2 list`. That single mismatch is the source of most "the service
is running but pm2 shows nothing" reports.

## Consequences

**Good**

- No container runtime, no Hyper-V, no WSL2. The install is Node, Python,
  PostgreSQL, PM2, and optionally Caddy — all available through `winget`.
- Native performance. No filesystem-passthrough penalty, which on Windows
  Docker is substantial for a workload that reads image files.
- `pm2 logs`, `pm2 monit` and `pm2 describe` are genuinely good operator tools,
  and log rotation, memory-based restart and graceful reload come with them.
- Graceful shutdown works. PM2 sends SIGINT and waits `kill_timeout` before
  escalating, which is what lets the API finish in-flight synchronous checks and
  the worker finish a running job rather than abandoning a paid VLM call.
- One repository, one checkout, one `pnpm build`. Deployment is `git pull`,
  build, `pm2 reload`.

**Costs**

- Node and Python are installed on the host, so version upgrades are a host
  operation rather than an image swap. `setup-python.ps1 -Recreate` exists
  because a venv keeps a hard reference to the interpreter that created it and
  breaks silently when that interpreter is replaced.
- No image to promote between environments. Staging and production can drift,
  and only the pinned dependency files prevent it.
- PM2 on Windows is less exercised than on Linux, and installing it as a
  service is genuinely fiddly. That is precisely why `install-services.ps1`
  supports two methods and prints manual instructions when both fail.
- `pm2 save` is easy to forget. Without it, a reboot resurrects the *previous*
  process list. `start-all.ps1` and `install-services.ps1` both run it, and it
  is called out in the deployment runbook.
- Long paths. A deep checkout plus `node_modules` plus `.venv` can exceed
  `MAX_PATH`; the runbook covers `LongPathsEnabled` and recommends installing
  near the drive root.
- Windows-only operational tooling. There is no equivalent Linux script set,
  because there is no supported Linux production target. Linux and macOS are
  supported for *development* via `pnpm dev:*` and the optional compose file.

## Alternatives

**Docker Compose on Windows.** One artifact, environment parity, trivial
rollback. Rejected on the stated customer constraint. The compose file survives
for developer machines and says so in its header.

**Windows Services directly, via NSSM per process.** Four services, native SCM
integration, no PM2 at all. Rejected: no unified log view, no memory-based
restart, no graceful reload, and four services to start in the right order. It
is available as a fallback and is what the NSSM path in `install-services.ps1`
partially uses.

**IIS with iisnode.** Native Windows hosting for the Node processes. Rejected:
`iisnode` is effectively unmaintained, it does not help the Python engine at
all, and it would mean two supervision models on one box.

**Kubernetes.** Rejected as obviously disproportionate for a single VM. Should
BrandLens ever run in a cluster, the four processes are already independently
deployable and stateless apart from PostgreSQL and the storage volume, so the
port is a set of manifests rather than a rewrite.

**A Windows Scheduled Task with "at startup" triggers.** Rejected: no restart
on crash, no memory management, no log handling, and diagnosing a failure means
reading Event Viewer.
