import { existsSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

/**
 * Walks up looking for the pnpm workspace marker.
 *
 * Anchoring on a marker file rather than on `__dirname` arithmetic survives
 * compilation: the API's entry point is `apps/api/dist/apps/api/src/main.js`,
 * so a hard-coded number of `..` segments differs between `tsx` and a built
 * bundle, and gets silently wrong the first time the output layout changes.
 */
export function findWorkspaceRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Turns a configured STORAGE_LOCAL_ROOT into an absolute directory.
 *
 * A relative value must resolve to the SAME directory in every process that
 * touches storage, and `process.cwd()` cannot deliver that: PM2 starts the API
 * with cwd `apps/api`, the worker with cwd `apps/worker`, and `pnpm db:seed`
 * runs with cwd `packages/db`. Resolving `./.storage` against cwd therefore
 * produced three different directories — the seed wrote 14 files to
 * `<repo>/.storage` and the API looked for them under `apps/api/.storage`,
 * found nothing, and served a 404 behind every thumbnail.
 *
 * The seed already anchored to the repo root (see `storageRoot()` in
 * packages/db/src/seed/lib/io.ts, whose comment predicts this exact failure).
 * This is the other half of that rule. The two must agree; if you change one,
 * change both.
 *
 * An absolute value is always honoured as-is, and is what production should
 * set. The workspace-root fallback exists so a developer who never sets the
 * variable still gets a coherent single directory.
 */
export function resolveStorageRoot(
  configured: string,
  options: { cwd?: string; workspaceRoot?: string | null } = {},
): string {
  if (isAbsolute(configured)) return normalize(configured);

  const cwd = options.cwd ?? process.cwd();
  const root = options.workspaceRoot === undefined ? findWorkspaceRoot(cwd) : options.workspaceRoot;

  // No workspace marker (a packaged deploy, an odd container layout): fall
  // back to cwd rather than guessing. Same behaviour as before this fix, so
  // an environment that was working keeps working.
  return resolve(root ?? cwd, configured);
}
