import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ReviewDecisionInput, SubmitReviewInput } from '@brandlens/contracts';
import { assets, checkRuns, findings, reviewDecisions, reviews } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../platform/outbox.service';
import { FindingsService, type DecisionResult } from '../checks/findings.service';
import { offsetOf, paginate, type PageResult } from '../common/pagination';

export interface ListReviewsQuery {
  state?: string;
  stage?: string;
  assignedToUserId?: string;
  assetId?: string;
  /** Only reviews already past their SLA. */
  overdue?: boolean;
  page: number;
  pageSize: number;
}

export type ReviewRow = typeof reviews.$inferSelect;

/** Default SLA per stage, in hours. Legal is slowest and matters most. */
const STAGE_SLA_HOURS: Record<string, number> = {
  creative: 8,
  brand: 24,
  legal: 48,
  marketing_ops: 24,
};

@Injectable()
export class ReviewService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly findingsService: FindingsService,
  ) {}

  async list(orgId: string, query: ListReviewsQuery): Promise<PageResult<ReviewRow>> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const conditions = [eq(reviews.orgId, orgId)];
      if (query.state) conditions.push(eq(reviews.state, query.state as ReviewRow['state']));
      if (query.stage) conditions.push(eq(reviews.stage, query.stage));
      if (query.assignedToUserId) conditions.push(eq(reviews.assignedToUserId, query.assignedToUserId));
      if (query.assetId) conditions.push(eq(reviews.assetId, query.assetId));
      if (query.overdue) conditions.push(sql`${reviews.dueAt} < now() AND ${reviews.decidedAt} IS NULL`);

      const rows = await tx
        .select()
        .from(reviews)
        .where(and(...conditions))
        .orderBy(sql`${reviews.dueAt} ASC NULLS LAST`, desc(reviews.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query));

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(...conditions));

      return paginate(rows, n ?? 0, query);
    });
  }

  async get(orgId: string, reviewId: string) {
    const row = await this.findRow(orgId, reviewId);
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const [asset] = await tx.select().from(assets).where(eq(assets.id, row.assetId)).limit(1);
      const run = row.checkRunId
        ? (await tx.select().from(checkRuns).where(eq(checkRuns.id, row.checkRunId)).limit(1))[0]
        : null;
      const openFindings = row.checkRunId
        ? await tx
            .select()
            .from(findings)
            .where(eq(findings.checkRunId, row.checkRunId))
            .orderBy(findings.severity, desc(findings.createdAt))
        : [];
      const decisions = await tx
        .select()
        .from(reviewDecisions)
        .where(eq(reviewDecisions.reviewId, reviewId))
        .orderBy(desc(reviewDecisions.createdAt));

      return { review: row, asset, checkRun: run, findings: openFindings, decisions };
    });
  }

  /**
   * Opens a review queue item. Created by the check pipeline when a run has
   * blockers or abstentions, and by hand for MLR-style multi-stage gates.
   */
  async create(
    orgId: string,
    userId: string | undefined,
    input: { assetId: string; checkRunId?: string; stage?: string; assignedToUserId?: string; dueAt?: string },
  ): Promise<ReviewRow> {
    const stage = input.stage ?? 'brand';
    const dueAt = input.dueAt
      ? new Date(input.dueAt)
      : new Date(Date.now() + (STAGE_SLA_HOURS[stage] ?? 24) * 3_600_000);

    return this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .insert(reviews)
        .values({
          orgId,
          assetId: input.assetId,
          checkRunId: input.checkRunId ?? null,
          stage,
          state: input.assignedToUserId ? 'in_review' : 'pending',
          assignedToUserId: input.assignedToUserId ?? null,
          dueAt,
        })
        .returning();

      if (input.assignedToUserId) {
        await this.outbox.emitIn(tx, {
          orgId,
          type: 'review.assigned',
          aggregateType: 'review',
          aggregateId: row.id,
          payload: { reviewId: row.id, assetId: input.assetId, stage, assignedToUserId: input.assignedToUserId, dueAt },
          idempotencyKey: `review.assigned:${row.id}`,
        });
      }
      return row;
    });
  }

  async assign(orgId: string, actorUserId: string | undefined, reviewId: string, assigneeUserId: string) {
    await this.findRow(orgId, reviewId);
    return this.repo.runAs(orgId, actorUserId, async (tx) => {
      const [row] = await tx
        .update(reviews)
        .set({ assignedToUserId: assigneeUserId, state: 'in_review', updatedAt: new Date() })
        .where(and(eq(reviews.id, reviewId), eq(reviews.orgId, orgId)))
        .returning();

      await this.audit.recordIn(tx, {
        action: 'review.assign',
        entityType: 'review',
        entityId: reviewId,
        payload: { assigneeUserId },
      });
      await this.outbox.emitIn(tx, {
        orgId,
        type: 'review.assigned',
        aggregateType: 'review',
        aggregateId: reviewId,
        payload: { reviewId, assignedToUserId: assigneeUserId },
      });
      return row;
    });
  }

  /**
   * A decision inside a review context. Delegates the finding-level work so
   * that `POST /v1/findings/:id/decision` and `POST /v1/reviews/:id/decision`
   * cannot drift — precedent indexing and calibration must fire identically
   * whichever surface the reviewer used.
   */
  async decide(
    orgId: string,
    userId: string | undefined,
    reviewId: string,
    input: z.infer<typeof ReviewDecisionInput>,
  ): Promise<DecisionResult> {
    if (!userId) throw new BadRequestException('Review decisions require a human session');
    const review = await this.findRow(orgId, reviewId);

    if (input.findingId) {
      return this.findingsService.decide(orgId, userId, input.findingId, input, reviewId);
    }

    // A review-level comment or escalation with no finding attached.
    return this.repo.runAs(orgId, userId, async (tx) => {
      await tx.insert(reviewDecisions).values({
        orgId,
        reviewId,
        traceId: input.traceId ?? null,
        assetId: review.assetId,
        action: input.action,
        rationale: input.rationale ?? null,
        annotationBbox: input.annotationBbox ?? null,
        reviewerUserId: userId,
        isCalibrationLabel: input.isCalibrationLabel,
      });

      if (input.action === 'escalate') {
        await tx
          .update(reviews)
          .set({ state: 'changes_requested', updatedAt: new Date() })
          .where(eq(reviews.id, reviewId));
      }

      await this.audit.recordIn(tx, {
        action: `review.${input.action}`,
        entityType: 'review',
        entityId: reviewId,
        payload: { action: input.action, rationale: input.rationale },
      });

      return {
        findingId: null,
        traceId: input.traceId ?? null,
        action: input.action,
        findingStatus: null,
        precedentQueued: false,
        calibrationQueued: false,
      };
    });
  }

  /** Closes a review. `approved` is the record a regulator will ask to see. */
  async submit(
    orgId: string,
    userId: string | undefined,
    reviewId: string,
    input: z.infer<typeof SubmitReviewInput>,
  ): Promise<ReviewRow> {
    if (!userId) throw new BadRequestException('Submitting a review requires a human session');
    await this.findRow(orgId, reviewId);

    return this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .update(reviews)
        .set({
          state: input.state,
          summary: input.summary ?? null,
          decidedByUserId: userId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(reviews.id, reviewId), eq(reviews.orgId, orgId)))
        .returning();

      await this.audit.recordIn(tx, {
        action: 'review.submit',
        entityType: 'review',
        entityId: reviewId,
        payload: { state: input.state, summary: input.summary },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'review.decided',
        aggregateType: 'review',
        aggregateId: reviewId,
        payload: { reviewId, state: input.state, decidedByUserId: userId, assetId: row.assetId },
        idempotencyKey: `review.decided:${reviewId}`,
      });

      return row;
    });
  }

  /** Queue counts for the dashboard, including the SLA breach count. */
  async queueStats(orgId: string): Promise<{ pending: number; inReview: number; overdue: number }> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(eq(reviews.orgId, orgId), eq(reviews.state, 'pending')));
      const [inReview] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(eq(reviews.orgId, orgId), eq(reviews.state, 'in_review')));
      const [overdue] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(eq(reviews.orgId, orgId), isNull(reviews.decidedAt), sql`${reviews.dueAt} < now()`));
      return { pending: pending?.n ?? 0, inReview: inReview?.n ?? 0, overdue: overdue?.n ?? 0 };
    });
  }

  private async findRow(orgId: string, reviewId: string): Promise<ReviewRow> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(reviews)
        .where(and(eq(reviews.id, reviewId), eq(reviews.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Review ${reviewId} not found`);
    return rows[0];
  }
}
