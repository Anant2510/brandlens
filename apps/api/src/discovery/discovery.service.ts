import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  DiscoveryOptions,
  type DiscoveryRunDTO,
  QUEUES,
  type StartDiscoveryRequest,
  checkDiscoveryUrl,
} from '@brandlens/contracts';
import { discoveredPages, discoveryRuns } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { AssetsService } from '../assets/assets.service';
import { QueueService } from '../queue/queue.service';
import { hashObject } from '../common/hash';

export type DiscoveryRunRow = typeof discoveryRuns.$inferSelect;

export const DISCOVERY_PIPELINE_VERSION = '1.0.0';

/**
 * Skill 0 — discovery.
 *
 * The one entry point that does not require a brand to exist yet: give it a
 * public URL and it builds the ontology the rest of the product needs, then
 * turns that ontology back on the site to show where the brand contradicts
 * itself.
 *
 * Everything it proposes lands as `proposed`. Discovery is an argument, not a
 * verdict.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async start(orgId: string, userId: string | undefined, body: StartDiscoveryRequest): Promise<DiscoveryRunDTO> {
    // The URL guard runs here AND again in the worker before every fetch.
    // Validating once at the edge would leave a redirect free to move the
    // origin somewhere private between acceptance and the first request.
    const guard = checkDiscoveryUrl(body.url);
    if (!guard.ok || !guard.url || !guard.origin) {
      throw new BadRequestException(guard.reason ?? 'That URL cannot be discovered.');
    }

    const options = DiscoveryOptions.parse(body.options ?? {});
    const discoveryKey = hashObject({
      origin: guard.origin,
      options,
      pipeline: DISCOVERY_PIPELINE_VERSION,
    });

    const existing = await this.repo.runAs(orgId, userId, (tx) =>
      tx
        .select()
        .from(discoveryRuns)
        .where(and(eq(discoveryRuns.orgId, orgId), eq(discoveryRuns.discoveryKey, discoveryKey)))
        .limit(1),
    );

    // Re-submitting the same site with the same settings returns the existing
    // run rather than crawling somebody else's servers a second time. Only a
    // finished-or-running one counts: a failed run should be retryable.
    if (existing[0] && existing[0].status !== 'failed' && existing[0].status !== 'cancelled') {
      return this.toDto(existing[0]);
    }

    const row = await this.repo.runAs(orgId, userId, async (tx) => {
      const [created] = await tx
        .insert(discoveryRuns)
        .values({
          orgId,
          brandId: options.brandId ?? null,
          seedUrl: guard.url as string,
          originUrl: guard.origin as string,
          options,
          discoveryKey,
          pipelineVersion: DISCOVERY_PIPELINE_VERSION,
          status: 'queued',
          stage: 'pending',
          triggeredByUserId: userId ?? null,
          triggeredBy: 'ui',
        })
        .onConflictDoUpdate({
          target: [discoveryRuns.orgId, discoveryRuns.discoveryKey],
          set: { status: 'queued', stage: 'pending', error: null, stageErrors: [], updatedAt: new Date() },
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: 'discovery.start',
        entityType: 'discovery_run',
        entityId: created.id,
        payload: { originUrl: guard.origin, options },
      });

      return created;
    });

    await this.queue.enqueue(QUEUES.discoverBrand, {
      discoveryRunId: row.id,
      orgId,
      userId: userId ?? null,
    });

    return this.toDto(row);
  }

  async list(orgId: string, limit = 25): Promise<DiscoveryRunDTO[]> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(discoveryRuns)
        .where(eq(discoveryRuns.orgId, orgId))
        .orderBy(desc(discoveryRuns.createdAt))
        .limit(Math.min(limit, 100)),
    );
    return rows.map((r) => this.toDto(r));
  }

  async get(orgId: string, id: string): Promise<DiscoveryRunDTO> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).limit(1),
    );
    if (!rows[0]) throw new NotFoundException('Discovery run not found');
    return this.toDto(rows[0]);
  }

  /** The harvested pages, with signed previews so the report can show them. */
  async pages(orgId: string, id: string) {
    await this.get(orgId, id);

    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(discoveredPages)
        .where(eq(discoveredPages.discoveryRunId, id))
        .orderBy(discoveredPages.depth),
    );

    return Promise.all(
      rows.map(async (page) => ({
        id: page.id,
        url: page.url,
        depth: page.depth,
        role: page.role,
        title: page.title,
        httpStatus: page.httpStatus,
        viewport: page.viewport as 'desktop' | 'mobile',
        assetId: page.assetId,
        previewUrl: page.assetId
          ? await this.assets
              .get(orgId, page.assetId)
              .then((a) => a.previewUrl ?? null)
              .catch(() => null)
          : null,
        renderMs: page.renderMs,
        error: page.error,
      })),
    );
  }

  async cancel(orgId: string, id: string): Promise<DiscoveryRunDTO> {
    const row = await this.repo.runAs(orgId, undefined, async (tx) => {
      const [updated] = await tx
        .update(discoveryRuns)
        .set({ status: 'cancelled', updatedAt: new Date(), completedAt: new Date() })
        .where(eq(discoveryRuns.id, id))
        .returning();
      if (!updated) throw new NotFoundException('Discovery run not found');
      await this.audit.recordIn(tx, { action: 'discovery.cancel', entityType: 'discovery_run', entityId: id });
      return updated;
    });

    // The worker checks status between stages, so this stops the crawl at the
    // next boundary rather than mid-page. Killing a render leaves a half
    // written asset; waiting one page is the cheaper correctness trade.
    return this.toDto(row);
  }

  private toDto(row: DiscoveryRunRow): DiscoveryRunDTO {
    return {
      id: row.id,
      brandId: row.brandId,
      rulesetId: row.rulesetId,
      seedUrl: row.seedUrl,
      originUrl: row.originUrl,
      options: DiscoveryOptions.parse(row.options ?? {}),
      status: row.status,
      stage: row.stage,
      stageProgress: row.stageProgress,
      pagesDiscovered: row.pagesDiscovered,
      pagesHarvested: row.pagesHarvested,
      pagesFailed: row.pagesFailed,
      tokensProposed: row.tokensProposed,
      rulesProposed: row.rulesProposed,
      consistencyScore: row.consistencyScore,
      findingsTotal: row.findingsTotal,
      blockersTotal: row.blockersTotal,
      costUsd: row.costUsd,
      durationMs: row.durationMs,
      report: (row.report ?? null) as DiscoveryRunDTO['report'],
      // Rows written before `level` existed carry none, and every one of them
      // was a genuine failure — so an absent level reads as `error` here, the
      // same default the contract applies. Doing it at the boundary means the
      // UI never has to ask whether a missing level means "old row" or "note".
      stageErrors: (row.stageErrors ?? []).map((e) => ({ ...e, level: e.level ?? ('error' as const) })),
      error: row.error,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
