import { createHmac } from 'node:crypto';
import type { PutOptions, StatResult, StorageDriver } from '../storage.driver';

export interface AzureConfig {
  connectionString: string;
  container: string;
}

interface ParsedConnection {
  accountName: string;
  accountKey: string;
  endpoint: string;
}

/**
 * Azure Blob driver over the REST API with Shared Key auth and SAS signing.
 *
 * Same reasoning as the S3 driver: `@azure/storage-blob` is a large dependency
 * for four verbs on a code path the default deployment never takes.
 */
export class AzureStorageDriver implements StorageDriver {
  readonly name = 'azure' as const;
  private readonly conn: ParsedConnection;

  constructor(private readonly cfg: AzureConfig) {
    this.conn = parseConnectionString(cfg.connectionString);
  }

  private urlFor(key: string): string {
    return `${this.conn.endpoint}/${this.cfg.container}/${encodeKey(key)}`;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StatResult> {
    const res = await this.signedFetch('PUT', key, body, {
      'x-ms-blob-type': 'BlockBlob',
      'content-type': options?.contentType ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
    });
    if (!res.ok) throw new Error(`Azure put failed: ${res.status} ${await res.text()}`);
    return { key, size: body.byteLength, contentType: options?.contentType, updatedAt: new Date() };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.signedFetch('GET', key);
    if (!res.ok) throw new Error(`Azure get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    return (await this.signedFetch('HEAD', key)).ok;
  }

  async stat(key: string): Promise<StatResult | null> {
    const res = await this.signedFetch('HEAD', key);
    if (!res.ok) return null;
    return {
      key,
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? undefined,
      updatedAt: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified') as string) : undefined,
    };
  }

  async delete(key: string): Promise<void> {
    await this.signedFetch('DELETE', key);
  }

  async engineUri(key: string): Promise<string> {
    return this.signedUrl(key, 3600);
  }

  /** Service SAS with read permission, signed with the account key. */
  async signedUrl(key: string, ttlSeconds: number, _disposition: 'inline' | 'attachment' = 'inline'): Promise<string> {
    const start = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const expiry = new Date(Date.now() + ttlSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const version = '2021-08-06';
    const canonicalResource = `/blob/${this.conn.accountName}/${this.cfg.container}/${key}`;

    const stringToSign = [
      'r', // permissions
      start,
      expiry,
      canonicalResource,
      '', // identifier
      '', // ip
      'https', // protocol
      version,
      'b', // resource: blob
      '', // snapshot
      '', // encryption scope
      '', // cache-control
      '', // content-disposition
      '', // content-encoding
      '', // content-language
      '', // content-type
    ].join('\n');

    const signature = createHmac('sha256', Buffer.from(this.conn.accountKey, 'base64'))
      .update(stringToSign, 'utf8')
      .digest('base64');

    const params = new URLSearchParams({
      sv: version,
      sr: 'b',
      st: start,
      se: expiry,
      sp: 'r',
      spr: 'https',
      sig: signature,
    });
    return `${this.urlFor(key)}?${params.toString()}`;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.conn.endpoint}/${this.cfg.container}?restype=container&comp=list&maxresults=1`, {
        method: 'GET',
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  private async signedFetch(
    method: string,
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const date = new Date().toUTCString();
    const version = '2021-08-06';
    const headers: Record<string, string> = { 'x-ms-date': date, 'x-ms-version': version, ...extraHeaders };

    const canonicalHeaders = Object.keys(headers)
      .filter((h) => h.toLowerCase().startsWith('x-ms-'))
      .map((h) => h.toLowerCase())
      .sort()
      .map((h) => `${h}:${headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h) as string]}\n`)
      .join('');

    const canonicalResource = `/${this.conn.accountName}/${this.cfg.container}/${key}`;
    const stringToSign = [
      method,
      '', // content-encoding
      '', // content-language
      body ? String(body.byteLength) : '',
      '', // content-md5
      headers['content-type'] ?? '',
      '', // date (using x-ms-date)
      '',
      '',
      '',
      '',
      '',
      canonicalHeaders + canonicalResource,
    ].join('\n');

    const signature = createHmac('sha256', Buffer.from(this.conn.accountKey, 'base64'))
      .update(stringToSign, 'utf8')
      .digest('base64');

    headers.authorization = `SharedKey ${this.conn.accountName}:${signature}`;
    const init = { method, headers, body } as unknown as Parameters<typeof fetch>[1];
    return fetch(this.urlFor(key), init);
  }
}

function parseConnectionString(cs: string): ParsedConnection {
  const parts = Object.fromEntries(
    cs
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const idx = kv.indexOf('=');
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      }),
  ) as Record<string, string>;

  const accountName = parts.AccountName ?? '';
  const accountKey = parts.AccountKey ?? '';
  const protocol = parts.DefaultEndpointsProtocol ?? 'https';
  const suffix = parts.EndpointSuffix ?? 'core.windows.net';
  const endpoint = parts.BlobEndpoint ?? `${protocol}://${accountName}.blob.${suffix}`;
  return { accountName, accountKey, endpoint: endpoint.replace(/\/$/, '') };
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}
