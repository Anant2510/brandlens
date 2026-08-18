import { createHmac } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { env } from '../config';

/**
 * Worker-side storage.
 *
 * Only the `local` driver is implemented here on purpose: the s3/azure drivers
 * live in the API, and when either of them is configured the worker receives
 * presigned URLs rather than keys, so it fetches over HTTP instead of touching
 * a filesystem it may not share. `readOrFetch` is the single entry point that
 * hides that distinction.
 */
export class StorageService {
  private readonly root: string;

  constructor() {
    const configured = env.STORAGE_LOCAL_ROOT;
    this.root = isAbsolute(configured) ? normalize(configured) : resolve(process.cwd(), configured);
  }

  get driver(): string {
    return env.STORAGE_DRIVER;
  }

  private pathFor(key: string): string {
    const clean = normalize(key).replace(/^([/\\]|\.\.[/\\])+/, '');
    const full = resolve(this.root, clean);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  /** Reads a storage key, an absolute path, or an http(s) URL. */
  async readOrFetch(keyOrUrl: string): Promise<Buffer> {
    if (/^https?:\/\//i.test(keyOrUrl)) {
      const res = await fetch(keyOrUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`fetch failed ${res.status} for ${keyOrUrl}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (env.STORAGE_DRIVER !== 'local') {
      throw new Error(
        `Storage driver ${env.STORAGE_DRIVER} requires a presigned URL; got a bare key: ${keyOrUrl.slice(0, 80)}`,
      );
    }
    return readFile(this.pathFor(keyOrUrl));
  }

  async put(key: string, body: Buffer): Promise<{ key: string; size: number }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, size: body.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Local path for the engine, which runs on the same VM by default. */
  engineUri(key: string): string {
    if (/^https?:\/\//i.test(key)) return key;
    if (env.STORAGE_DRIVER !== 'local') return this.signedUrl(key);
    return this.pathFor(key);
  }

  /** Mirrors the API's local-driver signing so the two agree byte for byte. */
  signedUrl(key: string, ttlSeconds = env.STORAGE_URL_TTL_SECONDS, disposition: 'inline' | 'attachment' = 'inline'): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', env.STORAGE_SIGNING_SECRET)
      .update(`${key}|${expires}|${disposition}`)
      .digest('hex');
    const params = new URLSearchParams({ key, expires: String(expires), disposition, sig });
    return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/v1/storage/object?${params.toString()}`;
  }

  keyFor(bucket: 'originals' | 'derivatives', orgId: string, hash: string, ext = 'bin'): string {
    const clean = ext.replace(/^\./, '').toLowerCase().slice(0, 12) || 'bin';
    return `${bucket}/${orgId}/${hash.slice(0, 2)}/${hash}.${clean}`;
  }

  derivativeKey(orgId: string, assetHash: string, kind: string, transformHash: string, ext = 'jpg'): string {
    return `derivatives/${orgId}/${assetHash.slice(0, 2)}/${assetHash}/${kind}-${transformHash}.${ext.replace(/^\./, '')}`;
  }
}
