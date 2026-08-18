/* ==========================================================================
 * Idempotent write helpers.
 *
 * `pnpm db:seed` runs on every deploy and on every developer's first
 * checkout, so it has to converge rather than accumulate. Combined with the
 * deterministic ids in lib/ids.ts, these two helpers give the seed exactly
 * two behaviours:
 *
 *   upsertRows   the row is rewritten from the seed definition — for
 *                mutable configuration (tokens, rules, brand metadata)
 *
 *   insertRows   the row is created once and never touched again — for
 *                append-only history (decision traces, audit log, ledger
 *                entries) where rewriting would be a lie about what happened
 * ========================================================================== */

import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../client.js';

type AnyTable = PgTable & { id?: unknown };

/**
 * Builds the `SET` clause for ON CONFLICT DO UPDATE, mapping every column to
 * its `excluded` value.
 *
 * `created_at` is excluded by default: a re-seed must not rewrite when a row
 * first appeared, or every "created in the last 7 days" panel in the console
 * resets itself on deploy.
 */
export function excludedSet(table: PgTable, skip: string[] = ['id', 'createdAt']): Record<string, SQL> {
  const columns = getTableColumns(table);
  const set: Record<string, SQL> = {};
  for (const [tsName, column] of Object.entries(columns)) {
    if (skip.includes(tsName)) continue;
    const dbName = (column as unknown as { name: string }).name;
    set[tsName] = sql.raw(`excluded."${dbName}"`);
  }
  return set;
}

/** Insert-or-refresh keyed on the primary key `id`. */
export async function upsertRows<T extends AnyTable>(
  tx: Database,
  table: T,
  rows: ReadonlyArray<Record<string, unknown>>,
  options: { skip?: string[] } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  await tx
    // drizzle's generics for a dynamically-built values array cannot be
    // expressed without the table's insert type in hand; the runtime shape is
    // checked by Postgres either way.
    .insert(table)
    .values(rows as never)
    .onConflictDoUpdate({
      target: (table as unknown as { id: never }).id,
      set: excludedSet(table, options.skip ?? ['id', 'createdAt']),
    });
  return rows.length;
}

/** Insert once; leave an existing row exactly as it is. */
export async function insertRows<T extends AnyTable>(
  tx: Database,
  table: T,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  if (rows.length === 0) return 0;
  await tx
    .insert(table)
    .values(rows as never)
    .onConflictDoNothing();
  return rows.length;
}
