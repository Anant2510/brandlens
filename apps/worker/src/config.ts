import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * The worker reads the SAME repo-root .env as the API and the engine. Two
 * processes disagreeing about `QUEUE_SCHEMA` or `ENGINE_SHARED_SECRET` is a
 * silent, hours-long failure, so there is exactly one file.
 */
function loadRepoRootEnv(): void {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, '.env'))) {
      loadDotenv({ path: resolve(dir, '.env') });
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

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

export const WorkerEnvSchema = z.object({
  NODE_ENV: str('development'),
  LOG_LEVEL: str('info'),

  DATABASE_URL: str('postgresql://brandlens:brandlens@localhost:5432/brandlens'),
  DATABASE_POOL_MAX: num(20),
  DATABASE_SSL: bool(false),

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

  API_PUBLIC_URL: str('http://localhost:4000'),
  ENGINE_URL: str('http://127.0.0.1:8000'),
  ENGINE_SHARED_SECRET: str('change-me-engine-shared-secret'),
  ENGINE_TIMEOUT_MS: num(180_000),

  LLM_JUDGE_PROVIDER: str('anthropic'),
  LLM_JUDGE_MODEL: str('claude-sonnet-4-5-20250929'),
  LLM_EXTRACT_PROVIDER: str('anthropic'),
  LLM_EXTRACT_MODEL: str('claude-sonnet-4-5-20250929'),
  LLM_TEXT_PROVIDER: str('anthropic'),
  LLM_TEXT_MODEL: str('claude-sonnet-4-5-20250929'),

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
  COST_JOB_USD_LIMIT: num(2.5),

  WEBHOOK_SIGNING_ALGO: str('sha256'),
  WEBHOOK_MAX_ATTEMPTS: num(8),
  WEBHOOK_TIMEOUT_MS: num(10_000),

  /** How long a `running` check run may sit before the reconciler requeues it. */
  RECONCILE_STUCK_MINUTES: num(30),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const env: WorkerEnv = WorkerEnvSchema.parse(process.env);

export function concurrencyFor(pool: 'cpu_media' | 'llm_io' | 'default'): number {
  if (pool === 'cpu_media') return env.QUEUE_CONCURRENCY_CPU;
  if (pool === 'llm_io') return env.QUEUE_CONCURRENCY_LLM;
  return env.QUEUE_CONCURRENCY_DEFAULT;
}
