import { type Database, getDb, withTenant } from '@brandlens/db';
import { env } from './config';
import { logger } from './logger';
import { EngineClient } from './services/engine.client';
import { StorageService } from './services/storage.service';

/**
 * A tiny hand-rolled container.
 *
 * The worker deliberately does not boot Nest: it needs four services and no
 * HTTP stack, and keeping it a plain Node process means a handler crash is a
 * stack trace rather than a DI resolution error three frames deep.
 */
export interface WorkerContext {
  db: Database;
  storage: StorageService;
  engine: EngineClient;
  /** The ONLY sanctioned way to run a tenant query — see packages/db/client.ts. */
  withTenant<T>(orgId: string, fn: (tx: Database) => Promise<T>): Promise<T>;
  /** Cross-tenant sweeps (the outbox relay, the reconciler). Greppable on purpose. */
  platform<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}

let context: WorkerContext | null = null;

export function getContext(): WorkerContext {
  if (context) return context;

  const db = getDb({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL,
  });

  context = {
    db,
    storage: new StorageService(),
    engine: new EngineClient(),
    withTenant: <T>(orgId: string, fn: (tx: Database) => Promise<T>) => withTenant(db, { orgId }, fn),
    platform: <T>(fn: (tx: Database) => Promise<T>) =>
      withTenant(db, { orgId: '00000000-0000-0000-0000-000000000000', bypassRls: true }, fn),
  };

  logger.debug('worker context initialised');
  return context;
}
