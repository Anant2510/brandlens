import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { QUEUES, QUEUE_POOL, type QueueName } from '@brandlens/contracts';
import { AppConfigService } from '../config/config.service';

export interface EnqueueOptions {
  /** pg-boss collapses concurrent sends that share a singleton key. */
  singletonKey?: string;
  priority?: number;
  startAfterSeconds?: number;
  retryLimit?: number;
}

/**
 * pg-boss, not BullMQ.
 *
 * The deployment target is a Windows VM with no Docker and no Redis, so the
 * queue has to live in the database we already have. That is not purely a
 * constraint: because jobs are rows, a job can be enqueued in the SAME
 * transaction as the state change that justifies it, which removes an entire
 * class of "committed but never queued" bugs.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;
  private started = false;

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureStarted();
    } catch (err) {
      // The API must still serve reads when the queue is unreachable; the
      // health endpoint reports the degradation and enqueues fail loudly.
      this.logger.error({ err: String(err) }, 'pg-boss failed to start; queueing is degraded');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) await this.boss.stop({ graceful: true, wait: true }).catch(() => undefined);
    this.boss = null;
    this.started = false;
  }

  private async ensureStarted(): Promise<PgBoss> {
    if (this.boss && this.started) return this.boss;
    this.boss = new PgBoss({
      connectionString: this.config.env.DATABASE_URL,
      schema: this.config.env.QUEUE_SCHEMA,
      // The API only publishes; the worker owns maintenance and archiving.
      supervise: false,
      schedule: false,
      max: 4,
    });
    this.boss.on('error', (err) => this.logger.error({ err: String(err) }, 'pg-boss error'));
    await this.boss.start();

    // pg-boss v10 requires queues to exist before a send. Creating them here
    // means a fresh install works without a separate provisioning step.
    for (const name of Object.values(QUEUES)) {
      await this.boss.createQueue(name).catch(() => undefined);
    }
    this.started = true;
    return this.boss;
  }

  async enqueue<T extends object>(queue: QueueName, data: T, options: EnqueueOptions = {}): Promise<string | null> {
    const boss = await this.ensureStarted();

    // pg-boss v10 validates on key PRESENCE, not on value: passing
    // `priority: undefined` fails with "priority must be an integer". So the
    // options object is built up rather than spread with optionals.
    const send: Record<string, unknown> = {
      retryLimit: options.retryLimit ?? this.config.env.QUEUE_RETRY_LIMIT,
      retryBackoff: this.config.env.QUEUE_RETRY_BACKOFF,
      retryDelay: 5,
    };
    if (options.singletonKey !== undefined) send.singletonKey = options.singletonKey;
    if (options.priority !== undefined) send.priority = options.priority;
    if (options.startAfterSeconds !== undefined) send.startAfter = options.startAfterSeconds;

    return boss.send(queue, data, send);
  }

  poolOf(queue: QueueName): 'cpu_media' | 'llm_io' | 'default' {
    return QUEUE_POOL[queue];
  }

  async healthy(): Promise<{ ok: boolean; queues: Record<string, number>; error?: string }> {
    try {
      const boss = await this.ensureStarted();
      const queues: Record<string, number> = {};
      for (const name of Object.values(QUEUES)) {
        queues[name] = await boss.getQueueSize(name).catch(() => -1);
      }
      return { ok: true, queues };
    } catch (err) {
      return { ok: false, queues: {}, error: String(err) };
    }
  }
}
