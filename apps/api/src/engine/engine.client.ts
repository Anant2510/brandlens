import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  AnalyzeResponse,
  AssembleResponse,
  EngineHealth,
  ExtractRulesResponse,
  InduceRulesResponse,
  PredictResponse,
  type AnalyzeRequest,
} from '@brandlens/contracts';
import { AppConfigService } from '../config/config.service';
import { EngineUnavailableException } from '../common/errors';
import { CircuitBreaker } from './circuit-breaker';
import { resolveEnginePath } from './engine-path';

export interface EngineCallOptions {
  timeoutMs?: number;
  retries?: number;
  correlationId?: string;
}

interface EngineRequestBody {
  [key: string]: unknown;
}

/**
 * The single seam between the TypeScript control plane and the Python engine.
 *
 * Stateless by contract: every request carries the full brand context, rules
 * and precedents, so the engine can be restarted, scaled or moved onto a GPU
 * box with no coordination and no shared cache to invalidate.
 */
@Injectable()
export class EngineClient {
  private readonly logger = new Logger(EngineClient.name);
  private readonly breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, successThreshold: 2 });

  constructor(private readonly config: AppConfigService) {}

  get baseUrl(): string {
    return this.config.env.ENGINE_URL.replace(/\/$/, '');
  }


  analyze(body: AnalyzeRequest, options?: EngineCallOptions): Promise<z.infer<typeof AnalyzeResponse>> {
    return this.post('/analyze', body as unknown as EngineRequestBody, AnalyzeResponse, options);
  }

  extractRules(body: EngineRequestBody, options?: EngineCallOptions): Promise<z.infer<typeof ExtractRulesResponse>> {
    // Brand-book extraction is long-context vision work; it gets a longer leash.
    return this.post('/extract-rules', body, ExtractRulesResponse, { timeoutMs: 600_000, ...options });
  }

  induceRules(body: EngineRequestBody, options?: EngineCallOptions): Promise<z.infer<typeof InduceRulesResponse>> {
    return this.post('/induce-rules', body, InduceRulesResponse, { timeoutMs: 600_000, ...options });
  }

  assemble(body: EngineRequestBody, options?: EngineCallOptions): Promise<z.infer<typeof AssembleResponse>> {
    return this.post('/assemble', body, AssembleResponse, options);
  }

  predict(body: EngineRequestBody, options?: EngineCallOptions): Promise<z.infer<typeof PredictResponse>> {
    return this.post('/predict', body, PredictResponse, options);
  }

  embed(
    body: { orgId: string; space: 'image' | 'text'; items: Array<{ id: string; uri?: string; text?: string }> },
    options?: EngineCallOptions,
  ): Promise<{ vectors: Array<{ id: string; vec: number[]; modelId: string; dim: number }> }> {
    return this.post(
      '/embed',
      body as unknown as EngineRequestBody,
      z.object({
        vectors: z.array(
          z.object({ id: z.string(), vec: z.array(z.number()), modelId: z.string(), dim: z.number().int() }),
        ),
      }),
      options,
    );
  }

  /**
   * Liveness only. `/health` on the engine is deliberately unauthenticated and
   * cheap so a load balancer can hit it; it reports whether the process is up,
   * NOT what it can do. Capability lives on `/health/deep` — parsing this
   * response against the full `EngineHealth` schema would always fail.
   */
  async health(): Promise<{ status: 'ok' | 'error'; engineVersion?: string; error?: string }> {
    try {
      const res = (await this.request('GET', '/health', undefined, {
        timeoutMs: 5_000,
        retries: 0,
      })) as { status?: string; engineVersion?: string };
      return { status: res?.status === 'ok' ? 'ok' : 'error', engineVersion: res?.engineVersion };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Capability probe: which analyzers are registered, which LLM roles have
   * credentials, which OCR driver resolved. `degraded` here is a normal and
   * expected state — an engine with no API keys still runs every T0/T1 check,
   * it just abstains on T2 rather than inventing verdicts.
   */
  async healthDeep(): Promise<z.infer<typeof EngineHealth> | { status: 'error'; error: string }> {
    try {
      const res = await this.request('GET', '/health/deep', undefined, {
        timeoutMs: 8_000,
        retries: 0,
      });
      return EngineHealth.parse(res);
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  breakerState(): { state: string; failures: number; openedAt: number | null } {
    return this.breaker.snapshot();
  }

  private async post<T extends z.ZodTypeAny>(
    path: string,
    body: EngineRequestBody,
    schema: T,
    options?: EngineCallOptions,
  ): Promise<z.infer<T>> {
    const raw = await this.request('POST', path, body, options);
    // Parsing the response against the contract at the boundary means a
    // protocol drift shows up here with a useful message, rather than as an
    // undefined three layers deeper while writing decision traces.
    return schema.parse(raw) as z.infer<T>;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: EngineRequestBody | undefined,
    options?: EngineCallOptions,
  ): Promise<unknown> {
    if (!this.breaker.canAttempt()) {
      throw new EngineUnavailableException('Engine circuit breaker is open');
    }

    const retries = options?.retries ?? 2;
    const timeoutMs = options?.timeoutMs ?? this.config.env.ENGINE_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      try {
        const res = await fetch(`${this.baseUrl}${resolveEnginePath(path)}`, {
          method,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            // Shared secret rather than mTLS: the engine is a sibling process
            // on the same VM in the default deployment, and a rotating secret
            // in one .env is operable by the person who has to run this.
            'x-engine-secret': this.config.env.ENGINE_SHARED_SECRET,
            ...(options?.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status >= 500) throw new Error(`engine ${res.status}: ${(await res.text()).slice(0, 400)}`);
        if (!res.ok) {
          // 4xx is our bug, not theirs — retrying a malformed request just
          // burns time, so it fails immediately and closes the breaker path.
          this.breaker.recordSuccess();
          throw new EngineUnavailableException(`engine rejected request (${res.status}): ${(await res.text()).slice(0, 400)}`);
        }

        this.breaker.recordSuccess();
        return await res.json();
      } catch (err) {
        lastError = err;
        if (err instanceof EngineUnavailableException) throw err;
        this.breaker.recordFailure();
        this.logger.warn(
          { path, attempt, durationMs: Date.now() - startedAt, err: String(err) },
          'engine call failed',
        );
        if (attempt < retries) {
          // Exponential backoff with jitter: a restarting engine should not be
          // hit by every worker at the same millisecond.
          const delay = Math.min(8_000, 2 ** attempt * 500) + Math.random() * 250;
          await sleep(delay);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new EngineUnavailableException(
      `Engine call ${path} failed after ${retries + 1} attempts: ${String(lastError)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
