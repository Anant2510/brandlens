import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AnalyticsQuery, type DashboardSummary, type RuleHealthRow } from '@brandlens/contracts';
import { checkRuns, costLedger, decisionTraces, findings, reviewDecisions, reviews, ruleCalibrations, rules } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';

type Query = z.infer<typeof AnalyticsQuery>;

export interface CostReport {
  totalUsd: number;
  assetsAnalyzed: number;
  costPerAsset: number;
  costPerCheck: number;
  cacheHitRate: number;
  cacheSavingsUsd: number;
  byRule: Array<{ ruleKey: string; costUsd: number; evaluations: number; costPerEvaluation: number }>;
  byProvider: Array<{ provider: string; model: string; costUsd: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; checks: number }>;
}

export interface CoverageReport {
  /** The headline: what share we settled without a human. */
  autoClearedRate: number;
  totalCriteria: number;
  decidedCriteria: number;
  abstainedCriteria: number;
  byDimension: Array<{ dimension: string; coverage: number; evaluations: number; abstentions: number }>;
  autoRoutedRules: Array<{ ruleKey: string; beta: number | null; reason: string }>;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly repo: TenantRepository) {}

  async summary(orgId: string, query: Query): Promise<DashboardSummary> {
    const { from, to } = window(query);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const runConditions = [eq(checkRuns.orgId, orgId), gte(checkRuns.createdAt, from), lte(checkRuns.createdAt, to)];
      if (query.brandId) runConditions.push(eq(checkRuns.brandId, query.brandId));

      const [totals] = await tx
        .select({
          checks: sql<number>`count(*)::int`,
          assets: sql<number>`count(distinct ${checkRuns.assetId})::int`,
          passes: sql<number>`count(*) filter (where ${checkRuns.scoreBand} = 'pass')::int`,
          blockers: sql<number>`count(*) filter (where ${checkRuns.hasBlocker})::int`,
          avgScore: sql<number | null>`avg(${checkRuns.score})`,
          cacheHits: sql<number>`coalesce(sum(${checkRuns.cacheHits}), 0)::int`,
          cacheMisses: sql<number>`coalesce(sum(${checkRuns.cacheMisses}), 0)::int`,
          cost: sql<number>`coalesce(sum(${checkRuns.costUsd}), 0)::float`,
          criteriaTotal: sql<number>`coalesce(sum(${checkRuns.criteriaTotal}), 0)::int`,
          criteriaEvaluated: sql<number>`coalesce(sum(${checkRuns.criteriaEvaluated}), 0)::int`,
        })
        .from(checkRuns)
        .where(and(...runConditions));

      const [openFindings] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(findings)
        .where(and(eq(findings.orgId, orgId), eq(findings.status, 'open')));

      const [pendingReviews] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(eq(reviews.orgId, orgId), sql`${reviews.state} in ('pending','in_review')`));

      const topFailing = await tx
        .select({
          ruleKey: findings.ruleKey,
          count: sql<number>`count(*)::int`,
        })
        .from(findings)
        .where(and(eq(findings.orgId, orgId), gte(findings.createdAt, from), lte(findings.createdAt, to)))
        .groupBy(findings.ruleKey)
        .orderBy(sql`count(*) DESC`)
        .limit(10);

      const statements = await tx
        .select({ key: rules.key, statement: rules.statement })
        .from(rules)
        .where(eq(rules.orgId, orgId));
      const statementByKey = new Map(statements.map((s) => [s.key, s.statement]));

      // `date_trunc`'s first argument has to be inlined rather than bound: a
      // bound parameter appears as a DIFFERENT placeholder in SELECT and in
      // GROUP BY, so Postgres cannot see them as the same expression and
      // rejects the query. `granularity` is a validated zod enum, and
      // `truncUnit` re-checks it, so nothing caller-controlled reaches SQL.
      const unit = truncUnit(query.granularity);
      const bucket = sql.raw(`date_trunc('${unit}', check_runs.created_at)`);

      const trend = await tx
        .select({
          date: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
          avgScore: sql<number | null>`avg(${checkRuns.score})`,
          checks: sql<number>`count(*)::int`,
        })
        .from(checkRuns)
        .where(and(...runConditions))
        .groupBy(bucket)
        .orderBy(bucket);

      const dimensionRows = await tx
        .select({
          dimension: decisionTraces.dimension,
          evaluations: sql<number>`count(*) filter (where ${decisionTraces.verdict} in ('pass','fail'))::int`,
          passes: sql<number>`count(*) filter (where ${decisionTraces.verdict} = 'pass')::int`,
        })
        .from(decisionTraces)
        .where(and(eq(decisionTraces.orgId, orgId), gte(decisionTraces.createdAt, from), lte(decisionTraces.createdAt, to)))
        .groupBy(decisionTraces.dimension);

      const checks = totals?.checks ?? 0;
      const cacheTotal = (totals?.cacheHits ?? 0) + (totals?.cacheMisses ?? 0);
      const criteriaTotal = totals?.criteriaTotal ?? 0;

      return {
        checksRun: checks,
        assetsAnalyzed: totals?.assets ?? 0,
        passRate: ratio(totals?.passes ?? 0, checks),
        blockerRate: ratio(totals?.blockers ?? 0, checks),
        avgScore: totals?.avgScore === null || totals?.avgScore === undefined ? null : round2(Number(totals.avgScore)),
        // Auto-cleared: criteria the system decided without escalating.
        autoClearedRate: ratio(totals?.criteriaEvaluated ?? 0, criteriaTotal),
        cacheHitRate: ratio(totals?.cacheHits ?? 0, cacheTotal),
        costUsd: round4(Number(totals?.cost ?? 0)),
        costPerAsset: totals?.assets ? round4(Number(totals.cost) / totals.assets) : 0,
        openFindings: openFindings?.n ?? 0,
        pendingReviews: pendingReviews?.n ?? 0,
        topFailingRules: topFailing.map((r) => ({
          ruleKey: r.ruleKey,
          statement: statementByKey.get(r.ruleKey) ?? r.ruleKey,
          count: r.count,
        })),
        scoreTrend: trend.map((t) => ({
          date: t.date,
          avgScore: t.avgScore === null ? 0 : round2(Number(t.avgScore)),
          checks: t.checks,
        })),
        dimensionBreakdown: dimensionRows.map((d) => ({
          dimension: d.dimension,
          passRate: ratio(d.passes, d.evaluations),
          evaluations: d.evaluations,
        })),
      };
    });
  }

  /**
   * Rule health. Override rate is the key metric: above about 20% the rule is
   * broken, not the customer. It is the number that tells you which rule to
   * rewrite, and it is why review decisions are stored per rule key.
   */
  async ruleHealth(orgId: string, query: Query): Promise<RuleHealthRow[]> {
    const { from, to } = window(query);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const traceConditions = [
        eq(decisionTraces.orgId, orgId),
        gte(decisionTraces.createdAt, from),
        lte(decisionTraces.createdAt, to),
      ];

      const evaluations = await tx
        .select({
          ruleKey: decisionTraces.ruleKey,
          dimension: decisionTraces.dimension,
          tier: decisionTraces.tier,
          severity: decisionTraces.severity,
          evaluations: sql<number>`count(*)::int`,
          fails: sql<number>`count(*) filter (where ${decisionTraces.verdict} = 'fail')::int`,
          costUsd: sql<number>`coalesce(sum(${decisionTraces.costUsd}), 0)::float`,
        })
        .from(decisionTraces)
        .where(and(...traceConditions))
        .groupBy(decisionTraces.ruleKey, decisionTraces.dimension, decisionTraces.tier, decisionTraces.severity);

      const overrides = await tx
        .select({
          ruleKey: reviewDecisions.ruleKey,
          total: sql<number>`count(*)::int`,
          overrides: sql<number>`count(*) filter (where ${reviewDecisions.action} in ('override_pass','override_fail'))::int`,
        })
        .from(reviewDecisions)
        .where(eq(reviewDecisions.orgId, orgId))
        .groupBy(reviewDecisions.ruleKey);
      const overrideByKey = new Map(overrides.filter((o) => o.ruleKey).map((o) => [o.ruleKey as string, o]));

      const calibrations = await tx
        .select({
          ruleKey: ruleCalibrations.ruleKey,
          beta: ruleCalibrations.beta,
          agreementRate: ruleCalibrations.agreementRate,
          autoRouteToHuman: ruleCalibrations.autoRouteToHuman,
          createdAt: ruleCalibrations.createdAt,
        })
        .from(ruleCalibrations)
        .where(eq(ruleCalibrations.orgId, orgId))
        .orderBy(sql`${ruleCalibrations.createdAt} DESC`);
      const calibrationByKey = new Map<string, (typeof calibrations)[number]>();
      for (const c of calibrations) if (!calibrationByKey.has(c.ruleKey)) calibrationByKey.set(c.ruleKey, c);

      const statements = await tx
        .select({ key: rules.key, statement: rules.statement })
        .from(rules)
        .where(eq(rules.orgId, orgId));
      const statementByKey = new Map(statements.map((s) => [s.key, s.statement]));

      return evaluations
        .map((row) => {
          const o = overrideByKey.get(row.ruleKey);
          const c = calibrationByKey.get(row.ruleKey);
          return {
            ruleKey: row.ruleKey,
            statement: statementByKey.get(row.ruleKey) ?? row.ruleKey,
            dimension: row.dimension as RuleHealthRow['dimension'],
            severity: row.severity as RuleHealthRow['severity'],
            tier: row.tier,
            evaluations: row.evaluations,
            failRate: ratio(row.fails, row.evaluations),
            overrideRate: o ? ratio(o.overrides, o.total) : 0,
            agreementRate: c?.agreementRate ?? null,
            beta: c?.beta ?? null,
            autoRouteToHuman: Boolean(c?.autoRouteToHuman),
            costUsd: round4(Number(row.costUsd)),
          } satisfies RuleHealthRow;
        })
        .sort((a, b) => b.overrideRate - a.overrideRate || b.evaluations - a.evaluations);
    });
  }

  async cost(orgId: string, query: Query): Promise<CostReport> {
    const { from, to } = window(query);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const runConditions = [eq(checkRuns.orgId, orgId), gte(checkRuns.createdAt, from), lte(checkRuns.createdAt, to)];
      if (query.brandId) runConditions.push(eq(checkRuns.brandId, query.brandId));

      const [totals] = await tx
        .select({
          cost: sql<number>`coalesce(sum(${checkRuns.costUsd}), 0)::float`,
          checks: sql<number>`count(*)::int`,
          assets: sql<number>`count(distinct ${checkRuns.assetId})::int`,
          cacheHits: sql<number>`coalesce(sum(${checkRuns.cacheHits}), 0)::int`,
          cacheMisses: sql<number>`coalesce(sum(${checkRuns.cacheMisses}), 0)::int`,
        })
        .from(checkRuns)
        .where(and(...runConditions));

      const byRule = await tx
        .select({
          ruleKey: decisionTraces.ruleKey,
          costUsd: sql<number>`coalesce(sum(${decisionTraces.costUsd}), 0)::float`,
          evaluations: sql<number>`count(*)::int`,
          cachedCount: sql<number>`count(*) filter (where ${decisionTraces.cached})::int`,
        })
        .from(decisionTraces)
        .where(and(eq(decisionTraces.orgId, orgId), gte(decisionTraces.createdAt, from), lte(decisionTraces.createdAt, to)))
        .groupBy(decisionTraces.ruleKey)
        .orderBy(sql`sum(${decisionTraces.costUsd}) DESC NULLS LAST`)
        .limit(50);

      const byProvider = await tx
        .select({
          provider: costLedger.provider,
          model: costLedger.model,
          costUsd: sql<number>`coalesce(sum(${costLedger.costUsd}::float), 0)::float`,
          calls: sql<number>`count(*)::int`,
        })
        .from(costLedger)
        .where(and(eq(costLedger.orgId, orgId), gte(costLedger.createdAt, from), lte(costLedger.createdAt, to)))
        .groupBy(costLedger.provider, costLedger.model);

      const dayBucket = sql.raw(`date_trunc('day', check_runs.created_at)`);
      const byDay = await tx
        .select({
          date: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
          costUsd: sql<number>`coalesce(sum(${checkRuns.costUsd}), 0)::float`,
          checks: sql<number>`count(*)::int`,
        })
        .from(checkRuns)
        .where(and(...runConditions))
        .groupBy(dayBucket)
        .orderBy(dayBucket);

      const cacheTotal = (totals?.cacheHits ?? 0) + (totals?.cacheMisses ?? 0);
      const avgCostPerEval =
        byRule.length > 0
          ? byRule.reduce((acc, r) => acc + Number(r.costUsd), 0) /
            Math.max(1, byRule.reduce((acc, r) => acc + r.evaluations - r.cachedCount, 0))
          : 0;

      return {
        totalUsd: round4(Number(totals?.cost ?? 0)),
        assetsAnalyzed: totals?.assets ?? 0,
        costPerAsset: totals?.assets ? round4(Number(totals.cost) / totals.assets) : 0,
        costPerCheck: totals?.checks ? round4(Number(totals.cost) / totals.checks) : 0,
        cacheHitRate: ratio(totals?.cacheHits ?? 0, cacheTotal),
        // What the cache saved: replayed evaluations priced at the average
        // cost of the ones we actually paid for.
        cacheSavingsUsd: round4((totals?.cacheHits ?? 0) * avgCostPerEval),
        byRule: byRule.map((r) => ({
          ruleKey: r.ruleKey,
          costUsd: round4(Number(r.costUsd)),
          evaluations: r.evaluations,
          costPerEvaluation: r.evaluations ? round4(Number(r.costUsd) / r.evaluations) : 0,
        })),
        byProvider: byProvider.map((p) => ({
          provider: p.provider,
          model: p.model,
          costUsd: round4(Number(p.costUsd)),
          calls: p.calls,
        })),
        byDay: byDay.map((d) => ({ date: d.date, costUsd: round4(Number(d.costUsd)), checks: d.checks })),
      };
    });
  }

  async coverage(orgId: string, query: Query): Promise<CoverageReport> {
    const { from, to } = window(query);

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const rows = await tx
        .select({
          dimension: decisionTraces.dimension,
          total: sql<number>`count(*)::int`,
          decided: sql<number>`count(*) filter (where ${decisionTraces.verdict} in ('pass','fail','not_applicable'))::int`,
          abstained: sql<number>`count(*) filter (where ${decisionTraces.verdict} in ('abstained','insufficient_evidence'))::int`,
        })
        .from(decisionTraces)
        .where(and(eq(decisionTraces.orgId, orgId), gte(decisionTraces.createdAt, from), lte(decisionTraces.createdAt, to)))
        .groupBy(decisionTraces.dimension);

      const autoRouted = await tx
        .select({ ruleKey: ruleCalibrations.ruleKey, beta: ruleCalibrations.beta })
        .from(ruleCalibrations)
        .where(and(eq(ruleCalibrations.orgId, orgId), eq(ruleCalibrations.autoRouteToHuman, true)));

      const total = rows.reduce((acc, r) => acc + r.total, 0);
      const decided = rows.reduce((acc, r) => acc + r.decided, 0);
      const abstained = rows.reduce((acc, r) => acc + r.abstained, 0);

      return {
        autoClearedRate: ratio(decided, total),
        totalCriteria: total,
        decidedCriteria: decided,
        abstainedCriteria: abstained,
        byDimension: rows.map((r) => ({
          dimension: r.dimension,
          coverage: ratio(r.decided, r.total),
          evaluations: r.total,
          abstentions: r.abstained,
        })),
        autoRoutedRules: autoRouted.map((r) => ({
          ruleKey: r.ruleKey,
          beta: r.beta,
          reason: 'beta below 0.3 — judge does not track this tenant’s reviewers',
        })),
      };
    });
  }
}

/** Whitelist, so an inlined identifier can never be caller-controlled. */
function truncUnit(granularity: string): 'day' | 'week' | 'month' {
  return granularity === 'week' || granularity === 'month' ? granularity : 'day';
}

function window(query: Query): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
