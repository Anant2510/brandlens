/** Drops and recreates the public schema. Development only. */
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to reset a production database.\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('DROP SCHEMA IF EXISTS public CASCADE');
await client.query('CREATE SCHEMA public');
await client.query(`DROP SCHEMA IF EXISTS ${process.env.QUEUE_SCHEMA ?? 'brandlens_queue'} CASCADE`);
await client.end();
process.stdout.write('  ✓ schema reset\n');
