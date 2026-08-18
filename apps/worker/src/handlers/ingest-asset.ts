import { eq } from 'drizzle-orm';
import { QUEUES } from '@brandlens/contracts';
import { assetDerivatives, assets } from '@brandlens/db';
import { contentHash, transformHash } from '@brandlens/api/common/hash';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { probeMedia, sniffMimeType } from '../services/media-probe';
import type { WorkerRuntime } from '../runtime';

export interface IngestAssetJob {
  orgId: string;
  assetId: string;
  sourceUrl?: string | null;
}

/**
 * `ingest.asset` — probe, derive, extract structure, announce.
 *
 * IDEMPOTENT: at-least-once delivery is the only guarantee pg-boss offers, so
 * an asset already past `ingested` short-circuits, and the derivative write
 * is keyed on (asset, kind, transformHash) with ON CONFLICT DO NOTHING.
 */
export async function ingestAsset(job: IngestAssetJob, runtime: WorkerRuntime): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'ingest.asset', assetId: job.assetId });

  const asset = await ctx.withTenant(job.orgId, async (tx) => {
    const rows = await tx.select().from(assets).where(eq(assets.id, job.assetId)).limit(1);
    return rows[0] ?? null;
  });

  if (!asset) {
    log.warn('asset disappeared before ingest; nothing to do');
    return;
  }
  if (asset.status !== 'uploading' && asset.status !== 'failed') {
    log.debug({ status: asset.status }, 'already ingested — idempotent no-op');
    return;
  }

  try {
    const source = job.sourceUrl ?? asset.storageKey;
    const isInline = source.startsWith('inline:');

    // Copy-only assets carry no bytes: their "content" is the copyFields JSON,
    // which was already hashed at registration.
    if (isInline || asset.kind === 'copy') {
      await ctx.withTenant(job.orgId, async (tx) => {
        await tx
          .update(assets)
          .set({ status: 'ingested', sourceFidelity: 'structured', updatedAt: new Date() })
          .where(eq(assets.id, asset.id));
        await emitEvent(tx, {
          orgId: job.orgId,
          type: 'asset.ingested',
          aggregateType: 'asset',
          aggregateId: asset.id,
          payload: { assetId: asset.id, kind: asset.kind, structured: true },
          idempotencyKey: `asset.ingested:${asset.id}`,
        });
      });
      return;
    }

    const bytes = await ctx.storage.readOrFetch(source);
    const probe = probeMedia(bytes);
    const hash = contentHash(bytes);

    // Register-by-URL wrote a provisional hash from the URL; now that we have
    // the bytes, replace it so dedupe and every cache key become correct.
    let storageKey = asset.storageKey;
    if (job.sourceUrl) {
      const ext = probe.format ?? source.split('.').pop()?.slice(0, 5) ?? 'bin';
      storageKey = ctx.storage.keyFor('originals', job.orgId, hash, ext);
      if (!(await ctx.storage.exists(storageKey))) await ctx.storage.put(storageKey, bytes);
    }

    const structured = await extractStructuredSource(bytes, asset.kind, probe.pageCount);
    const thumbnail = await buildThumbnail(job.orgId, bytes, asset.kind);

    await ctx.withTenant(job.orgId, async (tx) => {
      await tx
        .update(assets)
        .set({
          status: 'ingested',
          contentHash: hash,
          storageKey,
          mimeType: asset.mimeType ?? probe.mimeType ?? sniffMimeType(bytes),
          byteSize: bytes.byteLength,
          width: probe.width ?? asset.width,
          height: probe.height ?? asset.height,
          dpi: probe.dpi ?? asset.dpi,
          // Recording the ICC profile is the most-missed step in this domain:
          // a Display-P3 asset analysed as sRGB reads as oversaturated and
          // produces a page of false colour findings on the first upload.
          colorProfile: probe.colorProfile ?? asset.colorProfile,
          sourceFidelity: structured ? 'structured' : 'raster',
          structuredSource: structured,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, asset.id));

      if (thumbnail) {
        await tx
          .insert(assetDerivatives)
          .values({
            orgId: job.orgId,
            assetId: asset.id,
            kind: 'thumbnail',
            transformHash: thumbnail.transformHash,
            storageKey: thumbnail.key,
            width: thumbnail.width,
            height: thumbnail.height,
            meta: thumbnail.meta,
          })
          // Derivatives are reproducible: the same bytes and the same
          // transform always yield the same file, so a duplicate is a no-op.
          .onConflictDoNothing();
      }

      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'asset.ingested',
        aggregateType: 'asset',
        aggregateId: asset.id,
        payload: {
          assetId: asset.id,
          contentHash: hash,
          width: probe.width,
          height: probe.height,
          dpi: probe.dpi,
          colorProfile: probe.colorProfile,
          sourceFidelity: structured ? 'structured' : 'raster',
        },
        idempotencyKey: `asset.ingested:${asset.id}`,
      });

      if (thumbnail) {
        await emitEvent(tx, {
          orgId: job.orgId,
          type: 'asset.derivative.ready',
          aggregateType: 'asset',
          aggregateId: asset.id,
          payload: { assetId: asset.id, kind: 'thumbnail', storageKey: thumbnail.key },
          idempotencyKey: `asset.derivative:${asset.id}:thumbnail`,
        });
      }
    });

    // Embedding is a separate job: it is the slow part, and an asset should be
    // checkable the moment its geometry is known.
    await runtime.send(QUEUES.embedAsset, { orgId: job.orgId, assetId: asset.id }, { singletonKey: `embed:${asset.id}` });

    log.info({ width: probe.width, height: probe.height, colorProfile: probe.colorProfile }, 'asset ingested');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(assets)
        .set({ status: 'failed', error: message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(assets.id, job.assetId)),
    );
    throw err;
  }
}

/**
 * Structured source extraction.
 *
 * Structured beats pixels every time: exact fonts, sizes, colours and boxes
 * are ground truth, while everything read off a flattened raster is inference.
 * The deep parse (per-span fonts, vector fills) belongs to the Python engine,
 * which has the right libraries; the control plane extracts only what it can
 * do reliably with zero dependencies, and records the fidelity so downstream
 * checks know which kind of evidence they are working with.
 */
async function extractStructuredSource(
  bytes: Buffer,
  kind: string,
  pageCount: number | null,
): Promise<Record<string, unknown> | null> {
  if (kind === 'pdf') {
    const head = bytes.toString('latin1', 0, Math.min(bytes.length, 4_000_000));
    const fonts = [...new Set([...head.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_,.]+)/g)].map((m) => m[1]))];
    const producer = /\/Producer\s*\(([^)]{0,120})\)/.exec(head)?.[1] ?? null;
    return {
      kind: 'pdf',
      pageCount,
      // Subset prefixes look like `ABCDEF+Helvetica`; strip them so the font
      // name matches what a type style declares.
      fonts: fonts.map((f) => f.replace(/^[A-Z]{6}\+/, '')),
      producer,
      hasEmbeddedFonts: /\/FontFile[23]?\b/.test(head),
      extractedBy: 'control-plane-shallow',
      note: 'Deep per-span extraction is performed by the analysis engine.',
    };
  }

  if (kind === 'html') {
    const text = bytes.toString('utf8', 0, Math.min(bytes.length, 1_000_000));
    const colors = [...new Set([...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()))];
    const families = [...new Set([...text.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)].map((m) => m[1].trim()))];
    return {
      kind: 'html',
      colors: colors.slice(0, 200),
      fontFamilies: families.slice(0, 50),
      title: /<title[^>]*>([^<]{0,200})</i.exec(text)?.[1] ?? null,
      extractedBy: 'control-plane-shallow',
    };
  }

  if (kind === 'pptx' || kind === 'figma' || kind === 'psd') {
    // These are container formats the control plane cannot open without a
    // dependency. Marking them explicitly is better than a silent null,
    // because the engine keys its behaviour off `sourceFidelity`.
    return { kind, extractedBy: 'pending-engine', note: 'Structured extraction deferred to the analysis engine.' };
  }

  return null;
}

/**
 * Thumbnail derivative.
 *
 * Real resampling needs a native image library, which the no-Docker Windows
 * target cannot be assumed to have. `sharp` is loaded opportunistically — if
 * the operator installed it, we produce a genuine 512px WebP; if not, we
 * register the original as the preview so the UI still renders, and record
 * `degraded: true` so the gap is visible rather than mysterious.
 */
async function buildThumbnail(
  orgId: string,
  bytes: Buffer,
  kind: string,
): Promise<{ key: string; transformHash: string; width: number | null; height: number | null; meta: Record<string, unknown> } | null> {
  if (kind !== 'image') return null;

  const ctx = getContext();
  const hash = contentHash(bytes);
  const probe = probeMedia(bytes);
  const transform = { op: 'thumbnail', maxEdge: 512, format: 'webp', v: 1 };
  const tHash = transformHash(transform);

  const sharp = await loadSharp();
  if (sharp) {
    try {
      const output = await sharp(bytes)
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      const key = ctx.storage.derivativeKey(orgId, hash, 'thumbnail', tHash, 'webp');
      await ctx.storage.put(key, output.data);
      return {
        key,
        transformHash: tHash,
        width: output.info.width,
        height: output.info.height,
        meta: { ...transform, generator: 'sharp', bytes: output.data.byteLength },
      };
    } catch (err) {
      logger.warn({ err: String(err) }, 'sharp thumbnail failed; falling back to the original');
    }
  }

  // Passthrough: the UI still renders a preview, and `degraded: true` makes
  // the missing optimisation visible instead of mysterious.
  return {
    key: ctx.storage.keyFor('originals', orgId, hash, probe.format ?? 'bin'),
    transformHash: transformHash({ ...transform, degraded: true }),
    width: probe.width,
    height: probe.height,
    meta: { ...transform, degraded: true, generator: 'passthrough', reason: 'sharp is not installed' },
  };
}

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: Record<string, unknown>): SharpPipeline;
  webp(options: Record<string, unknown>): SharpPipeline;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}

type SharpLike = (input: Buffer) => SharpPipeline;

let sharpModule: SharpLike | null | undefined;

/**
 * `sharp` is an OPTIONAL dependency, loaded through a non-literal specifier so
 * neither the type-checker nor the bundler treats it as required. Installed
 * ⇒ real 512px WebP thumbnails; absent ⇒ passthrough. The default target is a
 * Windows VM with no compiler toolchain, and a mandatory native postinstall
 * there turns "clone and run" into a support ticket.
 */
async function loadSharp(): Promise<SharpLike | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const specifier = 'sharp';
    const mod = (await import(specifier)) as { default?: SharpLike } & Partial<SharpLike>;
    sharpModule = ((mod.default ?? mod) as unknown as SharpLike) ?? null;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}
