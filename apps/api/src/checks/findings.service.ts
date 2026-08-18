import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { QUEUES, ReviewDecisionInput, type FindingDTO } from '@brandlens/contracts';
import { type Database, checkRuns, decisionTraces, findings, reviewDecisions } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { QueueService } from '../queue/queue.service';
import { OutboxService } from '../platform/outbox.service';
import { offsetOf, paginate, type PageResult } from '../common/pagination';

export interface ListFindingsQuery {
  brandId?: string;
  assetId?: string;
  checkRunId?: string;
  ruleKey?: string;
  severity?: string;
  status?: string;
  /** Hide low-confidence flags by default — reviewer trust is the scarce thing. */
  highConfidenceOnly?: boolean;
  page: number;
  pageSize: number;
}

export interface DecisionResult {
  findingId: string | null;
  traceId: string | null;
  action: string;
  findingStatus: string | null;
  precedentQueued: boolean;
  calibrationQueued: boolean;
}

@Injectable()
export class FindingsService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
  ) {}

  async list(orgId: string, query: ListFindingsQuery): Promise<PageResult<FindingDTO>> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const conditions = [eq(findings.orgId, orgId)];
      if (query.assetId) conditions.push(eq(findings.assetId, query.assetId));
      if (query.checkRunId) conditions.push(eq(findings.checkRunId, query.checkRunId));
      if (query.ruleKey) conditions.push(eq(findings.ruleKey, query.ruleKey));
      if (query.severity) conditions.push(eq(findings.severity, query.severity as FindingRow['severity']));
      if (query.status) conditions.push(eq(findings.status, query.status as FindingRow['status']));
      if (query.highConfidenceOnly) conditions.push(eq(findings.isHighConfidence, true));
      if (query.brandId) conditions.push(sql`${findings.checkRunId} IN (SELECT id FROM check_runs WHERE brand_id = ${query.brandId})`);

      const rows = await tx
        .select()
        .from(findings)
        .where(and(...conditions))
        .orderBy(desc(findings.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query));

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(findings)
        .where(and(...conditions));

      return paginate(rows.map(toFindingDto), n ?? 0, query);
    });
  }

  async get(orgId: string, findingId: string) {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(findings)
        .where(and(eq(findings.id, findingId), eq(findings.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Finding ${findingId} not found`);
    return rows[0];
  }

  /** Finding + its trace + the run it belongs to — the "explain" payload. */
  async explain(orgId: string, findingId: string) {
    const finding = await this.get(orgId, findingId);
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const [trace] = await tx.select().from(decisionTraces).where(eq(decisionTraces.id, finding.traceId)).limit(1);
      const [run] = await tx.select().from(checkRuns).where(eq(checkRuns.id, finding.checkRunId)).limit(1);
      const priorDecisions = await tx
        .select()
        .from(reviewDecisions)
        .where(and(eq(reviewDecisions.orgId, orgId), eq(reviewDecisions.ruleKey, finding.ruleKey)))
        .orderBy(desc(reviewDecisions.createdAt))
        .limit(10);
      return { finding: toFindingDto(finding), trace, run, priorDecisions };
    });
  }

  /**
   * Records a human decision.
   *
   * This is the highest-value write in the product. It does four things in one
   * transaction — the review_decision row, the finding's new status, the
   * precedent index job and the calibration job — because a decision that is
   * recorded but never learned from is just a status change, and the whole
   * "it learned our brand" behaviour depends on both jobs actually running.
   */
  async decide(
    orgId: string,
    userId: string | undefined,
    findingId: string,
    input: z.infer<typeof ReviewDecisionInput>,
    reviewId?: string,
  ): Promise<DecisionResult> {
    if (!userId) throw new BadRequestException('Review decisions require a human session; API keys cannot decide');

    const isOverride = input.action === 'override_pass' || input.action === 'override_fail';
    if (isOverride && !input.rationale?.trim()) {
      // The rationale is both the audit record and the natural-language signal
      // that prompt optimisation consumes. An override without one is a lost
      // training example.
      throw new BadRequestException('`rationale` is required when overriding a machine verdict');
    }

    const finding = await this.get(orgId, findingId);

    const result = await this.repo.runAs(orgId, userId, async (tx) => {
      const [trace] = await tx.select().from(decisionTraces).where(eq(decisionTraces.id, finding.traceId)).limit(1);

      await tx.insert(reviewDecisions).values({
        orgId,
        reviewId: reviewId ?? null,
        traceId: finding.traceId,
        findingId: finding.id,
        assetId: finding.assetId,
        ruleKey: finding.ruleKey,
        ruleVersion: trace?.ruleVersion ?? null,
        action: input.action,
        rationale: input.rationale ?? null,
        annotationBbox: input.annotationBbox ?? null,
        reviewerUserId: userId,
        isCalibrationLabel: input.isCalibrationLabel,
      });

      const status = findingStatusFor(input.action);
      if (status) {
        await tx
          .update(findings)
          .set({ status, resolvedByUserId: userId, resolvedAt: new Date() })
          .where(eq(findings.id, finding.id));
      }

      await this.audit.recordIn(tx, {
        action: `finding.${input.action}`,
        entityType: 'finding',
        entityId: finding.id,
        payload: {
          ruleKey: finding.ruleKey,
          assetId: finding.assetId,
          action: input.action,
          rationale: input.rationale,
          isCalibrationLabel: input.isCalibrationLabel,
        },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'review.decided',
        aggregateType: 'finding',
        aggregateId: finding.id,
        payload: {
          findingId: finding.id,
          traceId: finding.traceId,
          assetId: finding.assetId,
          ruleKey: finding.ruleKey,
          action: input.action,
          reviewerUserId: userId,
        },
      });

      return { status, ruleVersion: trace?.ruleVersion ?? 1, brandId: await brandIdOf(tx, finding.checkRunId) };
    });

    // Learning is queued rather than inline: embedding the precedent and
    // refitting the calibration must not make a reviewer wait for their click.
    const humanVerdict = humanVerdictFor(input.action, finding.severity);
    const precedentQueued = await this.queue
      .enqueue(
        QUEUES.indexPrecedent,
        {
          orgId,
          brandId: result.brandId,
          ruleKey: finding.ruleKey,
          ruleVersion: result.ruleVersion,
          assetId: finding.assetId,
          traceId: finding.traceId,
          verdict: humanVerdict,
          rationale: input.rationale ?? null,
        },
        { singletonKey: `precedent:${finding.id}` },
      )
      .then(() => true)
      .catch(() => false);

    const calibrationQueued = await this.queue
      .enqueue(
        QUEUES.calibrateRule,
        { orgId, brandId: result.brandId, ruleKey: finding.ruleKey },
        { singletonKey: `calibrate:${result.brandId}:${finding.ruleKey}` },
      )
      .then(() => true)
      .catch(() => false);

    return {
      findingId: finding.id,
      traceId: finding.traceId,
      action: input.action,
      findingStatus: result.status,
      precedentQueued,
      calibrationQueued,
    };
  }
}

type FindingRow = typeof findings.$inferSelect;

async function brandIdOf(tx: Database, checkRunId: string): Promise<string> {
  const [row] = await tx.select({ brandId: checkRuns.brandId }).from(checkRuns).where(eq(checkRuns.id, checkRunId)).limit(1);
  return row?.brandId ?? '';
}

function findingStatusFor(action: string): FindingRow['status'] | null {
  switch (action) {
    case 'confirm':
      return 'confirmed';
    case 'override_pass':
      return 'overridden';
    case 'override_fail':
      return 'confirmed';
    case 'waive':
      return 'waived';
    default:
      return null; // comment / escalate leave the finding open
  }
}

/**
 * What the human actually believes, which is what gets indexed as precedent.
 * `override_pass` means "the machine flagged this and it is fine"; the
 * precedent must record `pass`, or the next retrieval teaches the judge the
 * opposite of what the reviewer said.
 */
function humanVerdictFor(action: string, _severity: string): 'pass' | 'fail' {
  if (action === 'override_pass' || action === 'waive') return 'pass';
  return 'fail';
}

export function toFindingDto(row: FindingRow): FindingDTO {
  return {
    id: row.id,
    traceId: row.traceId,
    ruleKey: row.ruleKey,
    dimension: row.dimension as FindingDTO['dimension'],
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    status: row.status,
    bbox: row.bbox ?? null,
    cropKey: row.cropKey,
    displayConfidence: row.displayConfidence,
    isHighConfidence: row.isHighConfidence,
    createdAt: row.createdAt.toISOString(),
  };
}
