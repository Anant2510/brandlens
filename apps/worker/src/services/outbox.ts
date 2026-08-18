import { randomUUID } from 'node:crypto';
import type { Database } from '@brandlens/db';
import { outboxEvents } from '@brandlens/db';
import type { EventType } from '@brandlens/contracts';

export interface EmitInput {
  orgId: string;
  type: EventType;
  aggregateType: string;
  aggregateId?: string | null;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  version?: number;
}

/**
 * Transactional outbox, worker side.
 *
 * Always takes the caller's `tx`: the event row must commit with the state
 * change it describes. A handler that emits `check.completed` and then dies
 * before committing the run would otherwise tell the customer's system about a
 * result that does not exist.
 */
export async function emitEvent(tx: Database, input: EmitInput): Promise<string> {
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
    // At-least-once delivery means a handler re-runs; a duplicate idempotency
    // key means the event is already recorded, which is success.
    .onConflictDoNothing({ target: outboxEvents.idempotencyKey });
  return id;
}
