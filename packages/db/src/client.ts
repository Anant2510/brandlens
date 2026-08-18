import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Database | undefined;

export interface DbOptions {
  connectionString?: string;
  max?: number;
  ssl?: boolean;
}

export function createPool(opts: DbOptions = {}): pg.Pool {
  const connectionString =
    opts.connectionString ??
    process.env.DATABASE_URL ??
    'postgresql://brandlens:brandlens@localhost:5432/brandlens';

  return new pg.Pool({
    connectionString,
    max: opts.max ?? Number(process.env.DATABASE_POOL_MAX ?? 20),
    ssl: (opts.ssl ?? process.env.DATABASE_SSL === 'true') ? { rejectUnauthorized: false } : undefined,
    // A stuck media parse must not hold a connection forever.
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 60_000,
    application_name: 'brandlens',
  });
}

export function getPool(opts?: DbOptions): pg.Pool {
  if (!pool) pool = createPool(opts);
  return pool;
}

export function getDb(opts?: DbOptions): Database {
  if (!db) db = drizzle(getPool(opts), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

/* ==========================================================================
 * Tenant context
 *
 * RLS reads `app.tenant_id`. With a transaction-pooling proxy (PgBouncer),
 * a plain `SET` leaks across pooled connections — a cross-tenant data breach
 * waiting to happen. `SET LOCAL` inside an explicit transaction is the only
 * safe form, so this helper is the ONLY sanctioned way to run tenant queries.
 * ========================================================================== */
export async function withTenant<T>(
  database: Database,
  ctx: { orgId: string; userId?: string; bypassRls?: boolean },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${ctx.orgId}, true)`);
    if (ctx.userId) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);
    }
    await tx.execute(
      sql`SELECT set_config('app.bypass_rls', ${ctx.bypassRls ? 'on' : 'off'}, true)`,
    );
    return fn(tx as unknown as Database);
  });
}

/** Detects whether pgvector is installed so the vector layer can pick a driver. */
export async function detectPgvector(database: Database): Promise<boolean> {
  try {
    const res = await database.execute<{ installed: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed`,
    );
    const row = (res as unknown as { rows: { installed: boolean }[] }).rows?.[0];
    return Boolean(row?.installed);
  } catch {
    return false;
  }
}

export { schema, sql };
