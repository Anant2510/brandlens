import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { detectPgvector, embeddings, systemState } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AppConfigService } from '../config/config.service';

export type VectorDriver = 'pgvector' | 'fallback';

export interface VectorHit {
  ownerId: string;
  ownerType: string;
  similarity: number;
  meta: Record<string, unknown>;
}

export interface VectorSearchOptions {
  orgId: string;
  space: 'image' | 'text';
  ownerType: string;
  limit: number;
  /** Restrict candidates to a known id set (e.g. precedents for one rule). */
  ownerIds?: string[];
}

const VECTOR_DRIVER_KEY = 'vector_driver';

/**
 * Two drivers, one interface.
 *
 * pgvector is not installable on every Windows Postgres build (it needs a
 * compiler, or a matching prebuilt binary), and requiring it would make the
 * product undeployable on the exact machine the customer already has. So the
 * portable `real[]` column is ALWAYS populated, an in-SQL cosine function
 * serves the fallback path, and pgvector — when present — is a pure speedup
 * via a shadow `vec_p` column kept in sync by trigger.
 *
 * The choice is recorded in `system_state` so the API and the worker agree,
 * and so it shows up on `/health/deep` rather than being invisible.
 */
@Injectable()
export class VectorSearchService implements OnModuleInit {
  private readonly logger = new Logger(VectorSearchService.name);
  private driver: VectorDriver = 'fallback';
  private resolved = false;

  constructor(
    private readonly repo: TenantRepository,
    private readonly config: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.resolveDriver().catch((err) =>
      this.logger.warn({ err: String(err) }, 'vector driver detection failed; using fallback'),
    );
  }

  get currentDriver(): VectorDriver {
    return this.driver;
  }

  async resolveDriver(): Promise<VectorDriver> {
    if (this.resolved) return this.driver;

    const preference = this.config.vectorDriverPreference;
    if (preference !== 'auto') {
      this.driver = preference;
      this.resolved = true;
      await this.persistDriver();
      return this.driver;
    }

    const stored = await this.repo
      .platform((tx) => tx.select().from(systemState).where(sql`${systemState.key} = ${VECTOR_DRIVER_KEY}`).limit(1))
      .catch(() => []);

    const cached = (stored[0]?.value as { driver?: string } | undefined)?.driver;
    if (cached === 'pgvector' || cached === 'fallback') {
      this.driver = cached;
      this.resolved = true;
      return this.driver;
    }

    const hasPgvector = await detectPgvector(this.repo.raw).catch(() => false);
    this.driver = hasPgvector ? 'pgvector' : 'fallback';
    this.resolved = true;
    await this.persistDriver();
    this.logger.log(`vector driver: ${this.driver}`);
    return this.driver;
  }

  private async persistDriver(): Promise<void> {
    await this.repo
      .platform((tx) =>
        tx
          .insert(systemState)
          .values({ key: VECTOR_DRIVER_KEY, value: { driver: this.driver, detectedAt: new Date().toISOString() } })
          .onConflictDoUpdate({
            target: systemState.key,
            set: { value: { driver: this.driver, detectedAt: new Date().toISOString() }, updatedAt: new Date() },
          }),
      )
      .catch(() => undefined);
  }

  /** Writes (or replaces) one vector. Embeddings are pure functions of their
   *  inputs, so the unique key makes re-embedding a no-op rather than a dupe. */
  async upsert(input: {
    orgId: string;
    ownerType: string;
    ownerId: string;
    space: 'image' | 'text';
    modelId: string;
    preprocessingVersion?: string;
    vec: number[];
    contentHash?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const norm = Math.sqrt(input.vec.reduce((acc, v) => acc + v * v, 0));
    await this.repo.runAs(input.orgId, undefined, (tx) =>
      tx
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
        }),
    );
  }

  /**
   * k-nearest neighbours. Both drivers return cosine SIMILARITY in [-1, 1] so
   * callers never have to know which one ran.
   */
  async search(query: number[], options: VectorSearchOptions): Promise<VectorHit[]> {
    const driver = await this.resolveDriver();
    const limit = Math.max(1, Math.min(200, options.limit));

    return this.repo.runAs(options.orgId, undefined, async (tx) => {
      const idFilter =
        options.ownerIds && options.ownerIds.length > 0
          ? sql` AND owner_id = ANY(${sql.raw(`ARRAY[${options.ownerIds.map((id) => `'${escapeUuid(id)}'`).join(',')}]::uuid[]`)})`
          : sql``;

      if (driver === 'pgvector') {
        // `<=>` is cosine DISTANCE, so similarity is 1 - distance. The HNSW
        // index only accelerates this operator, which is why the ORDER BY is
        // written against it rather than against a similarity expression.
        const literal = toVectorLiteral(query);
        const res = await tx.execute(sql`
          SELECT owner_id, owner_type, meta, 1 - (vec_p <=> ${literal}::vector) AS similarity
          FROM embeddings
          WHERE org_id = ${options.orgId}
            AND space = ${options.space}
            AND owner_type = ${options.ownerType}
            AND vec_p IS NOT NULL${idFilter}
          ORDER BY vec_p <=> ${literal}::vector
          LIMIT ${limit}
        `);
        return rowsOf(res).map(mapHit);
      }

      const arrayLiteral = toRealArrayLiteral(query);
      const res = await tx.execute(sql`
        SELECT owner_id, owner_type, meta,
               brandlens_cosine_similarity(vec, ${arrayLiteral}::real[]) AS similarity
        FROM embeddings
        WHERE org_id = ${options.orgId}
          AND space = ${options.space}
          AND owner_type = ${options.ownerType}${idFilter}
        ORDER BY similarity DESC NULLS LAST
        LIMIT ${limit}
      `);
      return rowsOf(res).map(mapHit);
    });
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
}

function mapHit(row: Record<string, unknown>): VectorHit {
  return {
    ownerId: String(row.owner_id),
    ownerType: String(row.owner_type),
    similarity: Number(row.similarity ?? 0),
    meta: (row.meta as Record<string, unknown>) ?? {},
  };
}

export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

export function toRealArrayLiteral(vec: number[]): string {
  return `{${vec.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}}`;
}

/** Belt and braces: these ids come from our own tables, but the ANY() list is
 *  built as raw SQL, so anything non-uuid must never reach it. */
function escapeUuid(id: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`Refusing to interpolate non-uuid: ${id}`);
  return id;
}
