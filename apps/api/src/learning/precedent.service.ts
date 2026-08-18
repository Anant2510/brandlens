import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Verdict } from '@brandlens/contracts';
import { type Database, embeddings, precedents } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { VectorSearchService } from './vector-search.service';

export interface IndexPrecedentInput {
  orgId: string;
  brandId: string;
  ruleKey: string;
  ruleVersion: number;
  assetId: string;
  traceId?: string | null;
  /** The HUMAN verdict, never the machine's. */
  verdict: Verdict;
  rationale?: string | null;
  measured?: Record<string, unknown> | null;
  cropKey?: string | null;
}

export interface RetrievedPrecedent {
  assetId: string;
  ruleKey: string;
  verdict: Verdict;
  rationale: string | null;
  measured: Record<string, unknown> | null;
  cropUri: string | null;
  similarity: number;
}

/**
 * Precedent retrieval is what makes the system feel like it learned the brand.
 *
 * At judge time we pull the k nearest past decisions FOR THE SAME RULE and
 * inject them as in-context examples with their verdicts and the reviewer's
 * own words. No training, no fine-tuning, and the behaviour change is visible
 * to the customer after about five corrections.
 */
@Injectable()
export class PrecedentService {
  private readonly logger = new Logger(PrecedentService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly vectors: VectorSearchService,
  ) {}

  /** Records a human decision as a precedent. Idempotent per (rule, asset). */
  async index(input: IndexPrecedentInput): Promise<{ id: string }> {
    return this.repo.runAs(input.orgId, undefined, async (tx) => this.indexIn(tx, input));
  }

  async indexIn(tx: Database, input: IndexPrecedentInput): Promise<{ id: string }> {
    const [row] = await tx
      .insert(precedents)
      .values({
        orgId: input.orgId,
        brandId: input.brandId,
        ruleKey: input.ruleKey,
        ruleVersion: input.ruleVersion,
        assetId: input.assetId,
        traceId: input.traceId ?? null,
        verdict: input.verdict,
        rationale: input.rationale ?? null,
        measured: input.measured ?? null,
        cropKey: input.cropKey ?? null,
      })
      .onConflictDoUpdate({
        target: [precedents.brandId, precedents.ruleKey, precedents.ruleVersion, precedents.assetId],
        // A reviewer changing their mind must replace the precedent, not add a
        // second contradictory one.
        set: {
          verdict: input.verdict,
          rationale: input.rationale ?? null,
          measured: input.measured ?? null,
          cropKey: input.cropKey ?? null,
          traceId: input.traceId ?? null,
        },
      })
      .returning({ id: precedents.id });
    return { id: row.id };
  }

  /**
   * Balanced k/2 pass + k/2 fail nearest precedents, scoped to one rule.
   *
   * The balance is not cosmetic. If the tenant's history for a rule is 90%
   * pass — which it usually is, because most assets are fine — then nearest-
   * neighbour retrieval returns nine passes and one fail, the label prior
   * leaks through the examples, and the judge degenerates into a yes-machine
   * that agrees with whatever it is shown. Forcing an even split removes the
   * prior from the context window entirely.
   */
  async retrieveBalanced(input: {
    orgId: string;
    brandId: string;
    ruleKey: string;
    k: number;
    queryVector?: number[] | null;
    resolveCropUri?: (cropKey: string) => Promise<string | null>;
  }): Promise<RetrievedPrecedent[]> {
    const half = Math.max(1, Math.floor(input.k / 2));

    const rows = await this.repo.runAs(input.orgId, undefined, (tx) =>
      tx
        .select()
        .from(precedents)
        .where(and(eq(precedents.brandId, input.brandId), eq(precedents.ruleKey, input.ruleKey)))
        .orderBy(desc(precedents.createdAt))
        .limit(500),
    );

    if (rows.length === 0) return [];

    const passes = rows.filter((r) => r.verdict === 'pass');
    const fails = rows.filter((r) => r.verdict === 'fail');

    let ranked = new Map<string, number>();
    if (input.queryVector && input.queryVector.length > 0) {
      // Rank by visual/semantic similarity when we have a query vector; the
      // most instructive precedent is the one that looks most like this asset.
      const hits = await this.vectors
        .search(input.queryVector, {
          orgId: input.orgId,
          space: 'image',
          ownerType: 'asset',
          limit: 200,
          ownerIds: [...new Set(rows.map((r) => r.assetId))],
        })
        .catch(() => []);
      ranked = new Map(hits.map((h) => [h.ownerId, h.similarity]));
    }

    const bySimilarity = (a: typeof rows[number], b: typeof rows[number]) =>
      (ranked.get(b.assetId) ?? 0) - (ranked.get(a.assetId) ?? 0) ||
      b.createdAt.getTime() - a.createdAt.getTime();

    const chosen = [...passes.sort(bySimilarity).slice(0, half), ...fails.sort(bySimilarity).slice(0, half)];

    return Promise.all(
      chosen.map(async (r) => ({
        assetId: r.assetId,
        ruleKey: r.ruleKey,
        verdict: r.verdict as Verdict,
        rationale: r.rationale,
        measured: r.measured,
        cropUri: r.cropKey && input.resolveCropUri ? await input.resolveCropUri(r.cropKey).catch(() => null) : null,
        similarity: ranked.get(r.assetId) ?? 0,
      })),
    );
  }

  async countForRule(orgId: string, brandId: string, ruleKey: string): Promise<{ pass: number; fail: number }> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ verdict: precedents.verdict })
        .from(precedents)
        .where(and(eq(precedents.brandId, brandId), eq(precedents.ruleKey, ruleKey))),
    );
    return {
      pass: rows.filter((r) => r.verdict === 'pass').length,
      fail: rows.filter((r) => r.verdict === 'fail').length,
    };
  }

  /** Convenience for the worker: which assets have image embeddings yet. */
  async embeddedAssetIds(orgId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) return new Set();
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ ownerId: embeddings.ownerId })
        .from(embeddings)
        .where(and(eq(embeddings.ownerType, 'asset'), inArray(embeddings.ownerId, assetIds))),
    );
    return new Set(rows.map((r) => r.ownerId));
  }
}
