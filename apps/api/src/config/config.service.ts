import { Injectable } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/* ==========================================================================
 * Typed configuration.
 *
 * There is exactly ONE .env, at the repo root, shared by the API, the worker
 * and the Python engine. Two services disagreeing about `ENGINE_SHARED_SECRET`
 * or `QUEUE_SCHEMA` is the kind of failure that costs an afternoon, so we make
 * it structurally impossible.
 * ========================================================================== */

function loadRepoRootEnv(): void {
  // dist/apps/api/src/config → repo root is five levels up in a built tree,
  // three levels up when running from source. Probe upwards for the marker.
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      loadDotenv({ path: resolve(dir, '.env') });
      return;
    }
    dir = resolve(dir, '..');
  }
  loadDotenv();
}

loadRepoRootEnv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

export const EnvSchema = z.object({
  NODE_ENV: str('development'),
  LOG_LEVEL: str('info'),

  DATABASE_URL: str('postgresql://brandlens:brandlens@localhost:5432/brandlens'),
  DATABASE_POOL_MAX: num(20),
  DATABASE_SSL: bool(false),
  VECTOR_DRIVER: str('auto'),

  QUEUE_SCHEMA: str('brandlens_queue'),
  QUEUE_CONCURRENCY_CPU: num(4),
  QUEUE_CONCURRENCY_LLM: num(12),
  QUEUE_CONCURRENCY_DEFAULT: num(8),
  QUEUE_RETRY_LIMIT: num(3),
  QUEUE_RETRY_BACKOFF: bool(true),

  STORAGE_DRIVER: str('local'),
  STORAGE_LOCAL_ROOT: str('./.storage'),
  STORAGE_SIGNING_SECRET: str('change-me-storage-signing-secret'),
  STORAGE_URL_TTL_SECONDS: num(900),
  S3_BUCKET_ORIGINALS: str(''),
  S3_BUCKET_DERIVATIVES: str(''),
  S3_REGION: str('us-east-1'),
  S3_ENDPOINT: str(''),
  S3_ACCESS_KEY_ID: str(''),
  S3_SECRET_ACCESS_KEY: str(''),
  AZURE_STORAGE_CONNECTION_STRING: str(''),
  AZURE_CONTAINER_ORIGINALS: str('originals'),
  AZURE_CONTAINER_DERIVATIVES: str('derivatives'),

  API_PORT: num(4000),
  API_HOST: str('0.0.0.0'),
  API_PUBLIC_URL: str('http://localhost:4000'),
  WEB_PUBLIC_URL: str('http://localhost:3000'),
  ENGINE_URL: str('http://127.0.0.1:8000'),
  ENGINE_SHARED_SECRET: str('change-me-engine-shared-secret'),
  ENGINE_TIMEOUT_MS: num(180_000),

  JWT_ACCESS_SECRET: str('change-me-access-secret-at-least-32-chars-long'),
  JWT_REFRESH_SECRET: str('change-me-refresh-secret-at-least-32-chars'),
  JWT_ACCESS_TTL: str('15m'),
  JWT_REFRESH_TTL: str('30d'),
  API_KEY_PEPPER: str('change-me-api-key-pepper'),

  LLM_JUDGE_PROVIDER: str('anthropic'),
  LLM_JUDGE_MODEL: str('claude-sonnet-4-5-20250929'),
  LLM_EXTRACT_PROVIDER: str('anthropic'),
  LLM_EXTRACT_MODEL: str('claude-sonnet-4-5-20250929'),
  LLM_TEXT_PROVIDER: str('anthropic'),
  LLM_TEXT_MODEL: str('claude-sonnet-4-5-20250929'),
  ANTHROPIC_API_KEY: str(''),
  OPENAI_API_KEY: str(''),
  AZURE_OPENAI_API_KEY: str(''),
  GOOGLE_API_KEY: str(''),
  OPENAI_COMPATIBLE_BASE_URL: str(''),

  EMBEDDING_PROVIDER: str('hash'),
  EMBEDDING_MODEL: str('text-embedding-3-small'),
  EMBEDDING_DIM: num(1024),
  IMAGE_EMBEDDING_PROVIDER: str('hash'),
  IMAGE_EMBEDDING_DIM: num(1024),

  JUDGE_TEMPERATURE: num(0),
  JUDGE_SELF_CONSISTENCY_K: num(1),
  JUDGE_SELF_CONSISTENCY_ESCALATE_K: num(3),
  JUDGE_PRECEDENT_K: num(6),
  JUDGE_MAX_IMAGE_EDGE: num(1568),
  JUDGE_ABSTAIN_CONFIDENCE: num(0.55),
  JUDGE_ENABLE_PROMPT_CACHE: bool(true),

  COST_TENANT_DAILY_USD_LIMIT: num(25),
  COST_JOB_USD_LIMIT: num(2.5),
  COST_DEGRADE_GRACEFULLY: bool(true),

  OCR_DRIVER: str('vlm'),

  WEBHOOK_SIGNING_ALGO: str('sha256'),
  WEBHOOK_MAX_ATTEMPTS: num(8),
  WEBHOOK_TIMEOUT_MS: num(10_000),
});

export type Env = z.infer<typeof EnvSchema>;

export type StorageDriverName = 'local' | 's3' | 'azure';
export type VectorDriverName = 'auto' | 'pgvector' | 'fallback';

@Injectable()
export class AppConfigService {
  readonly env: Env;

  constructor() {
    this.env = EnvSchema.parse(process.env);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get storageDriver(): StorageDriverName {
    const d = this.env.STORAGE_DRIVER;
    return d === 's3' || d === 'azure' ? d : 'local';
  }

  get vectorDriverPreference(): VectorDriverName {
    const d = this.env.VECTOR_DRIVER;
    return d === 'pgvector' || d === 'fallback' ? d : 'auto';
  }

  /** Queue pool → worker concurrency. Read by both the API and the worker. */
  concurrencyFor(pool: 'cpu_media' | 'llm_io' | 'default'): number {
    if (pool === 'cpu_media') return this.env.QUEUE_CONCURRENCY_CPU;
    if (pool === 'llm_io') return this.env.QUEUE_CONCURRENCY_LLM;
    return this.env.QUEUE_CONCURRENCY_DEFAULT;
  }

  /** The judge identity is part of every jobKey — a model swap invalidates. */
  get judgeModelVersion(): string {
    return `${this.env.LLM_JUDGE_PROVIDER}:${this.env.LLM_JUDGE_MODEL}`;
  }

  providerConfigured(provider: string): boolean {
    switch (provider) {
      case 'anthropic':
        return this.env.ANTHROPIC_API_KEY.length > 0;
      case 'openai':
        return this.env.OPENAI_API_KEY.length > 0;
      case 'azure-openai':
        return this.env.AZURE_OPENAI_API_KEY.length > 0;
      case 'google':
        return this.env.GOOGLE_API_KEY.length > 0;
      case 'openai-compatible':
        return this.env.OPENAI_COMPATIBLE_BASE_URL.length > 0;
      default:
        return false;
    }
  }
}
