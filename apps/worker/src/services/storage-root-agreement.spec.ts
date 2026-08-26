import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorageRoot } from '@brandlens/api/storage/workspace-root';

/**
 * An architectural test, not a behavioural one.
 *
 * Three processes read and write the same local storage directory: the API,
 * the worker, and the seed. PM2 gives each a DIFFERENT cwd — apps/api,
 * apps/worker, and packages/db for the seed — so the shipped relative default
 * `./.storage` resolves to three different directories if any of them uses
 * `process.cwd()`.
 *
 * This has now been the same bug twice. The first time, the seed wrote its
 * assets to <repo>/.storage and the API looked under apps/api/.storage, and
 * every thumbnail in the product was a 404. That was fixed by giving the API
 * and the seed a shared rule — and resolveStorageRoot's own comment says "the
 * two must agree; if you change one, change both".
 *
 * There were three. The worker was missed, so it wrote every discovery
 * screenshot to apps/worker/.storage while the API served 404 behind every
 * page thumbnail in a discovery report. The comment could not enforce itself.
 * This test can.
 *
 * If you are here because this failed: a relative STORAGE_LOCAL_ROOT must go
 * through resolveStorageRoot (or, in the seed, storageRoot()). Do not resolve
 * it against process.cwd(), because your cwd is not the other process's cwd.
 */

const WORKER_SRC = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('storage root resolution agrees across processes', () => {
  it('resolves a relative root the same way no matter which cwd asks', () => {
    // The whole point: apps/worker and apps/api must land in the same place.
    const workspaceRoot = '/srv/brandlens';
    const fromWorker = resolveStorageRoot('./.storage', { cwd: '/srv/brandlens/apps/worker', workspaceRoot });
    const fromApi = resolveStorageRoot('./.storage', { cwd: '/srv/brandlens/apps/api', workspaceRoot });
    const fromSeed = resolveStorageRoot('./.storage', { cwd: '/srv/brandlens/packages/db', workspaceRoot });

    expect(fromWorker).toBe(fromApi);
    expect(fromApi).toBe(fromSeed);
    expect(fromWorker).toBe(resolve('/srv/brandlens', './.storage'));
  });

  it('honours an absolute root untouched, which is what production should set', () => {
    expect(resolveStorageRoot('/var/lib/brandlens/storage', { cwd: '/anywhere', workspaceRoot: '/srv' })).toBe(
      resolve('/var/lib/brandlens/storage'),
    );
  });

  it('no worker source resolves STORAGE_LOCAL_ROOT against process.cwd()', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(WORKER_SRC)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('STORAGE_LOCAL_ROOT')) continue;
      // The config file DECLARES the variable; that is not a resolution site.
      if (relative(WORKER_SRC, file) === 'config.ts') continue;
      if (/process\.cwd\(\)/.test(source)) {
        offenders.push(relative(WORKER_SRC, file).split(sep).join('/'));
      }
      if (!source.includes('resolveStorageRoot')) {
        offenders.push(`${relative(WORKER_SRC, file).split(sep).join('/')} (does not use resolveStorageRoot)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
