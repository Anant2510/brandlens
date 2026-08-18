import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { QUEUES, RegisterAssetInput } from '@brandlens/contracts';
import { type Database, assetDerivatives, assets, variantFamilies } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../brands/brands.service';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { contentHash } from '../common/hash';
import { offsetOf, paginate, type PageResult } from '../common/pagination';

export type AssetRow = typeof assets.$inferSelect;

export interface AssetDto {
  id: string;
  brandId: string;
  campaignId: string | null;
  variantFamilyId: string | null;
  name: string;
  kind: string;
  status: string;
  contentHash: string;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  colorProfile: string | null;
  dpi: number | null;
  sourceFidelity: string;
  market: string | null;
  channel: string | null;
  assetType: string | null;
  locale: string | null;
  copyFields: Record<string, string>;
  tags: string[];
  isApprovedExemplar: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string | null;
}

export interface ListAssetsQuery {
  brandId?: string;
  status?: string;
  kind?: string;
  variantFamilyId?: string;
  isApprovedExemplar?: boolean;
  page: number;
  pageSize: number;
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  async list(orgId: string, query: ListAssetsQuery): Promise<PageResult<AssetDto>> {
    return this.repo.run(async (tx) => {
      const conditions = [eq(assets.orgId, orgId), isNull(assets.deletedAt)];
      if (query.brandId) conditions.push(eq(assets.brandId, query.brandId));
      if (query.status) conditions.push(eq(assets.status, query.status as AssetRow['status']));
      if (query.kind) conditions.push(eq(assets.kind, query.kind as AssetRow['kind']));
      if (query.variantFamilyId) conditions.push(eq(assets.variantFamilyId, query.variantFamilyId));
      if (query.isApprovedExemplar !== undefined)
        conditions.push(eq(assets.isApprovedExemplar, query.isApprovedExemplar));

      const rows = await tx
        .select()
        .from(assets)
        .where(and(...conditions))
        .orderBy(desc(assets.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query));

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(assets)
        .where(and(...conditions));

      return paginate(rows.map(toDto), n ?? 0, query);
    });
  }

  async get(orgId: string, assetId: string, withPreview = true): Promise<AssetDto> {
    const row = await this.findRow(orgId, assetId);
    const dto = toDto(row);
    if (withPreview) dto.previewUrl = await this.previewUrl(orgId, row).catch(() => null);
    return dto;
  }

  async findRow(orgId: string, assetId: string): Promise<AssetRow> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.orgId, orgId), isNull(assets.deletedAt)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Asset ${assetId} not found`);
    return rows[0];
  }

  /**
   * Upload → content hash → dedupe → storage → row → `ingest.asset`.
   *
   * Dedupe is on (org, contentHash): re-uploading the same bytes returns the
   * existing asset instead of paying to ingest, embed and analyse it twice.
   * Scoped to the org rather than globally, because knowing that another
   * tenant already uploaded a file is itself an information leak.
   */
  async upload(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof RegisterAssetInput>,
    file: { buffer: Buffer; mimetype?: string; originalname?: string },
  ): Promise<{ asset: AssetDto; deduped: boolean; jobId: string | null }> {
    await this.brands.requireBrand(orgId, input.brandId);

    const hash = contentHash(file.buffer);
    const existing = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(assets)
        .where(and(eq(assets.orgId, orgId), eq(assets.contentHash, hash), isNull(assets.deletedAt)))
        .limit(1),
    );

    if (existing[0]) {
      return { asset: toDto(existing[0]), deduped: true, jobId: null };
    }

    const ext = (file.originalname?.split('.').pop() ?? extForKind(input.kind)).toLowerCase();
    const stored = await this.storage.putContentAddressed('originals', orgId, file.buffer, ext, {
      contentType: file.mimetype,
    });

    const row = await this.repo.runAs(orgId, userId, async (tx) => {
      const [inserted] = await tx
        .insert(assets)
        .values({
          orgId,
          brandId: input.brandId,
          campaignId: input.campaignId ?? null,
          variantFamilyId: input.variantFamilyId ?? null,
          name: input.name,
          kind: input.kind,
          status: 'uploading',
          contentHash: stored.hash,
          storageKey: stored.key,
          mimeType: file.mimetype ?? null,
          byteSize: file.buffer.byteLength,
          market: input.market ?? null,
          channel: input.channel ?? null,
          assetType: input.assetType ?? null,
          locale: input.locale ?? null,
          copyFields: input.copyFields ?? {},
          tags: input.tags ?? [],
          isApprovedExemplar: input.isApprovedExemplar ?? false,
          uploadedByUserId: userId ?? null,
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: 'asset.upload',
        entityType: 'asset',
        entityId: inserted.id,
        payload: { brandId: input.brandId, name: input.name, kind: input.kind, contentHash: stored.hash },
      });
      return inserted;
    });

    // Singleton on the asset id: an at-least-once queue plus a retrying client
    // must not schedule the same ingest twice.
    const jobId = await this.enqueueIngest(orgId, row.id);

    return { asset: toDto(row), deduped: false, jobId };
  }

  /**
   * Enqueues ingestion. A failure here is logged rather than thrown: the row
   * is already committed, and the reconciler re-enqueues anything left in
   * `uploading`. Swallowing it silently would make a broken queue look like a
   * broken uploader, which is a genuinely expensive hour to spend.
   */
  private async enqueueIngest(orgId: string, assetId: string, sourceUrl?: string): Promise<string | null> {
    try {
      return await this.queue.enqueue(
        QUEUES.ingestAsset,
        sourceUrl ? { orgId, assetId, sourceUrl } : { orgId, assetId },
        { singletonKey: `ingest:${assetId}` },
      );
    } catch (err) {
      this.logger.error({ assetId, err: String(err) }, 'failed to enqueue ingest; reconciler will retry');
      return null;
    }
  }

  /** Registers an asset that already lives at a URL the engine can read. */
  async registerByUrl(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof RegisterAssetInput> & { url: string },
  ): Promise<{ asset: AssetDto; jobId: string | null }> {
    await this.brands.requireBrand(orgId, input.brandId);
    if (!/^https?:\/\//i.test(input.url)) throw new BadRequestException('url must be http(s)');

    // The bytes are not in hand yet, so the hash is provisional: the ingest
    // handler fetches, hashes and rewrites it. Using the URL as the seed keeps
    // the row unique and makes re-registration idempotent in the meantime.
    const provisionalHash = contentHash(Buffer.from(`url:${orgId}:${input.url}`));

    const row = await this.repo.runAs(orgId, userId, async (tx) => {
      const [inserted] = await tx
        .insert(assets)
        .values({
          orgId,
          brandId: input.brandId,
          campaignId: input.campaignId ?? null,
          variantFamilyId: input.variantFamilyId ?? null,
          name: input.name,
          kind: input.kind,
          status: 'uploading',
          contentHash: provisionalHash,
          storageKey: input.url,
          market: input.market ?? null,
          channel: input.channel ?? null,
          assetType: input.assetType ?? null,
          locale: input.locale ?? null,
          copyFields: input.copyFields ?? {},
          tags: input.tags ?? [],
          isApprovedExemplar: input.isApprovedExemplar ?? false,
          uploadedByUserId: userId ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'asset.register_url',
        entityType: 'asset',
        entityId: inserted.id,
        payload: { brandId: input.brandId, url: input.url },
      });
      return inserted;
    });

    const jobId = await this.enqueueIngest(orgId, row.id, input.url);

    return { asset: toDto(row), jobId };
  }

  /** Copy-only submissions carry no bytes; the hash covers the text instead. */
  async registerCopy(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof RegisterAssetInput>,
  ): Promise<AssetDto> {
    await this.brands.requireBrand(orgId, input.brandId);
    const hash = contentHash(Buffer.from(JSON.stringify(input.copyFields ?? {})));

    return this.repo.runAs(orgId, userId, async (tx) => {
      const [inserted] = await tx
        .insert(assets)
        .values({
          orgId,
          brandId: input.brandId,
          name: input.name,
          kind: 'copy',
          status: 'ingested',
          contentHash: hash,
          storageKey: `inline:${hash}`,
          sourceFidelity: 'structured',
          market: input.market ?? null,
          channel: input.channel ?? null,
          assetType: input.assetType ?? null,
          locale: input.locale ?? null,
          copyFields: input.copyFields ?? {},
          tags: input.tags ?? [],
          uploadedByUserId: userId ?? null,
        })
        .returning();
      return toDto(inserted);
    });
  }

  async remove(orgId: string, assetId: string): Promise<{ id: string; deleted: true }> {
    await this.findRow(orgId, assetId);
    return this.repo.run(async (tx) => {
      await tx
        .update(assets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(assets.id, assetId), eq(assets.orgId, orgId)));
      await this.audit.recordIn(tx, { action: 'asset.delete', entityType: 'asset', entityId: assetId });
      return { id: assetId, deleted: true as const };
    });
  }

  /**
   * Signed, time-limited URL for the thumbnail if present, else the original.
   *
   * Returns null for copy-only assets: their `storageKey` is the sentinel
   * `inline:<hash>` and there are no bytes behind it, so handing the UI a
   * signed URL that resolves to 404 would be worse than saying "no preview".
   */
  async previewUrl(
    orgId: string,
    asset: AssetRow,
    disposition: 'inline' | 'attachment' = 'inline',
  ): Promise<string | null> {
    const thumb = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ storageKey: assetDerivatives.storageKey })
        .from(assetDerivatives)
        .where(and(eq(assetDerivatives.assetId, asset.id), eq(assetDerivatives.kind, 'thumbnail')))
        .limit(1),
    );
    const key = thumb[0]?.storageKey ?? asset.storageKey;
    if (!key || key.startsWith('inline:')) return null;
    if (/^https?:\/\//i.test(key)) return key;
    return this.storage.signedUrl(key, undefined, disposition);
  }

  async derivatives(orgId: string, assetId: string) {
    await this.findRow(orgId, assetId);
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(assetDerivatives).where(eq(assetDerivatives.assetId, assetId)),
    );
  }

  /* ------------------------------------------------------- variant families */

  /**
   * A variant family groups a master with its resizes.
   *
   * This is the single largest cost lever in the product: for an ad set of 30
   * sizes, the semantic questions ("is this photography on-style", "does the
   * copy match our voice") have the same answer on all 30, so they run ONCE on
   * the master and only geometry and channel-spec run per variant. That is a
   * 10–20× reduction in VLM spend for the highest-volume workflow there is.
   */
  async ensureFamily(orgId: string, brandId: string, name: string, masterAssetId?: string): Promise<string> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const [row] = await tx
        .insert(variantFamilies)
        .values({ orgId, brandId, name, masterAssetId: masterAssetId ?? null })
        .returning({ id: variantFamilies.id });
      return row.id;
    });
  }

  async familyMembers(orgId: string, variantFamilyId: string): Promise<AssetRow[]> {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(assets)
        .where(and(eq(assets.variantFamilyId, variantFamilyId), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt)),
    );
  }

  /**
   * The master is the largest member — the one carrying the most pixels, and
   * therefore the most evidence for the expensive semantic checks.
   */
  async masterOf(orgId: string, asset: AssetRow): Promise<AssetRow> {
    if (!asset.variantFamilyId) return asset;
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ masterAssetId: variantFamilies.masterAssetId })
        .from(variantFamilies)
        .where(eq(variantFamilies.id, asset.variantFamilyId as string))
        .limit(1),
    );
    const masterId = rows[0]?.masterAssetId;
    if (!masterId || masterId === asset.id) {
      const members = await this.familyMembers(orgId, asset.variantFamilyId);
      const largest = members.reduce(
        (best, m) => ((m.width ?? 0) * (m.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? m : best),
        asset,
      );
      return largest;
    }
    return this.findRow(orgId, masterId).catch(() => asset);
  }

  /** Used by the check pipeline and by the worker; kept on one code path. */
  async markStatus(tx: Database, assetId: string, status: AssetRow['status'], error?: string | null): Promise<void> {
    await tx
      .update(assets)
      .set({ status, error: error ?? null, updatedAt: new Date() })
      .where(eq(assets.id, assetId));
  }
}

export function toDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    brandId: row.brandId,
    campaignId: row.campaignId,
    variantFamilyId: row.variantFamilyId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    contentHash: row.contentHash,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    colorProfile: row.colorProfile,
    dpi: row.dpi,
    sourceFidelity: row.sourceFidelity,
    market: row.market,
    channel: row.channel,
    assetType: row.assetType,
    locale: row.locale,
    copyFields: row.copyFields,
    tags: row.tags,
    isApprovedExemplar: row.isApprovedExemplar,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function extForKind(kind: string): string {
  switch (kind) {
    case 'pdf':
      return 'pdf';
    case 'video':
      return 'mp4';
    case 'pptx':
      return 'pptx';
    case 'psd':
      return 'psd';
    case 'html':
      return 'html';
    default:
      return 'png';
  }
}
