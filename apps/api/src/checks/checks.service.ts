import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  type CheckRunDetail,
  type CheckRunSummary,
  CreateCheckInput,
  ListChecksQuery,
  QUEUES,
  type EngineCriterionResult,
} from '@brandlens/contracts';
import {
  type Database,
  assetMeasurements,
  assets,
  checkRuns,
  costLedger,
  decisionTraces,
  findings,
} from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { AssetsService, type AssetRow } from '../assets/assets.service';
import { BrandsService } from '../brands/brands.service';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { OutboxService } from '../platform/outbox.service';
import { EngineClient } from '../engine/engine.client';
import { BrandContextBuilder } from '../engine/brand-context.builder';
import { RulesetCompilerService, type CompiledRule } from '../rulesets/ruleset-compiler.service';
import { ScoringService, type ScorableCriterion } from '../scoring/scoring.service';
import { PrecedentService } from '../learning/precedent.service';
import { AppConfigService } from '../config/config.service';
import { NoActiveRulesetException } from '../common/errors';
import { PIPELINE_VERSION, hashObject, jobKey as computeJobKey, promptHash, traceKey as computeTraceKey } from '../common/hash';
import { offsetOf, paginate, type PageResult } from '../common/pagination';
import { buildFindingDetail } from './finding-detail';

export interface CreateCheckResult {
  run: CheckRunSummary | CheckRunDetail;
  created: boolean;
  status: 'queued' | 'completed' | 'reused';
}

type CheckRunRow = typeof checkRuns.$inferSelect;

@Injectable()
export class ChecksService {
  private readonly logger = new Logger(ChecksService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
    private readonly assets: AssetsService,
    private readonly brands: BrandsService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
    private readonly engine: EngineClient,
    private readonly contextBuilder: BrandContextBuilder,
    private readonly compiler: RulesetCompilerService,
    private readonly scoring: ScoringService,
    private readonly precedents: PrecedentService,
    private readonly config: AppConfigService,
  ) {}

  /* ==================================================================== *
   * POST /v1/checks — the wedge endpoint.
   * ==================================================================== */
  async create(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof CreateCheckInput>,
    options: { triggeredBy?: string; idempotencyKey?: string; correlationId?: string } = {},
  ): Promise<CreateCheckResult> {
    const asset = await this.resolveAsset(orgId, userId, input);
    const brandId = input.brandId ?? asset.brandId;
    await this.brands.requireBrand(orgId, brandId);

    const compiled = input.rulesetId
      ? await this.compiler.loadRuleset(orgId, input.rulesetId)
      : await this.compiler.activeRuleset(orgId, brandId);
    if (!compiled) throw new NoActiveRulesetException(brandId);

    // Resolve the lattice for THIS asset's coordinates before hashing: a run
    // against the German feed variant is not the same job as the global one,
    // even though both derive from the same published ruleset.
    const resolved = this.compiler
      .resolveForContext(compiled, {
        market: asset.market,
        channel: asset.channel,
        assetType: asset.assetType,
        campaign: asset.campaignId,
      })
      .filter((r) => (input.dimensions?.length ? input.dimensions.includes(r.dimension as never) : true))
      .filter((r) => (input.deterministicOnly ? r.tier === 'deterministic' : true));

    if (resolved.length === 0) {
      throw new BadRequestException('No active rules apply to this asset under the current ruleset and filters');
    }

    const variant = hashObject({
      dimensions: [...(input.dimensions ?? [])].sort(),
      deterministicOnly: input.deterministicOnly,
      // Idempotency-Key partitions the key space so a caller that deliberately
      // wants a second run of identical inputs can get one without `force`.
      idempotencyKey: options.idempotencyKey ?? input.idempotencyKey ?? null,
    });

    const jobKey = computeJobKey({
      assetContentHash: asset.contentHash,
      rulesetHash: compiled.hash,
      pipelineVersion: PIPELINE_VERSION,
      modelVersion: this.config.judgeModelVersion,
      promptHash: this.promptHashFor(resolved),
      variant,
    });

    const existing = await this.findByJobKey(orgId, jobKey);
    if (existing && !input.force) {
      // Idempotent by construction: the same bytes under the same rules with
      // the same model and prompt cannot produce a different answer, so
      // returning the previous run is correct, not a shortcut.
      const run = input.async === false ? await this.detail(orgId, existing.id) : toSummary(existing);
      return { run, created: false, status: 'reused' };
    }

    const runRow = await this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .insert(checkRuns)
        .values({
          orgId,
          brandId,
          assetId: asset.id,
          rulesetId: input.rulesetId ?? null,
          jobKey: input.force ? `${jobKey.slice(0, 56)}${randomUUID().slice(0, 8)}` : jobKey,
          rulesetHash: compiled.hash,
          pipelineVersion: PIPELINE_VERSION,
          status: 'queued',
          criteriaTotal: resolved.length,
          triggeredByUserId: userId ?? null,
          triggeredBy: options.triggeredBy ?? 'api',
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: 'check.create',
        entityType: 'check_run',
        entityId: row.id,
        payload: { assetId: asset.id, brandId, rulesetHash: compiled.hash, ruleCount: resolved.length, async: input.async },
      });

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'check.started',
        aggregateType: 'check_run',
        aggregateId: row.id,
        payload: { checkRunId: row.id, assetId: asset.id, brandId, rulesetHash: compiled.hash },
        idempotencyKey: `check.started:${row.id}`,
      });

      return row;
    });

    if (input.async) {
      await this.queue.enqueue(
        QUEUES.analyzeAsset,
        { orgId, checkRunId: runRow.id, correlationId: options.correlationId ?? null },
        { singletonKey: `analyze:${runRow.id}` },
      );
      return { run: toSummary(runRow), created: true, status: 'queued' };
    }

    // Synchronous path. An agent in a generate → verify → fix loop cannot
    // poll, so it gets the completed run in the response body.
    await this.execute(orgId, runRow.id, { correlationId: options.correlationId });
    return { run: await this.detail(orgId, runRow.id), created: true, status: 'completed' };
  }

  /* ==================================================================== *
   * Execution — shared by the synchronous path and the worker.
   * ==================================================================== */
  async execute(orgId: string, checkRunId: string, options: { correlationId?: string } = {}): Promise<CheckRunRow> {
    const startedAt = Date.now();
    const run = await this.getRun(orgId, checkRunId);

    // At-least-once delivery means this handler WILL be invoked twice for the
    // same run. A completed run is left exactly as it is.
    if (run.status === 'completed' || run.status === 'degraded') return run;

    const asset = await this.assets.findRow(orgId, run.assetId);
    const compiled = run.rulesetId
      ? await this.compiler.loadRuleset(orgId, run.rulesetId)
      : await this.compiler.activeRuleset(orgId, run.brandId);
    if (!compiled) throw new NoActiveRulesetException(run.brandId);

    const resolved = this.compiler.resolveForContext(compiled, {
      market: asset.market,
      channel: asset.channel,
      assetType: asset.assetType,
      campaign: asset.campaignId,
    });

    await this.repo.runAs(orgId, undefined, (tx) =>
      tx.update(checkRuns).set({ status: 'running', startedAt: new Date() }).where(eq(checkRuns.id, checkRunId)),
    );

    try {
      const cached = await this.loadCachedTraces(orgId, asset.contentHash, compiled.hash, resolved);
      const toEvaluate = resolved.filter((r) => !cached.has(traceKeyFor(asset.contentHash, compiled.hash, r, this.config.judgeModelVersion)));

      let response: AnalyzeResponse | null = null;
      if (toEvaluate.length > 0) {
        response = await this.callEngine(orgId, run, asset, compiled.hash, toEvaluate, options.correlationId);
      }

      return await this.persistResults(orgId, run, asset, compiled, resolved, cached, response, startedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.runAs(orgId, undefined, async (tx) => {
        await tx
          .update(checkRuns)
          .set({ status: 'failed', error: message.slice(0, 4000), completedAt: new Date(), durationMs: Date.now() - startedAt })
          .where(eq(checkRuns.id, checkRunId));
        await this.outbox.emitIn(tx, {
          orgId,
          type: 'check.failed',
          aggregateType: 'check_run',
          aggregateId: checkRunId,
          payload: { checkRunId, assetId: run.assetId, error: message.slice(0, 500) },
          idempotencyKey: `check.failed:${checkRunId}`,
        });
      });
      throw err;
    }
  }

  private async callEngine(
    orgId: string,
    run: CheckRunRow,
    asset: AssetRow,
    rulesetHash: string,
    rulesToRun: CompiledRule[],
    correlationId?: string,
  ): Promise<AnalyzeResponse> {
    const brandContext = await this.contextBuilder.build(orgId, run.brandId, {
      market: asset.market,
      channel: asset.channel,
      assetType: asset.assetType,
      platform: asset.channel?.split('-')[0] ?? null,
      placement: asset.channel?.split('-').slice(1).join('-') || null,
    });

    // Precedents are per-rule and balanced pass/fail. Retrieval happens here,
    // in the control plane, because the engine is stateless and has no access
    // to the tenant's decision history.
    const precedents = (
      await Promise.all(
        rulesToRun
          .filter((r) => r.rubric && (r.rubric as { usePrecedents?: boolean }).usePrecedents !== false)
          .map((r) =>
            this.precedents.retrieveBalanced({
              orgId,
              brandId: run.brandId,
              ruleKey: r.key,
              k: this.config.env.JUDGE_PRECEDENT_K,
              resolveCropUri: (key) => this.storage.signedUrl(key, 3600).catch(() => null),
            }),
          ),
      )
    ).flat();

    const measurements = await this.loadMeasurements(orgId, asset.id);

    const request: AnalyzeRequest = {
      requestId: correlationId ?? randomUUID(),
      orgId,
      asset: {
        id: asset.id,
        kind: asset.kind,
        uri: /^https?:\/\//i.test(asset.storageKey)
          ? asset.storageKey
          : await this.storage.engineUri(asset.storageKey),
        mimeType: asset.mimeType ?? undefined,
        contentHash: asset.contentHash,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        dpi: asset.dpi ?? undefined,
        colorProfile: asset.colorProfile ?? undefined,
        structuredSource: asset.structuredSource ?? undefined,
        copyFields: asset.copyFields ?? {},
        market: asset.market ?? undefined,
        channel: asset.channel ?? undefined,
        assetType: asset.assetType ?? undefined,
        locale: asset.locale ?? undefined,
      },
      brand: brandContext,
      rules: this.compiler.toRuleDefinitions(rulesToRun),
      precedents: precedents.map((p) => ({
        assetId: p.assetId,
        ruleKey: p.ruleKey,
        verdict: p.verdict,
        rationale: p.rationale,
        measured: p.measured,
        cropUri: p.cropUri,
        similarity: p.similarity,
      })),
      judge: {
        provider: this.config.env.LLM_JUDGE_PROVIDER,
        model: this.config.env.LLM_JUDGE_MODEL,
        temperature: this.config.env.JUDGE_TEMPERATURE,
        selfConsistencyK: this.config.env.JUDGE_SELF_CONSISTENCY_K,
        escalateK: this.config.env.JUDGE_SELF_CONSISTENCY_ESCALATE_K,
        abstainBelowConfidence: this.config.env.JUDGE_ABSTAIN_CONFIDENCE,
        maxImageEdge: this.config.env.JUDGE_MAX_IMAGE_EDGE,
        enablePromptCache: this.config.env.JUDGE_ENABLE_PROMPT_CACHE,
        costCeilingUsd: this.config.env.COST_JOB_USD_LIMIT,
      },
      // Measurement is a pure function of the bytes; replaying it costs nothing
      // and saves the engine from redoing OCR on every re-check.
      cachedMeasurements: measurements,
      deterministicOnly: rulesToRun.every((r) => r.tier === 'deterministic'),
      pipelineVersion: PIPELINE_VERSION,
    };

    void rulesetHash;
    return this.engine.analyze(request, { correlationId });
  }

  /* ==================================================================== *
   * Persistence: traces → findings → score.
   * ==================================================================== */
  private async persistResults(
    orgId: string,
    run: CheckRunRow,
    asset: AssetRow,
    compiled: { hash: string; scoringConfig: Parameters<ScoringService['score']>[1] },
    resolved: CompiledRule[],
    cached: Map<string, typeof decisionTraces.$inferSelect>,
    response: AnalyzeResponse | null,
    startedAt: number,
  ): Promise<CheckRunRow> {
    const byKey = new Map(resolved.map((r) => [`${r.key}@${r.version}`, r]));
    const results: EngineCriterionResult[] = response?.results ?? [];

    return this.repo.runAs(orgId, undefined, async (tx) => {
      const criteria: ScorableCriterion[] = [];
      let cacheHits = 0;
      let cacheMisses = 0;
      let costUsd = 0;

      // Replayed traces first: they are already persisted for a previous run,
      // so we re-record them against this run to keep each run self-contained.
      for (const [, trace] of cached) {
        const rule = byKey.get(`${trace.ruleKey}@${trace.ruleVersion}`);
        if (!rule) continue;
        cacheHits += 1;
        const inserted = await this.insertTrace(tx, {
          orgId,
          run,
          asset,
          rulesetHash: compiled.hash,
          rule,
          result: {
            ruleKey: trace.ruleKey,
            ruleVersion: trace.ruleVersion,
            dimension: trace.dimension as EngineCriterionResult['dimension'],
            tier: trace.tier,
            verdict: trace.verdict,
            severity: trace.severity,
            confidence: trace.confidence,
            evidence: trace.evidence ?? {},
            suggestedFix: trace.suggestedFix,
            model: trace.model,
            costUsd: 0,
            latencyMs: 0,
            cached: true,
          },
          precedentAssetIds: trace.precedentAssetIds,
          cachedFlag: true,
        });
        criteria.push({
          ruleKey: trace.ruleKey,
          dimension: trace.dimension,
          severity: trace.severity,
          verdict: trace.verdict,
          weight: rule.weight,
        });
        await this.maybeCreateFinding(tx, orgId, run, asset, rule, inserted);
      }

      for (const result of results) {
        const rule = byKey.get(`${result.ruleKey}@${result.ruleVersion}`) ?? resolved.find((r) => r.key === result.ruleKey);
        if (!rule) continue;
        if (result.cached) cacheHits += 1;
        else cacheMisses += 1;
        costUsd += result.costUsd ?? 0;

        const inserted = await this.insertTrace(tx, {
          orgId,
          run,
          asset,
          rulesetHash: compiled.hash,
          rule,
          result,
          precedentAssetIds: null,
          cachedFlag: Boolean(result.cached),
        });

        criteria.push({
          ruleKey: result.ruleKey,
          dimension: result.dimension,
          severity: result.severity,
          verdict: result.verdict,
          weight: rule.weight,
        });

        await this.maybeCreateFinding(tx, orgId, run, asset, rule, inserted);
      }

      // Reusable measurements are persisted so the next check on these bytes —
      // even under a different ruleset — skips the CV work entirely.
      if (response?.measurements) {
        for (const [analyzer, value] of Object.entries(response.measurements)) {
          await tx
            .insert(assetMeasurements)
            .values({
              orgId,
              assetId: asset.id,
              analyzer: analyzer.slice(0, 80),
              analyzerVersion: response.engineVersion.slice(0, 40),
              result: (value ?? {}) as Record<string, unknown>,
            })
            .onConflictDoNothing();
        }
      }

      const score = this.scoring.score(criteria, compiled.scoringConfig);
      const degraded = Boolean(response?.degraded);

      if (costUsd > 0) {
        await tx.insert(costLedger).values({
          orgId,
          checkRunId: run.id,
          provider: this.config.env.LLM_JUDGE_PROVIDER,
          model: this.config.env.LLM_JUDGE_MODEL,
          operation: 'analyze',
          costUsd: String(costUsd),
          cacheHit: cacheHits > cacheMisses,
          latencyMs: String(Date.now() - startedAt),
        });
      }

      const [updated] = await tx
        .update(checkRuns)
        .set({
          status: degraded ? 'degraded' : 'completed',
          score: score.score,
          scoreBand: score.scoreBand,
          hasBlocker: score.hasBlocker,
          dimensionScores: score.dimensionScores,
          criteriaTotal: score.criteriaTotal,
          criteriaEvaluated: score.criteriaEvaluated,
          criteriaPassed: score.criteriaPassed,
          criteriaFailed: score.criteriaFailed,
          criteriaAbstained: score.criteriaAbstained,
          coverageRate: score.coverageRate,
          cacheHits,
          cacheMisses,
          costUsd,
          durationMs: Date.now() - startedAt,
          degradedReason: response?.degradedReason ?? null,
          completedAt: new Date(),
        })
        .where(eq(checkRuns.id, run.id))
        .returning();

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'check.completed',
        aggregateType: 'check_run',
        aggregateId: run.id,
        payload: {
          checkRunId: run.id,
          assetId: asset.id,
          brandId: run.brandId,
          score: score.score,
          scoreBand: score.scoreBand,
          hasBlocker: score.hasBlocker,
          blockingRuleKeys: score.blockingRuleKeys,
          coverageRate: score.coverageRate,
          rulesetHash: compiled.hash,
        },
        idempotencyKey: `check.completed:${run.id}`,
      });

      await tx
        .update(assets)
        .set({ status: 'analyzed', updatedAt: new Date() })
        .where(eq(assets.id, asset.id));

      return updated;
    });
  }

  private async insertTrace(
    tx: Database,
    args: {
      orgId: string;
      run: CheckRunRow;
      asset: AssetRow;
      rulesetHash: string;
      rule: CompiledRule;
      result: EngineCriterionResult;
      precedentAssetIds: string[] | null;
      cachedFlag: boolean;
    },
  ): Promise<typeof decisionTraces.$inferSelect> {
    const { orgId, run, asset, rulesetHash, rule, result } = args;

    const [row] = await tx
      .insert(decisionTraces)
      .values({
        orgId,
        checkRunId: run.id,
        assetId: asset.id,
        traceKey: traceKeyFor(asset.contentHash, rulesetHash, rule, this.config.judgeModelVersion),
        assetContentHash: asset.contentHash,
        rulesetHash,
        ruleId: rule.id,
        ruleKey: result.ruleKey,
        ruleVersion: result.ruleVersion,
        dimension: result.dimension,
        tier: result.tier,
        verdict: result.verdict,
        severity: result.severity,
        confidence: result.confidence,
        model: result.model ?? null,
        // "Why did this fail" has to be answerable from this row alone:
        // measured vs threshold, the citation to the brand book, and the
        // precedents that informed the judgement.
        evidence: result.evidence ?? {},
        precedentAssetIds: args.precedentAssetIds,
        citation: rule.citation ?? null,
        suggestedFix: result.suggestedFix ?? null,
        cached: args.cachedFlag,
        costUsd: result.costUsd ?? 0,
        latencyMs: result.latencyMs ?? null,
      })
      .returning();
    return row;
  }

  /**
   * A finding is a failed or abstained trace surfaced to a human.
   *
   * `isHighConfidence` gates the default view. A reviewer who is shown three
   * bogus flags stops reading the fourth forever, so low-confidence results are
   * recorded but folded away rather than dropped.
   */
  private async maybeCreateFinding(
    tx: Database,
    orgId: string,
    run: CheckRunRow,
    asset: AssetRow,
    rule: CompiledRule,
    trace: typeof decisionTraces.$inferSelect,
  ): Promise<void> {
    const surfaces = trace.verdict === 'fail' || trace.verdict === 'abstained' || trace.verdict === 'insufficient_evidence';
    if (!surfaces) return;

    const evidence = trace.evidence ?? {};
    const displayConfidence = trace.confidence;
    const isHighConfidence =
      trace.tier === 'deterministic' ||
      (displayConfidence ?? 0) >= this.config.env.JUDGE_ABSTAIN_CONFIDENCE;

    const [finding] = await tx
      .insert(findings)
      .values({
        orgId,
        checkRunId: run.id,
        traceId: trace.id,
        assetId: asset.id,
        ruleKey: trace.ruleKey,
        dimension: trace.dimension,
        severity: trace.severity,
        title: rule.statement.slice(0, 400),
        detail: buildFindingDetail(evidence, trace.suggestedFix),
        status: 'open',
        displayConfidence,
        isHighConfidence,
        bbox: evidence.bbox ? [...evidence.bbox] : null,
        cropKey: evidence.cropKey ?? null,
      })
      .returning({ id: findings.id });

    await this.outbox.emitIn(tx, {
      orgId,
      type: 'finding.created',
      aggregateType: 'finding',
      aggregateId: finding.id,
      payload: {
        findingId: finding.id,
        checkRunId: run.id,
        assetId: asset.id,
        ruleKey: trace.ruleKey,
        severity: trace.severity,
        verdict: trace.verdict,
      },
      idempotencyKey: `finding.created:${finding.id}`,
    });
  }

  /* ==================================================================== *
   * Reads
   * ==================================================================== */
  async list(orgId: string, query: z.infer<typeof ListChecksQuery>): Promise<PageResult<CheckRunSummary>> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const conditions = [eq(checkRuns.orgId, orgId)];
      if (query.brandId) conditions.push(eq(checkRuns.brandId, query.brandId));
      if (query.assetId) conditions.push(eq(checkRuns.assetId, query.assetId));
      if (query.status) conditions.push(eq(checkRuns.status, query.status as CheckRunRow['status']));
      if (query.scoreBand) conditions.push(eq(checkRuns.scoreBand, query.scoreBand));
      if (query.from) conditions.push(gte(checkRuns.createdAt, new Date(query.from)));
      if (query.to) conditions.push(lte(checkRuns.createdAt, new Date(query.to)));

      const rows = await tx
        .select()
        .from(checkRuns)
        .where(and(...conditions))
        .orderBy(desc(checkRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query));

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(checkRuns)
        .where(and(...conditions));

      return paginate(rows.map(toSummary), n ?? 0, query);
    });
  }

  async getRun(orgId: string, checkRunId: string): Promise<CheckRunRow> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(checkRuns)
        .where(and(eq(checkRuns.id, checkRunId), eq(checkRuns.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Check run ${checkRunId} not found`);
    return rows[0];
  }

  async detail(orgId: string, checkRunId: string): Promise<CheckRunDetail> {
    const run = await this.getRun(orgId, checkRunId);
    const { traces, findingRows, asset } = await this.repo.runAs(orgId, undefined, async (tx) => {
      const traces = await tx
        .select()
        .from(decisionTraces)
        .where(eq(decisionTraces.checkRunId, checkRunId))
        .orderBy(decisionTraces.dimension, decisionTraces.ruleKey);
      const findingRows = await tx
        .select()
        .from(findings)
        .where(eq(findings.checkRunId, checkRunId))
        .orderBy(findings.severity, findings.createdAt);
      const [asset] = await tx.select().from(assets).where(eq(assets.id, run.assetId)).limit(1);
      return { traces, findingRows, asset };
    });

    return {
      ...toSummary(run),
      traces: traces.map((t) => ({
        id: t.id,
        traceKey: t.traceKey,
        ruleKey: t.ruleKey,
        ruleVersion: t.ruleVersion,
        dimension: t.dimension as CheckRunDetail['traces'][number]['dimension'],
        tier: t.tier,
        verdict: t.verdict,
        severity: t.severity,
        confidence: t.confidence,
        evidence: t.evidence ?? {},
        model: t.model ?? null,
        citation: t.citation ?? null,
        precedentAssetIds: t.precedentAssetIds ?? null,
        suggestedFix: t.suggestedFix,
        cached: t.cached,
        costUsd: t.costUsd,
        latencyMs: t.latencyMs,
        createdAt: t.createdAt.toISOString(),
      })),
      findings: findingRows.map((f) => ({
        id: f.id,
        traceId: f.traceId,
        ruleKey: f.ruleKey,
        dimension: f.dimension as CheckRunDetail['findings'][number]['dimension'],
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        status: f.status,
        bbox: f.bbox ?? null,
        cropKey: f.cropKey,
        displayConfidence: f.displayConfidence,
        isHighConfidence: f.isHighConfidence,
        createdAt: f.createdAt.toISOString(),
      })),
      asset: asset
        ? {
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            width: asset.width,
            height: asset.height,
            previewUrl: await this.assets.previewUrl(orgId, asset).catch(() => null),
          }
        : undefined,
    };
  }

  async traces(orgId: string, checkRunId: string) {
    await this.getRun(orgId, checkRunId);
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(decisionTraces).where(eq(decisionTraces.checkRunId, checkRunId)).orderBy(decisionTraces.ruleKey),
    );
  }

  /** Re-runs a check, bypassing the result cache. */
  async rerun(orgId: string, userId: string | undefined, checkRunId: string, async = true): Promise<CreateCheckResult> {
    const run = await this.getRun(orgId, checkRunId);
    return this.create(
      orgId,
      userId,
      {
        assetId: run.assetId,
        brandId: run.brandId,
        deterministicOnly: false,
        async,
        force: true,
      } as z.infer<typeof CreateCheckInput>,
      { triggeredBy: 'ui' },
    );
  }

  /* ==================================================================== *
   * Helpers
   * ==================================================================== */
  private async resolveAsset(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof CreateCheckInput>,
  ): Promise<AssetRow> {
    if (input.assetId) return this.assets.findRow(orgId, input.assetId);
    if (input.asset) {
      // Register-and-check in one call: the agent loop should not need two
      // round trips to verify the thing it just generated.
      const dto = await this.assets.registerCopy(orgId, userId, input.asset);
      return this.assets.findRow(orgId, dto.id);
    }
    throw new BadRequestException('Provide either `assetId` or an inline `asset`');
  }

  private async findByJobKey(orgId: string, jobKey: string): Promise<CheckRunRow | null> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(checkRuns)
        .where(and(eq(checkRuns.orgId, orgId), eq(checkRuns.jobKey, jobKey)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** Per-criterion replay: unchanged rules keep their previous paid verdict. */
  private async loadCachedTraces(
    orgId: string,
    assetContentHash: string,
    rulesetHash: string,
    resolved: CompiledRule[],
  ): Promise<Map<string, typeof decisionTraces.$inferSelect>> {
    const keys = resolved.map((r) => traceKeyFor(assetContentHash, rulesetHash, r, this.config.judgeModelVersion));
    if (keys.length === 0) return new Map();

    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(decisionTraces)
        .where(and(eq(decisionTraces.orgId, orgId), inArray(decisionTraces.traceKey, keys)))
        .orderBy(desc(decisionTraces.createdAt)),
    );

    const out = new Map<string, typeof decisionTraces.$inferSelect>();
    for (const row of rows) if (!out.has(row.traceKey)) out.set(row.traceKey, row);
    return out;
  }

  private async loadMeasurements(orgId: string, assetId: string): Promise<Record<string, unknown>> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({ analyzer: assetMeasurements.analyzer, result: assetMeasurements.result })
        .from(assetMeasurements)
        .where(eq(assetMeasurements.assetId, assetId)),
    );
    return Object.fromEntries(rows.map((r) => [r.analyzer, r.result]));
  }

  /** Prompt identity across the resolved set — part of the job key. */
  private promptHashFor(rules: CompiledRule[]): string {
    return promptHash(
      'brandlens.judge.v1',
      Object.fromEntries(rules.map((r) => [r.key, r.optimizedPromptHash ?? r.rubric ?? null])),
    );
  }
}

function traceKeyFor(assetContentHash: string, rulesetHash: string, rule: CompiledRule, modelVersion: string): string {
  return computeTraceKey({
    assetContentHash,
    rulesetHash,
    ruleKey: rule.key,
    ruleVersion: rule.version,
    modelVersion,
    promptHash: rule.optimizedPromptHash ?? 'default',
  });
}

export function toSummary(row: CheckRunRow): CheckRunSummary {
  return {
    id: row.id,
    assetId: row.assetId,
    brandId: row.brandId,
    status: row.status,
    score: row.score,
    scoreBand: (row.scoreBand as CheckRunSummary['scoreBand']) ?? null,
    hasBlocker: row.hasBlocker,
    dimensionScores: row.dimensionScores,
    criteriaTotal: row.criteriaTotal,
    criteriaEvaluated: row.criteriaEvaluated,
    criteriaPassed: row.criteriaPassed,
    criteriaFailed: row.criteriaFailed,
    criteriaAbstained: row.criteriaAbstained,
    coverageRate: row.coverageRate,
    rulesetHash: row.rulesetHash,
    costUsd: row.costUsd,
    cacheHits: row.cacheHits,
    cacheMisses: row.cacheMisses,
    durationMs: row.durationMs,
    degradedReason: row.degradedReason,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
