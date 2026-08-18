import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreateBriefInput, QUEUES } from '@brandlens/contracts';
import { assemblyPlans, briefs } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../brands/brands.service';
import { QueueService } from '../queue/queue.service';

export type BriefRow = typeof briefs.$inferSelect;

/**
 * Skill 2 — instruct to assemble.
 *
 * A brief in, a plan out: which approved assets to use, how to adapt them per
 * channel, and the generation instructions that keep the variants on-brand.
 * The plan records `rulesetHash`, so a plan is auditable against the exact
 * rules it was designed to satisfy.
 */
@Injectable()
export class AssembleService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async list(orgId: string, brandId?: string): Promise<BriefRow[]> {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(briefs)
        .where(brandId ? and(eq(briefs.orgId, orgId), eq(briefs.brandId, brandId)) : eq(briefs.orgId, orgId))
        .orderBy(desc(briefs.createdAt))
        .limit(200),
    );
  }

  async create(orgId: string, userId: string | undefined, input: z.infer<typeof CreateBriefInput>): Promise<BriefRow> {
    await this.brands.requireBrand(orgId, input.brandId);
    return this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .insert(briefs)
        .values({
          orgId,
          brandId: input.brandId,
          campaignId: input.campaignId ?? null,
          title: input.title,
          objective: input.objective ?? null,
          keyMessage: input.keyMessage ?? null,
          audience: (input.audience ?? {}) as Record<string, unknown>,
          mandatories: input.mandatories ?? null,
          targets: input.targets as unknown as Record<string, unknown>[],
          status: 'draft',
          createdByUserId: userId ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'brief.create',
        entityType: 'brief',
        entityId: row.id,
        payload: { brandId: input.brandId, title: input.title, targetCount: input.targets.length },
      });
      return row;
    });
  }

  async get(orgId: string, briefId: string): Promise<{ brief: BriefRow; plans: Array<typeof assemblyPlans.$inferSelect> }> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(briefs)
        .where(and(eq(briefs.id, briefId), eq(briefs.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Brief ${briefId} not found`);

    const plans = await this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(assemblyPlans).where(eq(assemblyPlans.briefId, briefId)).orderBy(desc(assemblyPlans.createdAt)),
    );
    return { brief: rows[0], plans };
  }

  /** Queues the plan build. The engine does the reasoning; we own the record. */
  async assemble(orgId: string, userId: string | undefined, briefId: string): Promise<{ briefId: string; status: string }> {
    const { brief } = await this.get(orgId, briefId);

    await this.repo.runAs(orgId, userId, (tx) =>
      tx.update(briefs).set({ status: 'assembling', updatedAt: new Date() }).where(eq(briefs.id, briefId)),
    );

    await this.queue.enqueue(
      QUEUES.assembleBrief,
      { orgId, briefId, brandId: brief.brandId, requestedByUserId: userId ?? null },
      { singletonKey: `assemble:${briefId}` },
    );

    return { briefId, status: 'assembling' };
  }
}
