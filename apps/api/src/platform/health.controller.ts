import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/decorators/public.decorator';
import { TenantRepository } from '../database/tenant.repository';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { EngineClient } from '../engine/engine.client';
import { VectorSearchService } from '../learning/vector-search.service';
import { OutboxService } from './outbox.service';
import { AppConfigService } from '../config/config.service';
import { MetricsService } from './metrics.service';

interface ComponentHealth {
  ok: boolean;
  detail?: unknown;
  latencyMs?: number;
}

@ApiTags('platform')
@Controller()
export class HealthController {
  constructor(
    private readonly repo: TenantRepository,
    private readonly queue: QueueService,
    private readonly storage: StorageService,
    private readonly engine: EngineClient,
    private readonly vectors: VectorSearchService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness. Must stay dependency-free so a stuck DB does not kill the pod. */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  health(): { status: 'ok'; service: string; uptimeSeconds: number; version: string } {
    return {
      status: 'ok',
      service: 'brandlens-api',
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }

  /** Readiness. Every dependency, with the failure detail rather than a bare false. */
  @Public()
  @Get('health/deep')
  @ApiOperation({ summary: 'Deep health: DB, queue, storage, engine, vector driver, providers' })
  async deep(): Promise<{
    status: 'ok' | 'degraded';
    components: Record<string, ComponentHealth>;
    config: Record<string, unknown>;
  }> {
    const components: Record<string, ComponentHealth> = {};

    components.database = await timed(async () => {
      await this.repo.platform((tx) => tx.execute(sql`SELECT 1`));
      return {};
    });

    components.queue = await timed(async () => {
      const q = await this.queue.healthy();
      if (!q.ok) throw new Error(q.error ?? 'queue unavailable');
      return { queues: q.queues };
    });

    components.storage = await timed(async () => {
      const ok = await this.storage.healthy();
      if (!ok) throw new Error(`storage driver ${this.storage.driverName} unhealthy`);
      return { driver: this.storage.driverName };
    });

    components.engine = await timed(async () => {
      const h = await this.engine.healthDeep();
      if (h.status === 'error') throw new Error((h as { error: string }).error);
      // `degraded` is reachable-but-limited (typically: no LLM credentials, so
      // T2 abstains). That is a working system, not a broken component — the
      // deterministic and CV tiers still produce real, auditable findings.
      return { ...h, breaker: this.engine.breakerState() };
    });

    components.vector = await timed(async () => ({ driver: await this.vectors.resolveDriver() }));

    components.outbox = await timed(async () => ({ pending: await this.outbox.pendingCount() }));

    const providers = {
      judge: {
        provider: this.config.env.LLM_JUDGE_PROVIDER,
        model: this.config.env.LLM_JUDGE_MODEL,
        configured: this.config.providerConfigured(this.config.env.LLM_JUDGE_PROVIDER),
      },
      extract: {
        provider: this.config.env.LLM_EXTRACT_PROVIDER,
        model: this.config.env.LLM_EXTRACT_MODEL,
        configured: this.config.providerConfigured(this.config.env.LLM_EXTRACT_PROVIDER),
      },
      text: {
        provider: this.config.env.LLM_TEXT_PROVIDER,
        model: this.config.env.LLM_TEXT_MODEL,
        configured: this.config.providerConfigured(this.config.env.LLM_TEXT_PROVIDER),
      },
    };
    components.providers = { ok: providers.judge.configured, detail: providers };

    const status = Object.values(components).every((c) => c.ok) ? 'ok' : 'degraded';
    this.metrics.setHealth(status === 'ok');

    return {
      status,
      components,
      config: {
        nodeEnv: this.config.env.NODE_ENV,
        storageDriver: this.storage.driverName,
        queueSchema: this.config.env.QUEUE_SCHEMA,
        embeddingProvider: this.config.env.EMBEDDING_PROVIDER,
        ocrDriver: this.config.env.OCR_DRIVER,
        pipelineVersion: '1.0.0',
      },
    };
  }

  /** Prometheus text exposition. Public so a scraper needs no credentials. */
  @Public()
  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus metrics (text/plain; version=0.0.4)' })
  async metricsEndpoint(): Promise<string> {
    return this.metrics.render();
  }
}

async function timed(fn: () => Promise<Record<string, unknown>>): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}
