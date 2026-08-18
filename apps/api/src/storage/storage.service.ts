import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { contentHash } from '../common/hash';
import { AzureStorageDriver } from './drivers/azure.driver';
import { LocalStorageDriver, signLocalKey } from './drivers/local.driver';
import { S3StorageDriver } from './drivers/s3.driver';
import type { PutOptions, StatResult, StorageDriver } from './storage.driver';

export type StorageBucket = 'originals' | 'derivatives';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: StorageDriver;

  constructor(private readonly config: AppConfigService) {
    this.driver = this.build();
    this.logger.log(`storage driver: ${this.driver.name}`);
  }

  private build(): StorageDriver {
    const env = this.config.env;
    switch (this.config.storageDriver) {
      case 's3':
        return new S3StorageDriver({
          bucket: env.S3_BUCKET_ORIGINALS || 'brandlens',
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          endpoint: env.S3_ENDPOINT || undefined,
        });
      case 'azure':
        return new AzureStorageDriver({
          connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
          container: env.AZURE_CONTAINER_ORIGINALS,
        });
      default:
        return new LocalStorageDriver(env.STORAGE_LOCAL_ROOT, env.STORAGE_SIGNING_SECRET, env.API_PUBLIC_URL);
    }
  }

  get driverName(): 'local' | 's3' | 'azure' {
    return this.driver.name;
  }

  /**
   * Content-addressed layout: `originals/<org>/<ab>/<hash>.<ext>`.
   *
   * Sharding by the first byte of the hash keeps directory sizes sane on NTFS,
   * where a single folder with 200k entries turns every `readdir` into a stall.
   * Addressing by hash rather than by asset id is what makes dedupe free: the
   * same file uploaded by five people occupies one blob.
   */
  keyFor(bucket: StorageBucket, orgId: string, hash: string, ext = 'bin'): string {
    const clean = ext.replace(/^\./, '').toLowerCase().slice(0, 12) || 'bin';
    return `${bucket}/${orgId}/${hash.slice(0, 2)}/${hash}.${clean}`;
  }

  derivativeKey(orgId: string, assetHash: string, kind: string, transformHash: string, ext = 'jpg'): string {
    return `derivatives/${orgId}/${assetHash.slice(0, 2)}/${assetHash}/${kind}-${transformHash}.${ext.replace(/^\./, '')}`;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StatResult> {
    return this.driver.put(key, body, options);
  }

  /** Writes bytes at their content address and returns the hash + key. */
  async putContentAddressed(
    bucket: StorageBucket,
    orgId: string,
    body: Buffer,
    ext: string,
    options?: PutOptions,
  ): Promise<{ hash: string; key: string; size: number; deduped: boolean }> {
    const hash = contentHash(body);
    const key = this.keyFor(bucket, orgId, hash, ext);
    if (await this.driver.exists(key)) {
      return { hash, key, size: body.byteLength, deduped: true };
    }
    await this.driver.put(key, body, options);
    return { hash, key, size: body.byteLength, deduped: false };
  }

  get(key: string): Promise<Buffer> {
    return this.driver.get(key);
  }

  exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  stat(key: string): Promise<StatResult | null> {
    return this.driver.stat(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  engineUri(key: string): Promise<string> {
    return this.driver.engineUri(key);
  }

  signedUrl(key: string, ttlSeconds?: number, disposition: 'inline' | 'attachment' = 'inline'): Promise<string> {
    return this.driver.signedUrl(key, ttlSeconds ?? this.config.env.STORAGE_URL_TTL_SECONDS, disposition);
  }

  healthy(): Promise<boolean> {
    return this.driver.healthy();
  }

  /**
   * Verifies a local-driver signature. Constant-time comparison and an
   * explicit expiry check: a signed preview URL is the one part of the API
   * that is handed to a browser and can leak into logs and referrers.
   */
  verifyLocalSignature(key: string, expires: number, disposition: string, sig: string): boolean {
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = signLocalKey(this.config.env.STORAGE_SIGNING_SECRET, key, expires, disposition);
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  }
}
