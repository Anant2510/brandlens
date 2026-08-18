import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { type Database, outboxEvents } from '@brandlens/db';
import { QUEUES, type EventType } from '@brandlens/contracts';
import { TenantRepository } from '../database/tenant.repository';
import { QueueService } from '../queue/queue.service';

export interface EmitInput {
  orgId: string;
  type: EventType;
  aggregateType: string;
  aggregateId?: string | null;
  payload: Record<string, unknown>;
  /** Collapses logical duplicates: retrying a handler must not double-fire. */
  idempotencyKey?: string;
  version?: number;
}

/**
 * Transactional outbox.
 *
 * The event row is written with the SAME `tx` as the state change it
 * describes, so the two commit or roll back together. Sending a webhook
 * directly from the request handler has two failure modes and both are bad:
 * the HTTP call succeeds and the transaction rolls back (a customer's system
 * now believes in a check run that does not exist), or the transaction commits
 * and the process dies before the call (the event is gone forever). A row in
 * the same commit has neither.
 *
 * A separate relay (`platform.dispatch-outbox` in the worker) drains the table.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly queue: QueueService,
  ) {}

  /** Enlists in the caller's transaction. This is the form you should use. */
  async emitIn(tx: Database, input: EmitInput): Promise<string> {
    const id = randomUUID();
    await tx
      .insert(outboxEvents)
      .values({
        id,
        orgId: input.orgId,
        eventType: input.type,
        eventVersion: input.version ?? 1,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId ?? null,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? `${input.type}:${input.aggregateId ?? id}`,
        status: 'pending',
      })
      // A duplicate idempotency key means the event is already recorded; that
      // is success, not an error.
      .onConflictDoNothing({ target: outboxEvents.idempotencyKey });
    return id;
  }

  /** Standalone emit, then a best-effort nudge so the relay picks it up now. */
  async emit(input: EmitInput): Promise<string> {
    const id = await this.repo.runAs(input.orgId, undefined, (tx) => this.emitIn(tx, input));
    void this.nudge();
    return id;
  }

  /**
   * Asks the relay to run immediately. Purely an optimisation — the worker
   * also polls on a schedule, so a lost nudge only delays delivery.
   */
  async nudge(): Promise<void> {
    try {
      await this.queue.enqueue(QUEUES.dispatchOutbox, { reason: 'nudge' }, { singletonKey: 'outbox-nudge' });
    } catch (err) {
      this.logger.debug({ err: String(err) }, 'outbox nudge failed (relay will poll)');
    }
  }

  /** Used by the relay and by `/health/deep`. */
  async pendingCount(): Promise<number> {
    const rows = await this.repo.platform((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.nextAttemptAt, new Date()))),
    );
    return rows[0]?.n ?? 0;
  }
}
