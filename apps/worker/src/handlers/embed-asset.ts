import { eq } from 'drizzle-orm';
import { assets } from '@brandlens/db';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { embedBytes, embedText, hasEmbedding, upsertEmbedding } from '../services/embeddings';

export interface EmbedAssetJob {
  orgId: string;
  assetId: string;
  force?: boolean;
}

/**
 * `embed.asset` — image and text vectors for precedent retrieval and style
 * distance.
 *
 * IDEMPOTENT: embeddings are pure functions of (bytes, model, preprocessing
 * version), so an existing vector is never recomputed unless `force` is set.
 * `preprocessingVersion` is the field that saves you later: a change to the
 * resize/crop/normalise code silently invalidates every vector, and without it
 * you would have no way to know it happened.
 */
export async function embedAsset(job: EmbedAssetJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'embed.asset', assetId: job.assetId });

  const asset = await ctx.withTenant(job.orgId, async (tx) => {
    const rows = await tx.select().from(assets).where(eq(assets.id, job.assetId)).limit(1);
    return rows[0] ?? null;
  });
  if (!asset) {
    log.warn('asset not found; skipping embed');
    return;
  }

  const spaces: Array<'image' | 'text'> = [];
  if (asset.kind !== 'copy') spaces.push('image');
  if (Object.keys(asset.copyFields ?? {}).length > 0) spaces.push('text');
  if (spaces.length === 0) return;

  for (const space of spaces) {
    const already = await ctx.withTenant(job.orgId, (tx) => hasEmbedding(tx, 'asset', asset.id, space));
    if (already && !job.force) {
      log.debug({ space }, 'embedding already present — idempotent no-op');
      continue;
    }

    const result =
      space === 'image'
        ? await embedBytes(ctx.engine, job.orgId, asset.id, ctx.storage.engineUri(asset.storageKey))
        : await embedText(ctx.engine, job.orgId, asset.id, Object.values(asset.copyFields ?? {}).join('\n\n'));

    await ctx.withTenant(job.orgId, (tx) =>
      upsertEmbedding(tx, {
        orgId: job.orgId,
        ownerType: 'asset',
        ownerId: asset.id,
        space,
        modelId: result.modelId,
        vec: result.vec,
        contentHash: asset.contentHash,
        meta: { brandId: asset.brandId, kind: asset.kind },
      }),
    );
  }

  await ctx.withTenant(job.orgId, (tx) =>
    emitEvent(tx, {
      orgId: job.orgId,
      type: 'asset.embedded',
      aggregateType: 'asset',
      aggregateId: asset.id,
      payload: { assetId: asset.id, spaces },
      idempotencyKey: `asset.embedded:${asset.id}:${spaces.join('+')}`,
    }),
  );

  log.info({ spaces }, 'asset embedded');
}
