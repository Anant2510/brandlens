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
import { env } from '../config';
import { logger } from '../logger';
import { resolveEnginePath } from '@brandlens/api/engine/engine-path';

/**
 * Worker-side engine client.
 *
 * Same protocol as the API's, with longer default timeouts and more retries:
 * a queued job can afford to wait for a restarting engine, whereas a
 * synchronous HTTP request cannot.
 */
export class EngineClient {
  private consecutiveFailures = 0;
  private openUntil = 0;

  get baseUrl(): string {
    return env.ENGINE_URL.replace(/\/$/, '');
  }

  analyze(body: AnalyzeRequest, correlationId?: string): Promise<z.infer<typeof AnalyzeResponse>> {
    return this.post('/analyze', body as unknown as Record<string, unknown>, AnalyzeResponse, { correlationId });
  }

  extractRules(body: Record<string, unknown>): Promise<z.infer<typeof ExtractRulesResponse>> {
    return this.post('/extract-rules', body, ExtractRulesResponse, { timeoutMs: 900_000 });
  }

  induceRules(body: Record<string, unknown>): Promise<z.infer<typeof InduceRulesResponse>> {
    return this.post('/induce-rules', body, InduceRulesResponse, { timeoutMs: 900_000 });
  }

  assemble(body: Record<string, unknown>): Promise<z.infer<typeof AssembleResponse>> {
    return this.post('/assemble', body, AssembleResponse, { timeoutMs: 300_000 });
  }

  predict(body: Record<string, unknown>): Promise<z.infer<typeof PredictResponse>> {
    return this.post('/predict', body, PredictResponse, { timeoutMs: 300_000 });
  }

  embed(body: {
    orgId: string;
    space: 'image' | 'text';
    items: Array<{ id: string; uri?: string; text?: string }>;
  }): Promise<{ vectors: Array<{ id: string; vec: number[]; modelId: string; dim: number }> }> {
    return this.post(
      '/embed',
      body as unknown as Record<string, unknown>,
      z.object({
        vectors: z.array(
          z.object({ id: z.string(), vec: z.array(z.number()), modelId: z.string(), dim: z.number().int() }),
        ),
      }),
      { timeoutMs: 120_000 },
    );
  }

  async health(): Promise<z.infer<typeof EngineHealth> | { status: 'error'; error: string }> {
    try {
      const res = await this.request('GET', '/health', undefined, { timeoutMs: 5_000, retries: 0 });
      return EngineHealth.parse(res);
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async post<T extends z.ZodTypeAny>(
    path: string,
    body: Record<string, unknown>,
    schema: T,
    options: { timeoutMs?: number; retries?: number; correlationId?: string } = {},
  ): Promise<z.infer<T>> {
    const raw = await this.request('POST', path, body, options);
    return schema.parse(raw) as z.infer<T>;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    options: { timeoutMs?: number; retries?: number; correlationId?: string } = {},
  ): Promise<unknown> {
    if (Date.now() < this.openUntil) {
      throw new Error('engine circuit breaker is open');
    }

    const retries = options.retries ?? 3;
    const timeoutMs = options.timeoutMs ?? env.ENGINE_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await fetch(`${this.baseUrl}${resolveEnginePath(path)}`, {
          method,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json',
            'x-engine-secret': env.ENGINE_SHARED_SECRET,
            ...(options.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
          const text = (await res.text()).slice(0, 500);
          if (res.status < 500) {
            // Our request is malformed; retrying cannot help and must not
            // count against the breaker.
            this.consecutiveFailures = 0;
            throw new Error(`engine rejected request (${res.status}): ${text}`);
          }
          throw new Error(`engine ${res.status}: ${text}`);
        }

        this.consecutiveFailures = 0;
        return await res.json();
      } catch (err) {
        lastError = err;
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 8) {
          this.openUntil = Date.now() + 30_000;
          this.consecutiveFailures = 0;
        }
        logger.warn({ path, attempt, err: String(err) }, 'engine call failed');
        if (attempt < retries) {
          await sleep(Math.min(15_000, 2 ** attempt * 1_000) + Math.random() * 500);
        }
      }
    }

    throw new Error(`engine ${path} failed after ${retries + 1} attempts: ${String(lastError)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
