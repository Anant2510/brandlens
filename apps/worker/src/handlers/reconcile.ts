import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { QUEUES } from '@brandlens/contracts';
import { assets, checkRuns, outboxEvents } from '@brandlens/db';
import { env } from '../config';
import { getContext } from '../context';
import { logger } from '../logger';
import type { WorkerRuntime } from '../runtime';

export interface ReconcileJob {
  reason?: string;
}

/**
 * `platform.reconcile` — the janitor.
 *
 * At-least-once delivery guarantees a job is not lost, but it guarantees
 * nothing about a process that was SIGKILLed halfway through a handler. That
 * leaves rows stuck in `running` with no live worker behind them, and no queue
 * entry to retry. This sweep is the only thing that notices.
 *
 * Everything here is idempotent and safe to run on a schedule; it re-enqueues
 * with singleton keys so a double sweep cannot double-execute.
 */
export async function reconcile(job: ReconcileJob, runtime: WorkerRuntime): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'platform.reconcile' });
  const staleBefore = new Date(Date.now() - env.RECONCILE_STUCK_MINUTES * 60_000);

  /* --- 1. check runs stuck in queued/running -------------------------- */
  const stuckRuns = await ctx.platform((tx) =>
    tx
      .select({ id: checkRuns.id, orgId: checkRuns.orgId, status: checkRuns.status, startedAt: checkRuns.startedAt })
      .from(checkRuns)
      .where(
        and(
          or(eq(checkRuns.status, 'queued'), eq(checkRuns.status, 'running')),
          lt(checkRuns.createdAt, staleBefore),
        ),
      )
      .limit(200),
  );

  for (const run of stuckRuns) {
    // Reset to `queued` first so the analyze handler's own idempotency guard
    // does not immediately short-circuit the retry.
    await ctx.withTenant(run.orgId, (tx) =>
      tx.update(checkRuns).set({ status: 'queued', startedAt: null }).where(eq(checkRuns.id, run.id)),
    );
    await runtime.send(
      QUEUES.analyzeAsset,
      { orgId: run.orgId, checkRunId: run.id },
      { singletonKey: `analyze:${run.id}` },
    );
  }

  /* --- 2. assets stuck mid-ingest ------------------------------------- */
  const stuckAssets = await ctx.platform((tx) =>
    tx
      .select({ id: assets.id, orgId: assets.orgId })
      .from(assets)
      .where(and(eq(assets.status, 'uploading'), lt(assets.createdAt, staleBefore), isNull(assets.deletedAt)))
      .limit(200),
  );

  for (const asset of stuckAssets) {
    await runtime.send(
      QUEUES.ingestAsset,
      { orgId: asset.orgId, assetId: asset.id },
      { singletonKey: `ingest:${asset.id}` },
    );
  }

  /* --- 3. outbox events whose retry window has come round -------------- */
  const backlog = await ctx.platform(async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.status, 'pending'), lt(outboxEvents.nextAttemptAt, new Date())));
    return rows[0]?.n ?? 0;
  });

  if (backlog > 0) {
    await runtime.send(QUEUES.dispatchOutbox, { reason: 'reconcile', batchSize: 100 }, { singletonKey: 'outbox-sweep' });
  }

  /* --- 4. report the dead letter, which nothing else will ------------- */
  const dead = await ctx.platform(async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'dead'));
    return rows[0]?.n ?? 0;
  });

  if (stuckRuns.length || stuckAssets.length || backlog || dead) {
    log.warn(
      { requeuedRuns: stuckRuns.length, requeuedAssets: stuckAssets.length, outboxBacklog: backlog, outboxDead: dead },
      'reconciliation found work',
    );
  } else {
    log.debug({ reason: job.reason }, 'nothing to reconcile');
  }
}
