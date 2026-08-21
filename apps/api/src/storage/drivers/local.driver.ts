import { createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { PutOptions, StatResult, StorageDriver } from '../storage.driver';
import { resolveStorageRoot } from '../workspace-root';

/**
 * Filesystem driver — the default, and the one that has to be correct.
 *
 * Signing is HMAC-SHA256 over `key|expiry|disposition`. The API serves the
 * bytes itself at `/v1/assets/:id/preview`, so there is no static file server
 * to misconfigure and no directory left world-readable on the VM.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly signingSecret: string,
    private readonly publicUrl: string,
  ) {
    // Anchored to the workspace root, not process.cwd() — PM2 gives every
    // service a different cwd. See resolveStorageRoot for the full story.
    this.root = resolveStorageRoot(root);
  }

  /**
   * Every key is resolved and re-checked against the root. A storage key is
   * partly caller-influenced (asset names end up in it), so `../../` in a key
   * would otherwise be an arbitrary-file-write primitive.
   */
  private pathFor(key: string): string {
    const clean = normalize(key).replace(/^([/\\]|\.\.[/\\])+/, '');
    const full = resolve(this.root, clean);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _options?: PutOptions): Promise<StatResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, size: body.byteLength, contentType: _options?.contentType, updatedAt: new Date() };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const s = await stat(this.pathFor(key));
      return { key, size: s.size, updatedAt: s.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async engineUri(key: string): Promise<string> {
    // Same host: hand the engine a path and skip streaming the bytes twice.
    return this.pathFor(key);
  }

  async signedUrl(key: string, ttlSeconds: number, disposition: 'inline' | 'attachment' = 'inline'): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signLocalKey(this.signingSecret, key, expires, disposition);
    const params = new URLSearchParams({ key, expires: String(expires), disposition, sig });
    return `${this.publicUrl.replace(/\/$/, '')}/v1/storage/object?${params.toString()}`;
  }

  async healthy(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  get rootDir(): string {
    return this.root;
  }

  static join(...parts: string[]): string {
    return join(...parts).split(sep).join('/');
  }
}

export function signLocalKey(secret: string, key: string, expires: number, disposition: string): string {
  return createHmac('sha256', secret).update(`${key}|${expires}|${disposition}`).digest('hex');
}
