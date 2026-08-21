import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, resolveStorageRoot } from './workspace-root';

/**
 * Regression guard for the defect where every asset thumbnail 404'd.
 *
 * `pnpm db:seed` (cwd `packages/db`) wrote 14 files to `<repo>/.storage`
 * because the seed anchors a relative STORAGE_LOCAL_ROOT to the repo root.
 * The API (cwd `apps/api` under PM2) anchored the same value to `process.cwd()`
 * and looked in `apps/api/.storage`, which does not exist. Both halves must
 * resolve `./.storage` to one directory.
 */

const scratch = mkdtempSync(resolve(tmpdir(), 'bl-workspace-'));
const repo = resolve(scratch, 'repo');
const appCwd = resolve(repo, 'apps', 'api');
const seedCwd = resolve(repo, 'packages', 'db');

mkdirSync(appCwd, { recursive: true });
mkdirSync(seedCwd, { recursive: true });
writeFileSync(resolve(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');

afterAll(() => {
  // Left in the OS temp dir on purpose: rm -rf on a computed path in a test is
  // how a bad refactor deletes someone's home directory.
});

describe('findWorkspaceRoot', () => {
  it('finds the marker from a nested package directory', () => {
    expect(findWorkspaceRoot(appCwd)).toBe(repo);
    expect(findWorkspaceRoot(seedCwd)).toBe(repo);
  });

  it('finds the marker when already standing on it', () => {
    expect(findWorkspaceRoot(repo)).toBe(repo);
  });

  it('returns null rather than guessing when there is no workspace above', () => {
    expect(findWorkspaceRoot(scratch)).toBeNull();
  });
});

describe('resolveStorageRoot', () => {
  it('resolves the shipped default identically from every service cwd', () => {
    const fromApi = resolveStorageRoot('./.storage', { cwd: appCwd });
    const fromSeed = resolveStorageRoot('./.storage', { cwd: seedCwd });

    expect(fromApi).toBe(fromSeed);
    expect(fromApi).toBe(resolve(repo, '.storage'));
  });

  it('does NOT resolve against cwd — the bug this file exists for', () => {
    expect(resolveStorageRoot('./.storage', { cwd: appCwd })).not.toBe(resolve(appCwd, '.storage'));
  });

  it('honours an absolute path unchanged', () => {
    const abs = resolve(sep, 'brandlens', '.storage');
    expect(resolveStorageRoot(abs, { cwd: appCwd })).toBe(abs);
  });

  it('normalises an absolute path with redundant segments', () => {
    const messy = resolve(sep, 'brandlens', 'apps', '..', '.storage');
    expect(resolveStorageRoot(messy, { cwd: appCwd })).toBe(resolve(sep, 'brandlens', '.storage'));
  });

  it('falls back to cwd when no workspace marker exists, preserving old behaviour', () => {
    expect(resolveStorageRoot('./.storage', { cwd: appCwd, workspaceRoot: null })).toBe(resolve(appCwd, '.storage'));
  });

  it('accepts a bare relative name as well as a dot-prefixed one', () => {
    expect(resolveStorageRoot('.storage', { cwd: appCwd })).toBe(resolve(repo, '.storage'));
    expect(resolveStorageRoot('var/blobs', { cwd: appCwd })).toBe(resolve(repo, 'var', 'blobs'));
  });
});
