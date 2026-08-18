export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface StatResult {
  key: string;
  size: number;
  contentType?: string;
  updatedAt?: Date;
}

/**
 * One interface, three drivers.
 *
 * The default deployment is a single Windows VM with no Docker and no cloud
 * account, so `local` has to be a first-class driver rather than a test double.
 * s3/azure exist behind the same interface so that moving to object storage is
 * a config change, not a rewrite of the asset pipeline.
 */
export interface StorageDriver {
  readonly name: 'local' | 's3' | 'azure';

  put(key: string, body: Buffer, options?: PutOptions): Promise<StatResult>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StatResult | null>;
  delete(key: string): Promise<void>;

  /**
   * A URI the analysis engine can read. For `local` this is a filesystem path
   * (the engine runs on the same box, so handing it a path avoids a pointless
   * HTTP round trip of a 40 MB TIFF); for cloud drivers it is a presigned URL.
   */
  engineUri(key: string): Promise<string>;

  /** Publicly resolvable, time-limited URL for browsers. */
  signedUrl(key: string, ttlSeconds: number, disposition?: 'inline' | 'attachment'): Promise<string>;

  healthy(): Promise<boolean>;
}
