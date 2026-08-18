import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@brandlens/db';
import { embeddings } from '@brandlens/db';
import { env } from '../config';
import type { EngineClient } from './engine.client';

export interface EmbedResult {
  vec: number[];
  modelId: string;
  dim: number;
}

/**
 * Deterministic hash embedding.
 *
 * The default `EMBEDDING_PROVIDER=hash` exists so the whole system boots with
 * zero model downloads on a fresh Windows VM. It is a real, stable embedding
 * in the sense that identical bytes always produce an identical vector, so
 * dedupe and cache behaviour are correct — but it carries no semantics, so
 * nearest-neighbour retrieval degrades to near-random until a real provider is
 * configured. `modelId` records which one produced each vector, so switching
 * providers invalidates rather than silently mixing incompatible spaces.
 */
export function hashEmbedding(input: Buffer | string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

  // Chain SHA-256 blocks until the vector is filled; each block contributes 8
  // dimensions' worth of entropy.
  let block = createHash('sha256').update(bytes).digest();
  for (let i = 0; i < dim; i += 1) {
    if (i > 0 && i % 32 === 0) block = createHash('sha256').update(block).digest();
    vec[i] = (block[i % 32] - 127.5) / 127.5;
  }

  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export async function embedBytes(engine: EngineClient, orgId: string, id: string, uri: string): Promise<EmbedResult> {
  if (env.IMAGE_EMBEDDING_PROVIDER === 'hash') {
    return { vec: hashEmbedding(uri, env.IMAGE_EMBEDDING_DIM), modelId: 'hash-v1', dim: env.IMAGE_EMBEDDING_DIM };
  }
  const res = await engine.embed({ orgId, space: 'image', items: [{ id, uri }] });
  const first = res.vectors[0];
  if (!first) throw new Error(`engine returned no vector for ${id}`);
  return { vec: first.vec, modelId: first.modelId, dim: first.dim };
}

export async function embedText(engine: EngineClient, orgId: string, id: string, text: string): Promise<EmbedResult> {
  if (env.EMBEDDING_PROVIDER === 'hash') {
    return { vec: hashEmbedding(text, env.EMBEDDING_DIM), modelId: 'hash-v1', dim: env.EMBEDDING_DIM };
  }
  const res = await engine.embed({ orgId, space: 'text', items: [{ id, text }] });
  const first = res.vectors[0];
  if (!first) throw new Error(`engine returned no vector for ${id}`);
  return { vec: first.vec, modelId: first.modelId, dim: first.dim };
}

/**
 * Persists a vector. The unique key on
 * (ownerType, ownerId, space, modelId, preprocessingVersion) makes a re-run a
 * no-op: embeddings are pure functions of their inputs, so recomputing one is
 * only ever waste, never a correction.
 */
export async function upsertEmbedding(
  tx: Database,
  input: {
    orgId: string;
    ownerType: string;
    ownerId: string;
    space: 'image' | 'text';
    modelId: string;
    vec: number[];
    contentHash?: string | null;
    preprocessingVersion?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  const norm = Math.sqrt(input.vec.reduce((acc, v) => acc + v * v, 0));
  await tx
    .insert(embeddings)
    .values({
      orgId: input.orgId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      space: input.space,
      modelId: input.modelId,
      preprocessingVersion: input.preprocessingVersion ?? 'v1',
      dim: input.vec.length,
      vec: input.vec,
      norm,
      contentHash: input.contentHash ?? null,
      meta: input.meta ?? {},
    })
    .onConflictDoUpdate({
      target: [
        embeddings.ownerType,
        embeddings.ownerId,
        embeddings.space,
        embeddings.modelId,
        embeddings.preprocessingVersion,
      ],
      set: { vec: input.vec, norm, dim: input.vec.length, meta: input.meta ?? {} },
    });
}

export async function hasEmbedding(
  tx: Database,
  ownerType: string,
  ownerId: string,
  space: 'image' | 'text',
): Promise<boolean> {
  const rows = await tx
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.ownerType, ownerType), eq(embeddings.ownerId, ownerId), eq(embeddings.space, space)))
    .limit(1);
  return rows.length > 0;
}
