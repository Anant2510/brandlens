import { QUEUES } from '@brandlens/contracts';
import { closeDb } from '@brandlens/db';
import { env } from './config';
import { logger } from './logger';
import { getContext } from './context';
import { WorkerRuntime } from './runtime';

import { ingestAsset, type IngestAssetJob } from './handlers/ingest-asset';
import { analyzeAsset, type AnalyzeAssetJob } from './handlers/analyze-asset';
import { embedAsset, type EmbedAssetJob } from './handlers/embed-asset';
import {
  compileRuleset,
  extractBrandDocument,
  induceRules,
  type CompileRulesetJob,
  type ExtractDocumentJob,
  type InduceRulesJob,
} from './handlers/ontology';
import { calibrateRule, indexPrecedent, type CalibrateRuleJob, type IndexPrecedentJob } from './handlers/learning';
import {
  assembleBrief,
  predictAsset,
  type AssembleBriefJob,
  type PredictAssetJob,
} from './handlers/assemble-predict';
import { discoverBrand, type DiscoverBrandJob } from './handlers/discover-brand';
import { dispatchOutbox, type DispatchOutboxJob } from './handlers/dispatch-outbox';
import { reconcile, type ReconcileJob } from './handlers/reconcile';

/**
 * BrandLens worker.
 *
 * One process, every queue in `contracts/events.ts`, with separate concurrency
 * per resource pool so ffmpeg-shaped work never starves the LLM path.
 *
 * Every handler is idempotent: at-least-once delivery is the only guarantee
 * pg-boss offers, and a duplicate `analyze.asset` that re-billed a run would
 * be the most expensive bug in the system.
 */
async function main(): Promise<void> {
  const runtime = new WorkerRuntime();

  runtime.register<IngestAssetJob & Record<string, unknown>>(QUEUES.ingestAsset, (data) =>
    ingestAsset(data as IngestAssetJob, runtime),
  );

  runtime.register<AnalyzeAssetJob & Record<string, unknown>>(QUEUES.analyzeAsset, (data) =>
    analyzeAsset(data as AnalyzeAssetJob),
  );

  runtime.register<EmbedAssetJob & Record<string, unknown>>(QUEUES.embedAsset, (data) =>
    embedAsset(data as EmbedAssetJob),
  );

  runtime.register<ExtractDocumentJob & Record<string, unknown>>(QUEUES.extractBrandDocument, (data) =>
    extractBrandDocument(data as ExtractDocumentJob),
  );

  runtime.register<InduceRulesJob & Record<string, unknown>>(QUEUES.induceRules, (data) =>
    induceRules(data as InduceRulesJob),
  );

  runtime.register<CompileRulesetJob & Record<string, unknown>>(QUEUES.compileRuleset, (data) =>
    compileRuleset(data as CompileRulesetJob),
  );

  runtime.register<IndexPrecedentJob & Record<string, unknown>>(QUEUES.indexPrecedent, (data) =>
    indexPrecedent(data as IndexPrecedentJob),
  );

  runtime.register<CalibrateRuleJob & Record<string, unknown>>(QUEUES.calibrateRule, (data) =>
    calibrateRule(data as CalibrateRuleJob),
  );

  runtime.register<AssembleBriefJob & Record<string, unknown>>(QUEUES.assembleBrief, (data) =>
    assembleBrief(data as AssembleBriefJob),
  );

  runtime.register<PredictAssetJob & Record<string, unknown>>(QUEUES.predictAsset, (data) =>
    predictAsset(data as PredictAssetJob),
  );

  runtime.register<DiscoverBrandJob & Record<string, unknown>>(QUEUES.discoverBrand, (data) =>
    discoverBrand(data as DiscoverBrandJob),
  );

  runtime.register<DispatchOutboxJob & Record<string, unknown>>(QUEUES.dispatchOutbox, (data) =>
    dispatchOutbox(data as DispatchOutboxJob),
  );

  runtime.register<ReconcileJob & Record<string, unknown>>(QUEUES.reconcile, (data) =>
    reconcile(data as ReconcileJob, runtime),
  );

  await runtime.start();

  // The relay also polls, so a lost nudge from the API only delays delivery.
  await runtime.schedule(QUEUES.dispatchOutbox, '* * * * *', { reason: 'cron' });
  // The reconciler is the only thing that notices a SIGKILLed handler.
  await runtime.schedule(QUEUES.reconcile, '*/5 * * * *', { reason: 'cron' });

  // Touch the context so a bad DATABASE_URL fails at boot rather than on the
  // first job, when it looks like a queue problem instead of a config problem.
  getContext();

  const engineHealth = await getContext().engine.health();
  logger.info(
    {
      queueSchema: env.QUEUE_SCHEMA,
      concurrency: {
        cpu_media: env.QUEUE_CONCURRENCY_CPU,
        llm_io: env.QUEUE_CONCURRENCY_LLM,
        default: env.QUEUE_CONCURRENCY_DEFAULT,
      },
      storageDriver: env.STORAGE_DRIVER,
      engine: engineHealth.status,
    },
    'BrandLens worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Graceful: in-flight jobs finish so a deploy cannot leave a check run
    // half-written with no queue entry to retry it.
    await runtime.stop();
    await closeDb().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: String(err) }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'worker failed to start');
  process.exit(1);
});
