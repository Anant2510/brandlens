/* ==========================================================================
 * Filesystem helpers for the seed.
 *
 * Generated images are written twice, on purpose:
 *
 *   seed/assets/…                a human-readable, reviewable copy checked in
 *                                alongside the seed code
 *   <STORAGE_LOCAL_ROOT>/…       the content-addressed blob the running
 *                                system actually serves
 *
 * The storage layout mirrors StorageService.keyFor() in apps/api exactly:
 *
 *     originals/<orgId>/<first 2 hex of sha256>/<sha256>.<ext>
 *
 * Sharding on the first byte of the hash keeps NTFS directory sizes sane;
 * addressing by hash rather than by asset id is what makes deduplication free.
 * ========================================================================== */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));

/** packages/db/src/seed/lib → repo root. */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..', '..');

export const SEED_ASSETS_DIR = resolve(REPO_ROOT, 'seed', 'assets');

/**
 * Resolves STORAGE_LOCAL_ROOT against the REPOSITORY ROOT rather than
 * process.cwd().
 *
 * `pnpm db:seed` runs with cwd = packages/db, while the API runs with
 * cwd = apps/api. A relative STORAGE_LOCAL_ROOT (the shipped default is
 * `./.storage`) would therefore resolve to two different directories and the
 * seeded assets would 404 in the console. Anchoring to the repo root makes
 * both agree for the default value.
 *
 * In production, set STORAGE_LOCAL_ROOT to an ABSOLUTE path
 * (e.g. C:\brandlens\.storage) so the question never arises. This is called
 * out in docs/deployment-windows.md.
 */
export function storageRoot(): string {
  const configured = process.env.STORAGE_LOCAL_ROOT ?? './.storage';
  return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
}

export type StorageBucket = 'originals' | 'derivatives';

/** Identical to StorageService.keyFor() in apps/api. */
export function storageKeyFor(bucket: StorageBucket, orgId: string, hash: string, ext = 'bin'): string {
  const clean = ext.replace(/^\./, '').toLowerCase().slice(0, 12) || 'bin';
  return `${bucket}/${orgId}/${hash.slice(0, 2)}/${hash}.${clean}`;
}

export async function writeFileEnsured(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export interface StoredFile {
  /** sha256 of the bytes — the asset's content_hash. */
  hash: string;
  /** Content-addressed storage key. */
  storageKey: string;
  /** Absolute path of the reviewable copy under seed/assets. */
  seedPath: string;
  bytes: number;
}

/**
 * Writes one generated file to both destinations and returns everything the
 * `assets` / `logo_variants` rows need.
 *
 * Overwriting unconditionally is correct and cheap: the encoder is
 * deterministic, so a re-run produces identical bytes at an identical key.
 */
export async function storeSeedFile(
  relativeSeedPath: string,
  orgId: string,
  bytes: Buffer,
  ext = 'png',
): Promise<StoredFile> {
  const hash = sha256(bytes);
  const storageKey = storageKeyFor('originals', orgId, hash, ext);

  const seedPath = resolve(SEED_ASSETS_DIR, relativeSeedPath);
  await writeFileEnsured(seedPath, bytes);
  await writeFileEnsured(resolve(storageRoot(), storageKey), bytes);

  return { hash, storageKey, seedPath, bytes: bytes.byteLength };
}
