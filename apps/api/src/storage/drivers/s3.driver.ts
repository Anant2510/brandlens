import { createHash, createHmac } from 'node:crypto';
import type { PutOptions, StatResult, StorageDriver } from '../storage.driver';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for MinIO / R2 / any S3-compatible endpoint. */
  endpoint?: string;
}

/**
 * S3 driver implemented directly against SigV4 + `fetch`.
 *
 * Deliberately dependency-free: `@aws-sdk/client-s3` is ~20 MB of transitive
 * dependencies for four verbs, and the default deployment of this product does
 * not use S3 at all. Everything here is standard SigV4, so it also works
 * unchanged against MinIO, Cloudflare R2 and Backblaze B2.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;

  constructor(private readonly cfg: S3Config) {}

  private get host(): string {
    if (this.cfg.endpoint) return new URL(this.cfg.endpoint).host;
    return `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
  }

  private urlFor(key: string): string {
    if (this.cfg.endpoint) {
      const base = this.cfg.endpoint.replace(/\/$/, '');
      return `${base}/${this.cfg.bucket}/${encodeKey(key)}`;
    }
    return `https://${this.host}/${encodeKey(key)}`;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StatResult> {
    const res = await this.signedFetch('PUT', key, body, {
      'content-type': options?.contentType ?? 'application/octet-stream',
      ...(options?.cacheControl ? { 'cache-control': options.cacheControl } : {}),
    });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status} ${await res.text()}`);
    return { key, size: body.byteLength, contentType: options?.contentType, updatedAt: new Date() };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.signedFetch('GET', key);
    if (!res.ok) throw new Error(`S3 get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.signedFetch('HEAD', key);
    return res.ok;
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

  /** SigV4 query-string ("presigned") URL — no Authorization header needed. */
  async signedUrl(key: string, ttlSeconds: number, disposition: 'inline' | 'attachment' = 'inline'): Promise<string> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;

    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(ttlSeconds),
      'X-Amz-SignedHeaders': 'host',
      'response-content-disposition': disposition,
    });

    const canonicalUri = this.cfg.endpoint ? `/${this.cfg.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
    const canonicalRequest = [
      'GET',
      canonicalUri,
      sortQuery(query),
      `host:${this.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signature = hmac(signingKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region, 's3'), stringToSign).toString(
      'hex',
    );
    query.set('X-Amz-Signature', signature);
    return `${this.urlFor(key)}?${sortQuery(query)}`;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.signedFetch('HEAD', '');
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
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256')
      .update(body ?? Buffer.alloc(0))
      .digest('hex');

    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    const signedHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .join(';');
    const canonicalHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .map((h) => `${h}:${String(headers[h]).trim()}\n`)
      .join('');

    const canonicalUri = this.cfg.endpoint ? `/${this.cfg.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
    const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = hmac(signingKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region, 's3'), stringToSign).toString(
      'hex',
    );

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const init = { method, headers, body } as unknown as Parameters<typeof fetch>[1];
    return fetch(this.urlFor(key), init);
  }
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

function sortQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
