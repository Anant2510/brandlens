# 0002 — pg-boss instead of Redis

**Status** Accepted · **Date** 2026-02-10 · **Deciders** Platform

## Context

BrandLens needs a durable job queue. Analysis runs for minutes, brand-book
extraction runs for longer, webhook delivery needs bounded retries with
backoff, and two scheduled jobs (outbox dispatch, reconciliation) have to fire
on a cron.

The default answer is BullMQ on Redis. The deployment target made that
expensive: a single Windows Server VM where the customer had already ruled out
installing Docker as too heavy. Redis on Windows means either Memurai (a
commercial fork), WSL2 (which is Docker-adjacent complexity by another name),
or the abandoned Microsoft port. All three add an install step, a service to
supervise, a backup story, and a second thing that can be down.

PostgreSQL is already there, and it is already the durability boundary for
everything else.

## Decision

Use **pg-boss** in a dedicated schema (`QUEUE_SCHEMA`, default
`brandlens_queue`) inside the same PostgreSQL database.

- The API runs pg-boss with `supervise: false, schedule: false`. It only
  publishes.
- The worker runs with `supervise: true, schedule: true` and owns maintenance,
  archiving and the cron scheduler.
- Three concurrency pools — `cpu_media`, `llm_io`, `default` — configured
  independently via `QUEUE_CONCURRENCY_*`.
- Completed jobs are archived after an hour and deleted after seven days.

## Consequences

**Good**

- **Transactional enqueue.** This is the property that turned a constraint into
  an advantage. Because jobs are rows, a job can be sent in the *same
  transaction* as the state change that justifies it. That removes an entire
  class of bugs: "the run committed but the job was never queued" and "the job
  ran but the transaction rolled back" both become impossible. The
  transactional outbox pattern falls out for free.
- One backup covers the data and the queue. `pg_dump` of the database is a
  complete restore point.
- One connection pool, one set of credentials, one thing to monitor. Queue
  depth is a SQL query.
- Nothing extra to install on Windows. `bootstrap.ps1` is shorter for it.

**Costs**

- Lower ceiling than Redis. pg-boss comfortably handles thousands of jobs per
  minute; Redis handles hundreds of thousands. BrandLens jobs take seconds to
  minutes each, so this ceiling is far above the workload — but it is a real
  ceiling and it is worth knowing where it is.
- Queue traffic competes with application traffic for connections and for
  autovacuum. `DATABASE_POOL_MAX` has to account for both, and the queue tables
  need their own vacuum attention under sustained load.
- pg-boss's API is less rich than BullMQ's. No job dependency graphs, no flows,
  no built-in rate limiter. Nothing BrandLens currently wants.
- pg-boss v10 has sharp edges. It validates options on key *presence* rather
  than value, so `{ priority: undefined }` throws "priority must be an
  integer"; both `QueueService.enqueue` and `WorkerRuntime.send` build the
  options object rather than spreading optionals. Queues must also be created
  before a send, so both processes call `createQueue` for every known queue at
  boot.

**Neutral**

- At-least-once delivery, same as Redis. Every handler is written to be
  idempotent regardless; `analyze.asset` in particular re-bills a run if it is
  not, which would be the most expensive bug in the system.

## Alternatives

**BullMQ + Redis.** Higher throughput, richer API, better tooling. Rejected on
the deployment constraint. Would be reconsidered if BrandLens ever ran on
Kubernetes where Redis is one manifest.

**Graphile Worker.** Also Postgres-backed and arguably a better engine —
`LISTEN/NOTIFY` for low latency, a cleaner API. Rejected because pg-boss ships
cron scheduling, archiving and dead-letter handling in the box, and building
those on top of Graphile Worker would have cost more than the API difference
was worth.

**Azure Service Bus / SQS.** Managed, durable, scalable. Rejected: the target
is a single on-premises VM, frequently in an environment with no outbound
access to a cloud queue. It also loses transactional enqueue.

**A hand-rolled `FOR UPDATE SKIP LOCKED` poller.** Roughly 300 lines to get the
happy path, and then months of slowly rediscovering retries, backoff,
archiving, singleton keys and cron. The outbox relay in
`apps/worker/src/handlers/dispatch-outbox.ts` uses that pattern deliberately
and in exactly one place, because there it is genuinely simpler.
