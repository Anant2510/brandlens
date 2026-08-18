import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@brandlens/db';
import {
  assetMeasurements,
  assets,
  brands,
  checkRuns,
  costLedger,
  decisionTraces,
  findings,
  precedents,
  rules,
  rulesets,
} from '@brandlens/db';
import type { AnalyzeRequest, AnalyzeResponse, EngineCriterionResult } from '@brandlens/contracts';
import { PIPELINE_VERSION, traceKey as computeTraceKey } from '@brandlens/api/common/hash';
import {
  DEFAULT_SCORING,
  resolveForContext,
  toRuleDefinitions,
  type CompiledRule,
  type CompiledRuleset,
  type ScoringConfig,
} from '@brandlens/api/rulesets/compile';
import { scoreCriteria, type ScorableCriterion } from '@brandlens/api/scoring/scoring';
import { buildFindingDetail } from '@brandlens/api/checks/finding-detail';
import { env } from '../config';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { buildBrandContext } from '../services/brand-context';

export interface AnalyzeAssetJob {
  orgId: string;
  checkRunId: string;
  correlationId?: string | null;
}

const JUDGE_MODEL_VERSION = `${env.LLM_JUDGE_PROVIDER}:${env.LLM_JUDGE_MODEL}`;

/**
 * `analyze.asset` — build context → call engine → persist traces + findings →
 * score → emit `check.completed`.
 *
 * IDEMPOTENT: a run that already reached `completed` or `degraded` returns
 * immediately. That matters more here than anywhere else in the system,
 * because a duplicate delivery would otherwise re-purchase every VLM call in
 * the run.
 */
export async function analyzeAsset(job: AnalyzeAssetJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'analyze.asset', checkRunId: job.checkRunId });
  const startedAt = Date.now();

  const loaded = await ctx.withTenant(job.orgId, async (tx) => {
    const [run] = await tx.select().from(checkRuns).where(eq(checkRuns.id, job.checkRunId)).limit(1);
    if (!run) return null;
    const [asset] = await tx.select().from(assets).where(eq(assets.id, run.assetId)).limit(1);
    const compiled = await loadCompiledRuleset(tx, run.rulesetId, run.brandId, job.orgId);
    return { run, asset, compiled };
  });

  if (!loaded?.run) {
    log.warn('check run disappeared; nothing to analyse');
    return;
  }
  const { run, asset, compiled } = loaded;

  if (run.status === 'completed' || run.status === 'degraded') {
    log.debug({ status: run.status }, 'run already finished — idempotent no-op');
    return;
  }
  if (!asset) throw new Error(`Asset ${run.assetId} not found for check run ${run.id}`);
  if (!compiled) throw new Error(`No ruleset available for brand ${run.brandId}`);

  await ctx.withTenant(job.orgId, (tx) =>
    tx.update(checkRuns).set({ status: 'running', startedAt: new Date() }).where(eq(checkRuns.id, run.id)),
  );

  try {
    const resolved = resolveForContext(compiled, {
      market: asset.market,
      channel: asset.channel,
      assetType: asset.assetType,
      campaign: asset.campaignId,
    });

    if (resolved.length === 0) {
      await finishEmpty(job.orgId, run.id, compiled.hash, startedAt);
      return;
    }

    // Per-criterion cache: editing one rule changes the ruleset hash (and so
    // the job key), but every OTHER rule's trace key is unchanged, so their
    // expensive verdicts are replayed instead of re-purchased.
    const cached = await loadCachedTraces(job.orgId, asset.contentHash, compiled.hash, resolved);
    const toEvaluate = resolved.filter((r) => !cached.has(traceKeyFor(asset.contentHash, compiled.hash, r)));

    let response: AnalyzeResponse | null = null;
    if (toEvaluate.length > 0) {
      response = await callEngine(job, run.brandId, asset, compiled, toEvaluate);
    }

    await persist(job, run, asset, compiled, resolved, cached, response, startedAt);
    log.info({ evaluated: toEvaluate.length, replayed: cached.size }, 'analysis complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.withTenant(job.orgId, async (tx) => {
      await tx
        .update(checkRuns)
        .set({
          status: 'failed',
          error: message.slice(0, 4000),
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(checkRuns.id, run.id));
      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'check.failed',
        aggregateType: 'check_run',
        aggregateId: run.id,
        payload: { checkRunId: run.id, assetId: run.assetId, error: message.slice(0, 500) },
        idempotencyKey: `check.failed:${run.id}`,
      });
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ engine */

async function callEngine(
  job: AnalyzeAssetJob,
  brandId: string,
  asset: typeof assets.$inferSelect,
  compiled: CompiledRuleset,
  rulesToRun: CompiledRule[],
): Promise<AnalyzeResponse> {
  const ctx = getContext();

  const { brandContext, precedentRows, measurements } = await ctx.withTenant(job.orgId, async (tx) => {
    const brandContext = await buildBrandContext(tx, ctx.storage, brandId, {
      market: asset.market,
      channel: asset.channel,
      assetType: asset.assetType,
      platform: asset.channel?.split('-')[0] ?? null,
      placement: asset.channel?.split('-').slice(1).join('-') || null,
    });

    const ruleKeys = rulesToRun.map((r) => r.key);
    const precedentRows = ruleKeys.length
      ? await tx
          .select()
          .from(precedents)
          .where(and(eq(precedents.brandId, brandId), inArray(precedents.ruleKey, ruleKeys)))
          .orderBy(desc(precedents.createdAt))
          .limit(500)
      : [];

    const measurementRows = await tx
      .select({ analyzer: assetMeasurements.analyzer, result: assetMeasurements.result })
      .from(assetMeasurements)
      .where(eq(assetMeasurements.assetId, asset.id));

    return {
      brandContext,
      precedentRows,
      measurements: Object.fromEntries(measurementRows.map((m) => [m.analyzer, m.result])),
    };
  });

  const request: AnalyzeRequest = {
    requestId: job.correlationId ?? randomUUID(),
    orgId: job.orgId,
    asset: {
      id: asset.id,
      kind: asset.kind,
      uri: ctx.storage.engineUri(asset.storageKey),
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
    rules: toRuleDefinitions(rulesToRun),
    precedents: balancePrecedents(precedentRows, env.JUDGE_PRECEDENT_K).map((p) => ({
      assetId: p.assetId,
      ruleKey: p.ruleKey,
      verdict: p.verdict,
      rationale: p.rationale,
      measured: p.measured,
      cropUri: p.cropKey ? ctx.storage.signedUrl(p.cropKey, 3_600) : null,
    })),
    judge: {
      provider: env.LLM_JUDGE_PROVIDER,
      model: env.LLM_JUDGE_MODEL,
      temperature: env.JUDGE_TEMPERATURE,
      selfConsistencyK: env.JUDGE_SELF_CONSISTENCY_K,
      escalateK: env.JUDGE_SELF_CONSISTENCY_ESCALATE_K,
      abstainBelowConfidence: env.JUDGE_ABSTAIN_CONFIDENCE,
      maxImageEdge: env.JUDGE_MAX_IMAGE_EDGE,
      enablePromptCache: env.JUDGE_ENABLE_PROMPT_CACHE,
      costCeilingUsd: env.COST_JOB_USD_LIMIT,
    },
    // Measurement is a pure function of the bytes; replaying it costs nothing
    // and saves the engine from redoing OCR on every re-check.
    cachedMeasurements: measurements,
    deterministicOnly: rulesToRun.every((r) => r.tier === 'deterministic'),
    pipelineVersion: PIPELINE_VERSION,
  };

  void compiled;
  return ctx.engine.analyze(request, job.correlationId ?? undefined);
}

/**
 * Balanced k/2 pass + k/2 fail precedents PER RULE.
 *
 * Most assets are fine, so a tenant's history for a rule is typically 90%
 * pass. Feeding that distribution to the judge leaks the label prior through
 * the examples and turns it into a yes-machine that agrees with whatever it is
 * shown. Forcing an even split removes the prior from the context window.
 */
function balancePrecedents(rows: Array<typeof precedents.$inferSelect>, k: number): Array<typeof precedents.$inferSelect> {
  const half = Math.max(1, Math.floor(k / 2));
  const byRule = new Map<string, Array<typeof precedents.$inferSelect>>();
  for (const row of rows) {
    const bucket = byRule.get(row.ruleKey) ?? [];
    bucket.push(row);
    byRule.set(row.ruleKey, bucket);
  }

  const out: Array<typeof precedents.$inferSelect> = [];
  for (const bucket of byRule.values()) {
    out.push(...bucket.filter((r) => r.verdict === 'pass').slice(0, half));
    out.push(...bucket.filter((r) => r.verdict === 'fail').slice(0, half));
  }
  return out;
}

/* -------------------------------------------------------------- persistence */

async function persist(
  job: AnalyzeAssetJob,
  run: typeof checkRuns.$inferSelect,
  asset: typeof assets.$inferSelect,
  compiled: CompiledRuleset,
  resolved: CompiledRule[],
  cached: Map<string, typeof decisionTraces.$inferSelect>,
  response: AnalyzeResponse | null,
  startedAt: number,
): Promise<void> {
  const ctx = getContext();
  const byKey = new Map(resolved.map((r) => [`${r.key}@${r.version}`, r]));

  await ctx.withTenant(job.orgId, async (tx) => {
    const criteria: ScorableCriterion[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    let costUsd = 0;

    for (const trace of cached.values()) {
      const rule = byKey.get(`${trace.ruleKey}@${trace.ruleVersion}`);
      if (!rule) continue;
      cacheHits += 1;
      const inserted = await insertTrace(tx, job.orgId, run, asset, compiled.hash, rule, {
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
        cached: true,
      }, trace.precedentAssetIds);
      criteria.push({
        ruleKey: trace.ruleKey,
        dimension: trace.dimension,
        severity: trace.severity,
        verdict: trace.verdict,
        weight: rule.weight,
      });
      await maybeCreateFinding(tx, job.orgId, run, asset, rule, inserted);
    }

    for (const result of response?.results ?? []) {
      const rule = byKey.get(`${result.ruleKey}@${result.ruleVersion}`) ?? resolved.find((r) => r.key === result.ruleKey);
      if (!rule) continue;
      if (result.cached) cacheHits += 1;
      else cacheMisses += 1;
      costUsd += result.costUsd ?? 0;

      const inserted = await insertTrace(tx, job.orgId, run, asset, compiled.hash, rule, result, null);
      criteria.push({
        ruleKey: result.ruleKey,
        dimension: result.dimension,
        severity: result.severity,
        verdict: result.verdict,
        weight: rule.weight,
      });
      await maybeCreateFinding(tx, job.orgId, run, asset, rule, inserted);
    }

    // Reusable measurements: the next check on these bytes — even under a
    // different ruleset — skips the CV work entirely.
    for (const [analyzer, value] of Object.entries(response?.measurements ?? {})) {
      await tx
        .insert(assetMeasurements)
        .values({
          orgId: job.orgId,
          assetId: asset.id,
          analyzer: analyzer.slice(0, 80),
          analyzerVersion: (response?.engineVersion ?? 'unknown').slice(0, 40),
          result: (value ?? {}) as Record<string, unknown>,
        })
        .onConflictDoNothing();
    }

    const scoringConfig: ScoringConfig = compiled.scoringConfig ?? DEFAULT_SCORING;
    const score = scoreCriteria(criteria, scoringConfig);
    const degraded = Boolean(response?.degraded);

    if (costUsd > 0) {
      await tx.insert(costLedger).values({
        orgId: job.orgId,
        checkRunId: run.id,
        provider: env.LLM_JUDGE_PROVIDER,
        model: env.LLM_JUDGE_MODEL,
        operation: 'analyze',
        costUsd: String(costUsd),
        cacheHit: cacheHits > cacheMisses,
        latencyMs: String(Date.now() - startedAt),
      });
    }

    await tx
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
      .where(eq(checkRuns.id, run.id));

    await tx.update(assets).set({ status: 'analyzed', updatedAt: new Date() }).where(eq(assets.id, asset.id));

    await emitEvent(tx, {
      orgId: job.orgId,
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
        costUsd,
      },
      idempotencyKey: `check.completed:${run.id}`,
    });
  });
}

async function insertTrace(
  tx: Database,
  orgId: string,
  run: typeof checkRuns.$inferSelect,
  asset: typeof assets.$inferSelect,
  rulesetHash: string,
  rule: CompiledRule,
  result: Pick<
    EngineCriterionResult,
    'ruleKey' | 'ruleVersion' | 'dimension' | 'tier' | 'verdict' | 'severity' | 'confidence' | 'evidence'
  > &
    Partial<EngineCriterionResult>,
  precedentAssetIds: string[] | null,
): Promise<typeof decisionTraces.$inferSelect> {
  const [row] = await tx
    .insert(decisionTraces)
    .values({
      orgId,
      checkRunId: run.id,
      assetId: asset.id,
      traceKey: traceKeyFor(asset.contentHash, rulesetHash, rule),
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
      // "Why did this fail" must be answerable from this row alone: measured
      // vs threshold, the citation to the brand book, and the precedents that
      // informed the judgement.
      evidence: result.evidence ?? {},
      precedentAssetIds,
      citation: rule.citation ?? null,
      suggestedFix: result.suggestedFix ?? null,
      cached: Boolean(result.cached),
      costUsd: result.costUsd ?? 0,
      latencyMs: result.latencyMs ?? null,
    })
    .returning();
  return row;
}

/**
 * A finding is a failed or abstained trace surfaced to a human.
 *
 * `isHighConfidence` gates the default view: a reviewer who is shown three
 * bogus flags stops reading the fourth forever, so low-confidence results are
 * recorded but folded away rather than dropped.
 */
async function maybeCreateFinding(
  tx: Database,
  orgId: string,
  run: typeof checkRuns.$inferSelect,
  asset: typeof assets.$inferSelect,
  rule: CompiledRule,
  trace: typeof decisionTraces.$inferSelect,
): Promise<void> {
  const surfaces =
    trace.verdict === 'fail' || trace.verdict === 'abstained' || trace.verdict === 'insufficient_evidence';
  if (!surfaces) return;

  const evidence = trace.evidence ?? {};
  const isHighConfidence =
    trace.tier === 'deterministic' || (trace.confidence ?? 0) >= env.JUDGE_ABSTAIN_CONFIDENCE;

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
      displayConfidence: trace.confidence,
      isHighConfidence,
      bbox: evidence.bbox ? [...evidence.bbox] : null,
      cropKey: evidence.cropKey ?? null,
    })
    .returning({ id: findings.id });

  await emitEvent(tx, {
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

/* ------------------------------------------------------------------ helpers */

async function loadCompiledRuleset(
  tx: Database,
  rulesetId: string | null,
  brandId: string,
  orgId: string,
): Promise<CompiledRuleset | null> {
  let id = rulesetId;
  if (!id) {
    const [brand] = await tx
      .select({ activeRulesetId: brands.activeRulesetId })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    id = brand?.activeRulesetId ?? null;
  }
  if (!id) return null;

  const [row] = await tx.select().from(rulesets).where(eq(rulesets.id, id)).limit(1);
  if (!row) return null;

  const compiled = row.compiled as unknown as { rules?: CompiledRule[]; scoringConfig?: ScoringConfig };
  void orgId;
  void rules;
  return {
    brandId: row.brandId,
    rules: compiled.rules ?? [],
    scoringConfig: { ...DEFAULT_SCORING, ...(compiled.scoringConfig ?? {}) },
    ruleCount: row.ruleCount,
    hash: row.hash,
  };
}

async function loadCachedTraces(
  orgId: string,
  assetContentHash: string,
  rulesetHash: string,
  resolved: CompiledRule[],
): Promise<Map<string, typeof decisionTraces.$inferSelect>> {
  const keys = resolved.map((r) => traceKeyFor(assetContentHash, rulesetHash, r));
  if (keys.length === 0) return new Map();

  const rows = await getContext().withTenant(orgId, (tx) =>
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

function traceKeyFor(assetContentHash: string, rulesetHash: string, rule: CompiledRule): string {
  return computeTraceKey({
    assetContentHash,
    rulesetHash,
    ruleKey: rule.key,
    ruleVersion: rule.version,
    modelVersion: JUDGE_MODEL_VERSION,
    promptHash: rule.optimizedPromptHash ?? 'default',
  });
}

async function finishEmpty(orgId: string, checkRunId: string, rulesetHash: string, startedAt: number): Promise<void> {
  await getContext().withTenant(orgId, async (tx) => {
    await tx
      .update(checkRuns)
      .set({
        status: 'completed',
        score: null,
        scoreBand: null,
        criteriaTotal: 0,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
        degradedReason: 'No active rules applied to this asset context',
      })
      .where(eq(checkRuns.id, checkRunId));
    await emitEvent(tx, {
      orgId,
      type: 'check.completed',
      aggregateType: 'check_run',
      aggregateId: checkRunId,
      payload: { checkRunId, score: null, scoreBand: null, hasBlocker: false, rulesetHash, ruleCount: 0 },
      idempotencyKey: `check.completed:${checkRunId}`,
    });
  });
}
