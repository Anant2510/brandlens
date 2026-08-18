import { z } from 'zod';

/**
 * Versioned domain events. Emitted through the transactional outbox so a
 * webhook is never sent for a transaction that rolled back, and never lost
 * for one that committed.
 */
export const EVENT_TYPES = [
  'asset.ingested',
  'asset.derivative.ready',
  'asset.embedded',
  'ruleset.published',
  'rule.proposed',
  'rule.activated',
  'check.started',
  'check.completed',
  'check.failed',
  'finding.created',
  'review.assigned',
  'review.decided',
  'precedent.indexed',
  'calibration.updated',
  'budget.threshold_crossed',
  'brief.assembled',
  'prediction.completed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventEnvelope = z.object({
  id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  version: z.number().int().default(1),
  orgId: z.string().uuid(),
  aggregateType: z.string(),
  aggregateId: z.string().uuid().nullable(),
  occurredAt: z.string(),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Job names on the pg-boss queue, grouped by the resource pool they belong to. */
export const QUEUES = {
  ingestAsset: 'ingest.asset',
  analyzeAsset: 'analyze.asset',
  embedAsset: 'embed.asset',
  extractBrandDocument: 'ontology.extract-document',
  induceRules: 'ontology.induce-rules',
  compileRuleset: 'ontology.compile-ruleset',
  indexPrecedent: 'learning.index-precedent',
  calibrateRule: 'learning.calibrate-rule',
  assembleBrief: 'assemble.brief',
  predictAsset: 'predict.asset',
  dispatchOutbox: 'platform.dispatch-outbox',
  reconcile: 'platform.reconcile',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Separate pools per resource profile so ffmpeg never starves the LLM path. */
export const QUEUE_POOL: Record<QueueName, 'cpu_media' | 'llm_io' | 'default'> = {
  [QUEUES.ingestAsset]: 'cpu_media',
  [QUEUES.analyzeAsset]: 'llm_io',
  [QUEUES.embedAsset]: 'cpu_media',
  [QUEUES.extractBrandDocument]: 'llm_io',
  [QUEUES.induceRules]: 'cpu_media',
  [QUEUES.compileRuleset]: 'default',
  [QUEUES.indexPrecedent]: 'default',
  [QUEUES.calibrateRule]: 'default',
  [QUEUES.assembleBrief]: 'llm_io',
  [QUEUES.predictAsset]: 'llm_io',
  [QUEUES.dispatchOutbox]: 'default',
  [QUEUES.reconcile]: 'default',
};
