import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { outboxEvents, webhookDeliveries, webhookEndpoints } from '@brandlens/db';
import { env } from '../config';
import { getContext } from '../context';
import { logger, type Logger } from '../logger';

export interface DispatchOutboxJob {
  reason?: string;
  batchSize?: number;
}

/**
 * `platform.dispatch-outbox` — the relay.
 *
 * Events were written in the same transaction as the state change they
 * describe, so by the time a row is visible here the change is committed and
 * the event is owed to the customer. This handler's job is to deliver it, with
 * exponential backoff, and to stop trying at a bounded point rather than
 * hammering a dead endpoint forever.
 *
 * IDEMPOTENT: rows are claimed with `FOR UPDATE SKIP LOCKED` and flipped out of
 * `pending` inside the same transaction, so two concurrent relays never send
 * the same event twice.
 */
export async function dispatchOutbox(job: DispatchOutboxJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'platform.dispatch-outbox' });
  const batchSize = Math.min(200, Math.max(1, job.batchSize ?? 50));

  // Claim atomically. Without SKIP LOCKED, two relay instances serialise on the
  // same rows and throughput collapses to one worker.
  const claimed = await ctx.platform(async (tx) => {
    const res = await tx.execute(sql`
      WITH claimed AS (
        SELECT id FROM outbox_events
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET attempts = o.attempts + 1
      FROM claimed c
      WHERE o.id = c.id
      RETURNING o.id, o.org_id, o.event_type, o.event_version, o.aggregate_type,
                o.aggregate_id, o.payload, o.attempts, o.created_at
    `);
    return ((res as unknown as { rows: OutboxRow[] }).rows ?? []) as OutboxRow[];
  });

  if (claimed.length === 0) return;

  for (const event of claimed) {
    await deliver(event, log);
  }

  log.info({ dispatched: claimed.length }, 'outbox batch processed');
}

interface OutboxRow {
  id: string;
  org_id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
}

async function deliver(event: OutboxRow, log: Logger): Promise<void> {
  const ctx = getContext();

  const endpoints = await ctx.withTenant(event.org_id, (tx) =>
    tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.orgId, event.org_id), eq(webhookEndpoints.status, 'active'))),
  );

  const matching = endpoints.filter((e) => e.events.includes('*') || e.events.includes(event.event_type));

  // Nobody is listening. That is a successful dispatch, not a failure — the
  // outbox exists to guarantee delivery to subscribers, not to require one.
  if (matching.length === 0) {
    await markDispatched(event.id);
    return;
  }

  const body = JSON.stringify({
    id: event.id,
    type: event.event_type,
    version: event.event_version,
    orgId: event.org_id,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    occurredAt: event.created_at,
    payload: event.payload,
  });

  let allSucceeded = true;
  let lastError: string | null = null;

  for (const endpoint of matching) {
    const timestamp = Math.floor(Date.now() / 1000);
    // Sign `timestamp.body`, not just the body: without the timestamp in the
    // signed material a captured delivery can be replayed forever.
    const signature = createHmac(env.WEBHOOK_SIGNING_ALGO, endpoint.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const started = Date.now();
    let status: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'BrandLens-Webhooks/1.0',
          'x-brandlens-event': event.event_type,
          'x-brandlens-event-id': event.id,
          'x-brandlens-delivery-attempt': String(event.attempts),
          'x-brandlens-timestamp': String(timestamp),
          'x-brandlens-signature': `${env.WEBHOOK_SIGNING_ALGO}=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(env.WEBHOOK_TIMEOUT_MS),
      });
      status = res.status;
      responseBody = (await res.text()).slice(0, 2000);
      if (!res.ok) {
        allSucceeded = false;
        error = `HTTP ${res.status}`;
        lastError = `${endpoint.url}: HTTP ${res.status}`;
      }
    } catch (err) {
      allSucceeded = false;
      error = err instanceof Error ? err.message : String(err);
      lastError = `${endpoint.url}: ${error}`;
    }

    await ctx.withTenant(event.org_id, async (tx) => {
      await tx.insert(webhookDeliveries).values({
        orgId: event.org_id,
        endpointId: endpoint.id,
        outboxEventId: event.id,
        attempt: event.attempts,
        responseStatus: status,
        responseBody,
        durationMs: Date.now() - started,
        error,
      });

      if (error) {
        await tx
          .update(webhookEndpoints)
          .set({ failureCount: endpoint.failureCount + 1, lastFailureAt: new Date() })
          .where(eq(webhookEndpoints.id, endpoint.id));
      } else {
        await tx
          .update(webhookEndpoints)
          .set({ failureCount: 0, lastSuccessAt: new Date() })
          .where(eq(webhookEndpoints.id, endpoint.id));
      }
    });
  }

  if (allSucceeded) {
    await markDispatched(event.id);
    return;
  }

  if (event.attempts >= env.WEBHOOK_MAX_ATTEMPTS) {
    // Dead letter rather than infinite retry: a permanently broken endpoint
    // must not consume the relay forever, and the row stays queryable so an
    // operator can see exactly what was never delivered.
    await ctx.platform((tx) =>
      tx
        .update(outboxEvents)
        .set({ status: 'dead', lastError: lastError?.slice(0, 2000) ?? 'max attempts exceeded' })
        .where(eq(outboxEvents.id, event.id)),
    );
    log.error({ eventId: event.id, attempts: event.attempts }, 'outbox event dead-lettered');
    return;
  }

  // Exponential backoff with a cap: 5s, 10s, 20s … up to ~10 minutes.
  const delaySeconds = Math.min(600, 5 * 2 ** (event.attempts - 1));
  await ctx.platform((tx) =>
    tx
      .update(outboxEvents)
      .set({
        status: 'pending',
        lastError: lastError?.slice(0, 2000) ?? null,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
      })
      .where(eq(outboxEvents.id, event.id)),
  );
}

async function markDispatched(eventId: string): Promise<void> {
  await getContext().platform((tx) =>
    tx
      .update(outboxEvents)
      .set({ status: 'dispatched', dispatchedAt: new Date(), lastError: null })
      .where(eq(outboxEvents.id, eventId)),
  );
}

/**
 * Verifies an incoming BrandLens signature. Exported so integration tests — and
 * customers reading the source — have a reference implementation that is
 * definitionally correct.
 */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = createHmac(env.WEBHOOK_SIGNING_ALGO, secret).update(`${timestamp}.${body}`).digest('hex');
  const provided = signature.includes('=') ? signature.split('=')[1] : signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Used by the reconciler to surface a backlog before anyone notices by hand. */
export async function pendingOutboxCount(): Promise<number> {
  const rows = await getContext().platform((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.nextAttemptAt, new Date()))),
  );
  return rows[0]?.n ?? 0;
}
