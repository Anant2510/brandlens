/**
 * Migration runner.
 *
 * Order matters and is not negotiable:
 *   1. extensions + portable helper functions
 *   2. drizzle-generated DDL
 *   3. RLS policies  (must come after the tables exist)
 *   4. vector acceleration (no-op without pgvector)
 *
 * Designed to be idempotent so `pnpm db:migrate` is safe to re-run on the
 * Windows VM after every deploy.
 */
import { config } from 'dotenv';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env') });

const SQL_DIR = resolve(here, 'sql');
const DRIZZLE_DIR = resolve(here, '../drizzle');

function log(step: string, msg: string) {
  process.stdout.write(`  ${step.padEnd(14)} ${msg}\n`);
}

async function runSqlFile(client: pg.Client, file: string) {
  const text = await readFile(resolve(SQL_DIR, file), 'utf8');
  await client.query(text);
  log('sql', file);
}

async function main() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://brandlens:brandlens@localhost:5432/brandlens';

  process.stdout.write('\nBrandLens · database migration\n');
  process.stdout.write(`  target        ${connectionString.replace(/:[^:@/]+@/, ':****@')}\n\n`);

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // 1 — extensions and helpers -------------------------------------------
    await runSqlFile(client, '00_extensions.sql');

    const { rows } = await client.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed`,
    );
    const hasPgvector = rows[0]?.installed ?? false;
    log('vector', hasPgvector ? 'pgvector detected → ANN enabled' : 'pgvector absent → real[] fallback');

    await client.query(
      `INSERT INTO public.system_state (key, value, updated_at)
         VALUES ('vector_driver', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ driver: hasPgvector ? 'pgvector' : 'fallback' })],
    ).catch(() => {
      /* system_state does not exist until drizzle runs; retried below. */
    });
  } finally {
    await client.end();
  }

  // 2 — drizzle DDL ---------------------------------------------------------
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool);

  if (!existsSync(DRIZZLE_DIR) || (await readdir(DRIZZLE_DIR)).filter((f) => f.endsWith('.sql')).length === 0) {
    process.stdout.write(
      '\n  ! No generated migrations found. Run `pnpm db:generate` first.\n\n',
    );
    await pool.end();
    process.exit(1);
  }

  await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  log('drizzle', 'schema applied');
  await pool.end();

  // 3 + 4 — RLS and vector acceleration -------------------------------------
  const post = new pg.Client({ connectionString });
  await post.connect();
  try {
    await post.query(`SELECT set_config('app.bypass_rls', 'on', false)`);
    await runSqlFile(post, '10_rls.sql');

    const dim = process.env.EMBEDDING_DIM ?? '1024';
    await post.query(`SELECT set_config('brandlens.embedding_dim', $1, false)`, [dim]);
    await runSqlFile(post, '20_vector.sql');

    const { rows } = await post.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed`,
    );
    await post.query(
      `INSERT INTO public.system_state (key, value, updated_at)
         VALUES ('vector_driver', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ driver: rows[0]?.installed ? 'pgvector' : 'fallback' })],
    );
  } finally {
    await post.end();
  }

  process.stdout.write('\n  ✓ migration complete\n\n');
}

main().catch((err) => {
  process.stderr.write(`\n  ✗ migration failed: ${err instanceof Error ? err.stack : String(err)}\n\n`);
  process.exit(1);
});
