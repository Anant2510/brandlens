import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreatePredictionInput, QUEUES } from '@brandlens/contracts';
import { audiencePanels, predictions } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { AssetsService } from '../assets/assets.service';
import { BrandsService } from '../brands/brands.service';
import { QueueService } from '../queue/queue.service';

export type PanelRow = typeof audiencePanels.$inferSelect;
export type PredictionRow = typeof predictions.$inferSelect;

export const CreatePanelInput = z.object({
  brandId: z.string().uuid(),
  name: z.string().min(1),
  personas: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string(),
        demographics: z.record(z.unknown()).optional(),
        psychographics: z.record(z.unknown()).optional(),
        mediaHabits: z.record(z.unknown()).optional(),
        objections: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  groundingStats: z.record(z.unknown()).optional(),
});

/**
 * Skill 3 — predict.
 *
 * Reported as a distribution against the tenant's own corpus, never as a bare
 * absolute number. VLM judges rank far better than they score, so the useful
 * question is "where does this sit relative to our last fifty assets", not
 * "give it a 7.4".
 */
@Injectable()
export class PredictService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async listPanels(orgId: string, brandId?: string): Promise<PanelRow[]> {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(audiencePanels)
        .where(
          brandId ? and(eq(audiencePanels.orgId, orgId), eq(audiencePanels.brandId, brandId)) : eq(audiencePanels.orgId, orgId),
        )
        .orderBy(desc(audiencePanels.createdAt)),
    );
  }

  async createPanel(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof CreatePanelInput>,
  ): Promise<PanelRow> {
    await this.brands.requireBrand(orgId, input.brandId);
    return this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .insert(audiencePanels)
        .values({
          orgId,
          brandId: input.brandId,
          name: input.name,
          personas: input.personas as unknown as Record<string, unknown>[],
          groundingStats: (input.groundingStats ?? {}) as Record<string, unknown>,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'panel.create',
        entityType: 'audience_panel',
        entityId: row.id,
        payload: { brandId: input.brandId, name: input.name, personaCount: input.personas.length },
      });
      return row;
    });
  }

  async createPrediction(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof CreatePredictionInput>,
  ): Promise<PredictionRow> {
    const asset = await this.assets.findRow(orgId, input.assetId);

    const row = await this.repo.runAs(orgId, userId, async (tx) => {
      const [inserted] = await tx
        .insert(predictions)
        .values({
          orgId,
          assetId: input.assetId,
          panelId: input.panelId ?? null,
          status: 'queued',
          comparisonAssetIds: input.comparisonAssetIds ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'prediction.create',
        entityType: 'prediction',
        entityId: inserted.id,
        payload: { assetId: input.assetId, panelId: input.panelId },
      });
      return inserted;
    });

    await this.queue.enqueue(
      QUEUES.predictAsset,
      { orgId, predictionId: row.id, assetId: input.assetId, brandId: asset.brandId, panelId: input.panelId ?? null },
      { singletonKey: `predict:${row.id}` },
    );

    return row;
  }

  async getPrediction(orgId: string, predictionId: string): Promise<PredictionRow> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(predictions)
        .where(and(eq(predictions.id, predictionId), eq(predictions.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Prediction ${predictionId} not found`);
    return rows[0];
  }
}
