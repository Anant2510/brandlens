import PgBoss from 'pg-boss';
import { QUEUES, QUEUE_POOL, type QueueName } from '@brandlens/contracts';
import { concurrencyFor, env } from './config';
import { logger } from './logger';

export type JobPool = 'cpu_media' | 'llm_io' | 'default';

/** Every handler receives the job payload and returns nothing useful. */
export type JobHandler<T> = (data: T, meta: JobMeta) => Promise<void>;

export interface JobMeta {
  jobId: string;
  queue: QueueName;
  pool: JobPool;
  attempt: number;
}

interface Registration {
  queue: QueueName;
  handler: JobHandler<Record<string, unknown>>;
}

/**
 * pg-boss runtime with SEPARATE CONCURRENCY PER POOL.
 *
 * Three pools exist because the workloads have incompatible shapes:
 *   cpu_media — thumbnailing and probing, bound by CPU and disk;
 *   llm_io    — analyze/extract/predict, bound by remote latency, so a high
 *               concurrency is cheap and correct;
 *   default   — small bookkeeping jobs that must never queue behind either.
 *
 * Without the split, thirty concurrent ffmpeg-shaped jobs starve the LLM path
 * and a synchronous check that is waiting on the queue times out.
 *
 * pg-boss v10 hands the handler an ARRAY of jobs (`batchSize` per fetch), so
 * per-pool concurrency is expressed as batchSize plus bounded parallelism
 * inside the batch.
 */
export class WorkerRuntime {
  private boss: PgBoss | null = null;
  private readonly registrations: Registration[] = [];
  private stopping = false;

  register<T extends Record<string, unknown>>(queue: QueueName, handler: JobHandler<T>): void {
    this.registrations.push({ queue, handler: handler as JobHandler<Record<string, unknown>> });
  }

  async start(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.QUEUE_SCHEMA,
      // The worker owns maintenance and the cron scheduler; the API only sends.
      supervise: true,
      schedule: true,
      max: Math.max(4, Math.ceil(env.DATABASE_POOL_MAX / 2)),
      retryLimit: env.QUEUE_RETRY_LIMIT,
      retryBackoff: env.QUEUE_RETRY_BACKOFF,
      retryDelay: 5,
      // Keep completed jobs around long enough to debug a bad afternoon.
      deleteAfterDays: 7,
      archiveCompletedAfterSeconds: 3_600,
    });

    this.boss.on('error', (err) => logger.error({ err: String(err) }, 'pg-boss error'));
    await this.boss.start();

    for (const name of Object.values(QUEUES)) {
      // Idempotent; makes a fresh database work with no provisioning step.
      await this.boss.createQueue(name).catch(() => undefined);
    }

    for (const reg of this.registrations) {
      const pool = QUEUE_POOL[reg.queue];
      const concurrency = Math.max(1, concurrencyFor(pool));

      await this.boss.work<Record<string, unknown>>(
        reg.queue,
        { batchSize: concurrency, pollingIntervalSeconds: pool === 'llm_io' ? 1 : 2 },
        async (jobs) => {
          await runBounded(jobs, concurrency, async (job) => {
            const started = Date.now();
            const meta: JobMeta = { jobId: job.id, queue: reg.queue, pool, attempt: 0 };
            const log = logger.child({ queue: reg.queue, jobId: job.id, pool });
            try {
              await reg.handler(job.data ?? {}, meta);
              log.info({ durationMs: Date.now() - started }, 'job completed');
            } catch (err) {
              log.error({ durationMs: Date.now() - started, err: String(err) }, 'job failed');
              // Rethrowing lets pg-boss apply the retry policy. Handlers are
              // written to be idempotent precisely because this happens.
              throw err;
            }
          });
        },
      );

      logger.info({ queue: reg.queue, pool, concurrency }, 'handler registered');
    }
  }

  /** Enqueue from inside a handler (fan-out, follow-up work). */
  async send<T extends object>(
    queue: QueueName,
    data: T,
    options: { singletonKey?: string; startAfterSeconds?: number; retryLimit?: number } = {},
  ): Promise<string | null> {
    if (!this.boss) throw new Error('runtime not started');

    // pg-boss v10 validates on key PRESENCE, not on value: `priority:
    // undefined` fails with "priority must be an integer". Build, do not spread.
    const send: Record<string, unknown> = {
      retryLimit: options.retryLimit ?? env.QUEUE_RETRY_LIMIT,
      retryBackoff: env.QUEUE_RETRY_BACKOFF,
    };
    if (options.singletonKey !== undefined) send.singletonKey = options.singletonKey;
    if (options.startAfterSeconds !== undefined) send.startAfter = options.startAfterSeconds;

    return this.boss.send(queue, data, send);
  }

  /** Registers a cron schedule. Used for the outbox relay and the reconciler. */
  async schedule(queue: QueueName, cron: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!this.boss) throw new Error('runtime not started');
    await this.boss.schedule(queue, cron, data, { singletonKey: `cron:${queue}` }).catch((err) => {
      logger.warn({ queue, err: String(err) }, 'failed to register schedule');
    });
  }

  async stop(): Promise<void> {
    if (this.stopping || !this.boss) return;
    this.stopping = true;
    // Graceful: in-flight jobs finish rather than being abandoned mid-write.
    await this.boss.stop({ graceful: true, wait: true, timeout: 30_000 }).catch(() => undefined);
    this.boss = null;
  }

  get instance(): PgBoss | null {
    return this.boss;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function runBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      try {
        await fn(item);
      } catch (err) {
        // Collect rather than abort: one poisoned job in a batch must not
        // prevent its siblings from completing and being acknowledged.
        errors.push(err);
      }
    }
  });

  await Promise.all(workers);
  if (errors.length) throw errors[0];
}
