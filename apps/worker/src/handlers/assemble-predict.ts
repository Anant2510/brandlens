import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type Database,
  assemblyPlans,
  assets,
  audiencePanels,
  brands,
  briefs,
  channelSpecs,
  predictions,
  rulesets,
} from '@brandlens/db';
import type { CompiledRule, CompiledRuleset, ScoringConfig } from '@brandlens/api/rulesets/compile';
import { DEFAULT_SCORING, toRuleDefinitions } from '@brandlens/api/rulesets/compile';
import { env } from '../config';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { buildBrandContext } from '../services/brand-context';

export interface AssembleBriefJob {
  orgId: string;
  briefId: string;
  brandId: string;
  requestedByUserId?: string | null;
}

/**
 * `assemble.brief` — brief in, plan out.
 *
 * The plan records the `rulesetHash` it was built against, so a plan is
 * auditable in exactly the same way a check run is: you can prove which rules
 * the recommendation was designed to satisfy.
 *
 * IDEMPOTENT: a brief already in `ready` with a plan for the current ruleset
 * hash is left alone.
 */
export async function assembleBrief(job: AssembleBriefJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'assemble.brief', briefId: job.briefId });

  const loaded = await ctx.withTenant(job.orgId, async (tx) => {
    const [brief] = await tx.select().from(briefs).where(eq(briefs.id, job.briefId)).limit(1);
    if (!brief) return null;
    const compiled = await loadActiveRuleset(tx, job.brandId);
    const candidates = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.brandId, job.brandId), isNull(assets.deletedAt)))
      .orderBy(desc(assets.isApprovedExemplar), desc(assets.createdAt))
      .limit(120);
    const brandContext = await buildBrandContext(tx, ctx.storage, job.brandId);

    /*
     * A brief has MANY targets, and `buildBrandContext` resolves a spec for
     * one placement — so calling it without options, as this did, left
     * `channelSpec` null for every assemble run. The visible effect was that a
     * plan for an A4 print page came out byte-identical to one for a square
     * feed post: no dimensions, no aspect-ratio scoring, the same layout
     * boxes. It looked like a plan and discriminated nothing.
     */
    brandContext.channelSpec = await resolveTargetSpecs(tx, brief.targets ?? []);
    return { brief, compiled, candidates, brandContext };
  });

  if (!loaded) {
    log.warn('brief not found');
    return;
  }
  const { brief, compiled, candidates, brandContext } = loaded;

  const existingPlan = await ctx.withTenant(job.orgId, async (tx) => {
    const rows = await tx
      .select({ id: assemblyPlans.id, rulesetHash: assemblyPlans.rulesetHash })
      .from(assemblyPlans)
      .where(eq(assemblyPlans.briefId, job.briefId))
      .orderBy(desc(assemblyPlans.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });

  if (brief.status === 'ready' && existingPlan && compiled && existingPlan.rulesetHash === compiled.hash) {
    log.debug('plan already current for this ruleset — idempotent no-op');
    return;
  }

  try {
    const response = await ctx.engine.assemble({
      requestId: `assemble:${job.briefId}`,
      orgId: job.orgId,
      brand: brandContext,
      brief: {
        title: brief.title,
        objective: brief.objective,
        keyMessage: brief.keyMessage,
        audience: brief.audience ?? {},
        mandatories: brief.mandatories ?? [],
        // Translated, not passed through: the control plane stores a target as
        // platform + placement because that is how the spec registry is keyed,
        // and the engine reads `channel` because that is what a rule's scope
        // matches on. Handing the raw target over made every placement resolve
        // to the label `any:image` — so channel-scoped rules applied to none
        // of them and two different targets produced one identical plan.
        targets: (brief.targets ?? []).map((t) => withChannel(t as BriefTarget)),
      },
      candidateAssets: await Promise.all(
        candidates.map(async (a) => ({
          id: a.id,
          name: a.name,
          uri: ctx.storage.engineUri(a.storageKey),
          tags: a.tags ?? [],
          width: a.width,
          height: a.height,
          score: null,
        })),
      ),
      rules: toRuleDefinitions(compiled?.rules ?? []),
      provider: env.LLM_TEXT_PROVIDER,
      model: env.LLM_TEXT_MODEL,
    });

    await ctx.withTenant(job.orgId, async (tx) => {
      const [plan] = await tx
        .insert(assemblyPlans)
        .values({
          orgId: job.orgId,
          briefId: job.briefId,
          rulesetHash: compiled?.hash ?? 'none',
          items: response.items,
          constraintsApplied: response.constraintsApplied,
          rationale: response.rationale,
          costUsd: response.costUsd,
        })
        .returning({ id: assemblyPlans.id });

      await tx.update(briefs).set({ status: 'ready', updatedAt: new Date() }).where(eq(briefs.id, job.briefId));

      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'brief.assembled',
        aggregateType: 'brief',
        aggregateId: job.briefId,
        payload: { briefId: job.briefId, planId: plan.id, itemCount: response.items.length, costUsd: response.costUsd },
        idempotencyKey: `brief.assembled:${plan.id}`,
      });
    });

    log.info({ items: response.items.length }, 'brief assembled');
  } catch (err) {
    await ctx.withTenant(job.orgId, (tx) =>
      tx.update(briefs).set({ status: 'failed', updatedAt: new Date() }).where(eq(briefs.id, job.briefId)),
    );
    throw err;
  }
}

export interface PredictAssetJob {
  orgId: string;
  predictionId: string;
  assetId: string;
  brandId: string;
  panelId?: string | null;
}

/**
 * `predict.asset` — synthetic panel response, reported as a distribution.
 *
 * Always relative to the tenant's own corpus. VLM judges rank far better than
 * they score, so the useful output is "where does this sit against our last
 * fifty assets", never a bare absolute number.
 */
export async function predictAsset(job: PredictAssetJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'predict.asset', predictionId: job.predictionId });

  const loaded = await ctx.withTenant(job.orgId, async (tx) => {
    const [prediction] = await tx.select().from(predictions).where(eq(predictions.id, job.predictionId)).limit(1);
    if (!prediction) return null;
    const [asset] = await tx.select().from(assets).where(eq(assets.id, job.assetId)).limit(1);
    const panel = job.panelId
      ? (await tx.select().from(audiencePanels).where(eq(audiencePanels.id, job.panelId)).limit(1))[0]
      : (await tx.select().from(audiencePanels).where(eq(audiencePanels.brandId, job.brandId)).limit(1))[0];

    // Comparison set: the tenant's own approved work is the only meaningful
    // reference frame for "is this good".
    const comparisons = prediction.comparisonAssetIds?.length
      ? await tx.select().from(assets).where(eq(assets.brandId, job.brandId)).limit(50)
      : await tx
          .select()
          .from(assets)
          .where(and(eq(assets.brandId, job.brandId), eq(assets.isApprovedExemplar, true), isNull(assets.deletedAt)))
          .orderBy(desc(assets.createdAt))
          .limit(6);

    const brandContext = await buildBrandContext(tx, ctx.storage, job.brandId);
    return { prediction, asset, panel, comparisons, brandContext };
  });

  if (!loaded?.prediction) {
    log.warn('prediction not found');
    return;
  }
  const { prediction, asset, panel, comparisons, brandContext } = loaded;

  if (prediction.status === 'completed') {
    log.debug('prediction already completed — idempotent no-op');
    return;
  }
  if (!asset) throw new Error(`Asset ${job.assetId} not found`);

  await ctx.withTenant(job.orgId, (tx) =>
    tx.update(predictions).set({ status: 'running' }).where(eq(predictions.id, job.predictionId)),
  );

  try {
    const response = await ctx.engine.predict({
      requestId: `predict:${job.predictionId}`,
      orgId: job.orgId,
      asset: {
        id: asset.id,
        kind: asset.kind,
        uri: ctx.storage.engineUri(asset.storageKey),
        mimeType: asset.mimeType ?? undefined,
        contentHash: asset.contentHash,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        copyFields: asset.copyFields ?? {},
        market: asset.market ?? undefined,
        channel: asset.channel ?? undefined,
      },
      brand: brandContext,
      personas: panel?.personas ?? [],
      comparisonAssets: comparisons
        .filter((c) => c.id !== asset.id)
        .map((c) => ({ id: c.id, uri: ctx.storage.engineUri(c.storageKey), label: c.name })),
      provider: env.LLM_JUDGE_PROVIDER,
      model: env.LLM_JUDGE_MODEL,
    });

    await ctx.withTenant(job.orgId, async (tx) => {
      await tx
        .update(predictions)
        .set({
          status: 'completed',
          percentileVsCorpus: response.percentileVsCorpus,
          dimensionScores: response.dimensionScores,
          // Always an interval, never a bare point estimate.
          intervalLow: response.intervalLow,
          intervalHigh: response.intervalHigh,
          panelResponses: response.panelResponses,
          recommendations: response.recommendations,
          costUsd: response.costUsd,
          error: null,
          completedAt: new Date(),
        })
        .where(eq(predictions.id, job.predictionId));

      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'prediction.completed',
        aggregateType: 'prediction',
        aggregateId: job.predictionId,
        payload: {
          predictionId: job.predictionId,
          assetId: job.assetId,
          percentileVsCorpus: response.percentileVsCorpus,
          intervalLow: response.intervalLow,
          intervalHigh: response.intervalHigh,
        },
        idempotencyKey: `prediction.completed:${job.predictionId}`,
      });
    });

    log.info({ percentile: response.percentileVsCorpus }, 'prediction complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(predictions)
        .set({ status: 'failed', error: message.slice(0, 2000), completedAt: new Date() })
        .where(eq(predictions.id, job.predictionId)),
    );
    throw err;
  }
}

async function loadActiveRuleset(
  tx: Parameters<typeof buildBrandContext>[0],
  brandId: string,
): Promise<CompiledRuleset | null> {
  const [brand] = await tx
    .select({ activeRulesetId: brands.activeRulesetId })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!brand?.activeRulesetId) return null;

  const [row] = await tx.select().from(rulesets).where(eq(rulesets.id, brand.activeRulesetId)).limit(1);
  if (!row) return null;

  const compiled = row.compiled as unknown as { rules?: CompiledRule[]; scoringConfig?: ScoringConfig };
  return {
    brandId: row.brandId,
    rules: compiled.rules ?? [],
    scoringConfig: { ...DEFAULT_SCORING, ...(compiled.scoringConfig ?? {}) },
    ruleCount: row.ruleCount,
    hash: row.hash,
  };
}


/* ==========================================================================
 * Brief targets, and the two vocabularies they sit between.
 *
 * A target is stored as `platform` + `placement` because that is how the
 * channel-spec registry is keyed and how the platforms publish their specs. A
 * rule is scoped by `channel` because that is how a brand describes where its
 * creative runs. The two mostly compose — meta/feed is `meta-feed` — and
 * five of the fifteen shipped placements do not, so the mapping is a column
 * on `channel_specs` rather than string concatenation.
 * ========================================================================== */

export interface BriefTarget {
  platform?: string | null;
  placement?: string | null;
  assetType?: string | null;
  channel?: string | null;
  market?: string | null;
  count?: number | null;
}

/** Cached per assemble run — a brief with six targets need not query six times. */
let channelByPlacement: Map<string, string> | null = null;

async function loadChannelIndex(tx: Database): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      platform: channelSpecs.platform,
      placement: channelSpecs.placement,
      assetType: channelSpecs.assetType,
      channel: channelSpecs.channel,
    })
    .from(channelSpecs);

  const index = new Map<string, string>();
  for (const row of rows) {
    if (!row.channel) continue;
    index.set(`${row.platform}/${row.placement}/${row.assetType}`, row.channel);
    // Also without the asset type: a brief may target a placement whose spec
    // is registered for `image` while the brief asks for `video`, and the
    // channel is a property of the placement either way.
    index.set(`${row.platform}/${row.placement}`, row.channel);
  }
  return index;
}

/**
 * The spec map the engine expects: `channel:assetType` -> spec.
 *
 * Keyed the way `resolve_spec` looks things up, so a target that names a
 * placement in the registry gets real dimensions and everything downstream —
 * aspect-ratio scoring, safe zones, the crop penalty — starts working.
 */
async function resolveTargetSpecs(tx: Database, targets: unknown[]): Promise<Record<string, unknown>> {
  const list = targets as BriefTarget[];
  const platforms = [...new Set(list.map((t) => t.platform).filter((p): p is string => Boolean(p)))];
  if (platforms.length === 0) return {};

  channelByPlacement = await loadChannelIndex(tx);

  const rows = await tx
    .select({
      platform: channelSpecs.platform,
      placement: channelSpecs.placement,
      assetType: channelSpecs.assetType,
      channel: channelSpecs.channel,
      spec: channelSpecs.spec,
      orgId: channelSpecs.orgId,
    })
    .from(channelSpecs)
    .where(inArray(channelSpecs.platform, platforms))
    // A tenant override beats the shipped registry row, so it is read last and
    // wins the assignment below.
    .orderBy(sql`${channelSpecs.orgId} NULLS FIRST`);

  const out: Record<string, unknown> = {};
  for (const target of list) {
    const assetType = target.assetType ?? 'image';
    const match = rows.find(
      (r) => r.platform === target.platform && r.placement === target.placement && r.assetType === assetType,
    );
    if (!match?.channel) continue;
    out[`${match.channel}:${assetType}`] = match.spec;
  }
  return out;
}

/** A target with its scope-lattice channel resolved, for the engine. */
export function withChannel(target: BriefTarget): Record<string, unknown> {
  const assetType = target.assetType ?? 'image';
  const key = `${target.platform}/${target.placement}/${assetType}`;
  const channel =
    target.channel ??
    channelByPlacement?.get(key) ??
    channelByPlacement?.get(`${target.platform}/${target.placement}`) ??
    null;
  return { ...target, assetType, channel };
}
