import { and, desc, eq } from 'drizzle-orm';
import type { Verdict } from '@brandlens/contracts';
import { assets, decisionTraces, precedents, reviewDecisions, ruleCalibrations, rules } from '@brandlens/db';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { embedBytes, hasEmbedding, upsertEmbedding } from '../services/embeddings';

/* ==========================================================================
 * Learning jobs.
 *
 * These two handlers are what make the product feel like it learned the brand
 * without any training happening: a human decision becomes a retrievable
 * precedent, and the accumulated agreement becomes a per-rule calibration that
 * can switch the rule off automatically when the judge stops tracking the
 * tenant's reviewers.
 * ========================================================================== */

export interface IndexPrecedentJob {
  orgId: string;
  brandId: string;
  ruleKey: string;
  ruleVersion: number;
  assetId: string;
  traceId?: string | null;
  verdict: Verdict;
  rationale?: string | null;
}

/**
 * `learning.index-precedent`
 *
 * IDEMPOTENT: the unique key (brand, ruleKey, ruleVersion, asset) upserts, so
 * a redelivery replaces rather than duplicating. A reviewer who changes their
 * mind must not leave two contradictory precedents behind.
 */
export async function indexPrecedent(job: IndexPrecedentJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'learning.index-precedent', ruleKey: job.ruleKey });

  const trace = job.traceId
    ? await ctx.withTenant(job.orgId, async (tx) => {
        const rows = await tx.select().from(decisionTraces).where(eq(decisionTraces.id, job.traceId as string)).limit(1);
        return rows[0] ?? null;
      })
    : null;

  await ctx.withTenant(job.orgId, async (tx) => {
    await tx
      .insert(precedents)
      .values({
        orgId: job.orgId,
        brandId: job.brandId,
        ruleKey: job.ruleKey,
        ruleVersion: job.ruleVersion,
        assetId: job.assetId,
        traceId: job.traceId ?? null,
        // The HUMAN verdict, not the machine's — that is the whole point.
        verdict: job.verdict,
        rationale: job.rationale ?? null,
        measured: (trace?.evidence?.measured as Record<string, unknown> | undefined) ?? null,
        cropKey: trace?.evidence?.cropKey ?? null,
      })
      .onConflictDoUpdate({
        target: [precedents.brandId, precedents.ruleKey, precedents.ruleVersion, precedents.assetId],
        set: {
          verdict: job.verdict,
          rationale: job.rationale ?? null,
          traceId: job.traceId ?? null,
        },
      });

    await emitEvent(tx, {
      orgId: job.orgId,
      type: 'precedent.indexed',
      aggregateType: 'precedent',
      aggregateId: job.assetId,
      payload: { brandId: job.brandId, ruleKey: job.ruleKey, assetId: job.assetId, verdict: job.verdict },
      idempotencyKey: `precedent:${job.brandId}:${job.ruleKey}:${job.ruleVersion}:${job.assetId}`,
    });
  });

  // Retrieval ranks precedents by similarity, so a precedent without an
  // embedding is effectively invisible. Backfill it here rather than assuming
  // ingestion already did.
  const needsVector = !(await ctx.withTenant(job.orgId, (tx) => hasEmbedding(tx, 'asset', job.assetId, 'image')));
  if (needsVector) {
    const asset = await ctx.withTenant(job.orgId, async (tx) => {
      const rows = await tx.select().from(assets).where(eq(assets.id, job.assetId)).limit(1);
      return rows[0] ?? null;
    });
    if (asset && asset.kind !== 'copy') {
      try {
        const result = await embedBytes(ctx.engine, job.orgId, asset.id, ctx.storage.engineUri(asset.storageKey));
        await ctx.withTenant(job.orgId, (tx) =>
          upsertEmbedding(tx, {
            orgId: job.orgId,
            ownerType: 'asset',
            ownerId: asset.id,
            space: 'image',
            modelId: result.modelId,
            vec: result.vec,
            contentHash: asset.contentHash,
          }),
        );
      } catch (err) {
        // A missing embedding degrades retrieval quality; it must not lose the
        // precedent itself, which is already committed above.
        log.warn({ err: String(err) }, 'precedent embedding failed; precedent is still indexed');
      }
    }
  }

  log.info({ verdict: job.verdict }, 'precedent indexed');
}

export interface CalibrateRuleJob {
  orgId: string;
  brandId: string;
  ruleKey: string;
}

const AUTO_ROUTE_BETA_FLOOR = 0.3;
const MIN_SAMPLES = 8;

/**
 * `learning.calibrate-rule` — refit P(human rejects | machine signal).
 *
 * IDEMPOTENT in effect: recomputing from the same decisions yields the same
 * coefficients, and the snapshot table is append-only by design so the history
 * of a rule's reliability is itself auditable.
 */
export async function calibrateRule(job: CalibrateRuleJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'learning.calibrate-rule', ruleKey: job.ruleKey });

  const rows = await ctx.withTenant(job.orgId, (tx) =>
    tx
      .select({
        confidence: decisionTraces.confidence,
        verdict: decisionTraces.verdict,
        action: reviewDecisions.action,
        ruleVersion: decisionTraces.ruleVersion,
      })
      .from(reviewDecisions)
      .innerJoin(decisionTraces, eq(decisionTraces.id, reviewDecisions.traceId))
      .where(and(eq(reviewDecisions.orgId, job.orgId), eq(reviewDecisions.ruleKey, job.ruleKey)))
      .orderBy(desc(reviewDecisions.createdAt))
      .limit(2000),
  );

  if (rows.length < MIN_SAMPLES) {
    log.debug({ samples: rows.length }, 'not enough labels to calibrate yet');
    return;
  }

  const samples = rows.map((r) => ({
    // Deterministic tiers report no confidence; treat them as maximally
    // confident, which is what they are — arithmetic does not hedge.
    x: r.confidence ?? 1,
    y: isOverride(r.action) ? 1 : 0,
  }));

  const { alpha, beta } = fitLogistic(samples);
  const agreementRate = 1 - samples.reduce((acc, s) => acc + s.y, 0) / samples.length;
  const kappa = cohensKappa(
    rows.map((r) => ({ machineFail: r.verdict === 'fail', humanFail: humanSaysFail(r.action, r.verdict === 'fail') })),
  );
  const autoRouteToHuman = Math.abs(beta) < AUTO_ROUTE_BETA_FLOOR;
  const thresholdAfter = Math.abs(beta) > 1e-6 ? clamp01(-alpha / beta) : null;
  const ruleVersion = rows[0]?.ruleVersion ?? 1;

  await ctx.withTenant(job.orgId, async (tx) => {
    await tx.insert(ruleCalibrations).values({
      orgId: job.orgId,
      brandId: job.brandId,
      ruleKey: job.ruleKey,
      ruleVersion,
      method: 'logistic',
      alpha: round4(alpha),
      beta: round4(beta),
      thresholdAfter: thresholdAfter === null ? null : round4(thresholdAfter),
      agreementRate: round4(agreementRate),
      cohensKappa: round4(kappa),
      sampleSize: samples.length,
      autoRouteToHuman,
    });

    // Denormalised onto the rule so the compiler and the judge read it without
    // a join on the hot path.
    await tx
      .update(rules)
      .set({
        calibration: {
          alpha: round4(alpha),
          beta: round4(beta),
          agreementRate: round4(agreementRate),
          overrideRate: round4(1 - agreementRate),
          sampleSize: samples.length,
          thresholdOverride: thresholdAfter ?? undefined,
          autoRouteToHuman,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(rules.brandId, job.brandId), eq(rules.key, job.ruleKey)));

    await emitEvent(tx, {
      orgId: job.orgId,
      type: 'calibration.updated',
      aggregateType: 'rule',
      aggregateId: null,
      payload: {
        brandId: job.brandId,
        ruleKey: job.ruleKey,
        alpha: round4(alpha),
        beta: round4(beta),
        agreementRate: round4(agreementRate),
        cohensKappa: round4(kappa),
        sampleSize: samples.length,
        autoRouteToHuman,
      },
      idempotencyKey: `calibration:${job.brandId}:${job.ruleKey}:${samples.length}`,
    });
  });

  if (autoRouteToHuman) {
    // beta below the floor means the machine's confidence carries no
    // information about what these reviewers will accept. Routing to a human
    // is the honest response; leaving it on would burn trust and money.
    log.warn({ beta: round4(beta), samples: samples.length }, 'rule auto-routed to human review');
  } else {
    log.info({ beta: round4(beta), agreementRate: round4(agreementRate) }, 'rule calibrated');
  }
}

/* -------------------------------------------------------------------- maths */

interface Sample {
  x: number;
  y: number;
}

/**
 * Logistic regression by batch gradient ascent on the log-likelihood.
 *
 * One feature, a few hundred points, refitted after every review — a 400-step
 * loop is microseconds and adds no dependency. The L2 term keeps beta finite
 * when the data are perfectly separable, which happens constantly early on
 * (the first eight decisions all agree).
 */
export function fitLogistic(
  samples: readonly Sample[],
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): { alpha: number; beta: number } {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const n = samples.length;
  if (n === 0) return { alpha: 0, beta: 0 };

  let alpha = 0;
  let beta = 0;
  for (let i = 0; i < iterations; i += 1) {
    let gAlpha = 0;
    let gBeta = 0;
    for (const s of samples) {
      const p = 1 / (1 + Math.exp(-(alpha + beta * s.x)));
      const err = s.y - p;
      gAlpha += err;
      gBeta += err * s.x;
    }
    alpha += lr * (gAlpha / n - l2 * alpha);
    beta += lr * (gBeta / n - l2 * beta);
  }
  return { alpha, beta };
}

/** Chance-corrected agreement: raw agreement flatters any rule that mostly passes. */
export function cohensKappa(pairs: ReadonlyArray<{ machineFail: boolean; humanFail: boolean }>): number {
  const n = pairs.length;
  if (n === 0) return 0;
  let agree = 0;
  let machineFails = 0;
  let humanFails = 0;
  for (const p of pairs) {
    if (p.machineFail === p.humanFail) agree += 1;
    if (p.machineFail) machineFails += 1;
    if (p.humanFail) humanFails += 1;
  }
  const po = agree / n;
  const pe = (machineFails / n) * (humanFails / n) + ((n - machineFails) / n) * ((n - humanFails) / n);
  return pe === 1 ? 0 : (po - pe) / (1 - pe);
}

function isOverride(action: string): boolean {
  return action === 'override_pass' || action === 'override_fail';
}

function humanSaysFail(action: string, machineSaidFail: boolean): boolean {
  if (action === 'override_pass') return false;
  if (action === 'override_fail') return true;
  if (action === 'waive') return false;
  return machineSaidFail;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
