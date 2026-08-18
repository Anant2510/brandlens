import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { decisionTraces, reviewDecisions, ruleCalibrations, rules } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { OutboxService } from '../platform/outbox.service';

export interface CalibrationSample {
  /** The machine's signal: confidence, or a normalised measured value. */
  x: number;
  /** 1 when the human rejected the machine's verdict, 0 when they agreed. */
  y: number;
}

export interface CalibrationResult {
  method: 'logistic' | 'isotonic';
  alpha: number;
  beta: number;
  agreementRate: number;
  cohensKappa: number;
  sampleSize: number;
  /**
   * beta is the operational kill switch. |beta| < 0.3 means the machine's
   * confidence carries essentially no information about whether this tenant's
   * reviewers will accept the verdict — the model is not measuring what these
   * humans mean by this rule — so the rule is routed 100% to human review.
   */
  autoRouteToHuman: boolean;
  thresholdAfter: number | null;
}

const AUTO_ROUTE_BETA_FLOOR = 0.3;
const MIN_SAMPLES = 8;

@Injectable()
export class CalibrationService {
  private readonly logger = new Logger(CalibrationService.name);

  constructor(
    private readonly repo: TenantRepository,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Refits P(human rejects | machine signal) for one rule and persists it.
   *
   * Called after every review decision. The samples come from joining review
   * decisions back to the traces they overruled, which is why the trace table
   * has to keep the confidence the machine reported at the time.
   */
  async calibrateRule(orgId: string, brandId: string, ruleKey: string): Promise<CalibrationResult | null> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          confidence: decisionTraces.confidence,
          verdict: decisionTraces.verdict,
          action: reviewDecisions.action,
          ruleVersion: decisionTraces.ruleVersion,
        })
        .from(reviewDecisions)
        .innerJoin(decisionTraces, eq(decisionTraces.id, reviewDecisions.traceId))
        .where(and(eq(reviewDecisions.orgId, orgId), eq(reviewDecisions.ruleKey, ruleKey)))
        .orderBy(desc(reviewDecisions.createdAt))
        .limit(2000),
    );

    if (rows.length < MIN_SAMPLES) return null;

    const samples: CalibrationSample[] = rows.map((r) => ({
      // Deterministic tiers report no confidence; treat them as maximally
      // confident, which is what they are — arithmetic does not hedge.
      x: r.confidence ?? 1,
      y: isOverride(r.action) ? 1 : 0,
    }));

    const fit = fitLogistic(samples);
    const agreementRate = 1 - samples.reduce((acc, s) => acc + s.y, 0) / samples.length;
    const kappa = cohensKappa(rows.map((r) => ({ machineFail: r.verdict === 'fail', humanFail: humanSaysFail(r.action, r.verdict === 'fail') })));
    const autoRouteToHuman = Math.abs(fit.beta) < AUTO_ROUTE_BETA_FLOOR;

    // The confidence at which the model is 50/50 with these reviewers — the
    // natural place to put the abstain threshold.
    const thresholdAfter = Number.isFinite(fit.beta) && Math.abs(fit.beta) > 1e-6 ? clamp01(-fit.alpha / fit.beta) : null;

    const ruleVersion = rows[0]?.ruleVersion ?? 1;
    const result: CalibrationResult = {
      method: 'logistic',
      alpha: round4(fit.alpha),
      beta: round4(fit.beta),
      agreementRate: round4(agreementRate),
      cohensKappa: round4(kappa),
      sampleSize: samples.length,
      autoRouteToHuman,
      thresholdAfter: thresholdAfter === null ? null : round4(thresholdAfter),
    };

    await this.repo.runAs(orgId, undefined, async (tx) => {
      await tx.insert(ruleCalibrations).values({
        orgId,
        brandId,
        ruleKey,
        ruleVersion,
        method: result.method,
        alpha: result.alpha,
        beta: result.beta,
        thresholdAfter: result.thresholdAfter,
        agreementRate: result.agreementRate,
        cohensKappa: result.cohensKappa,
        sampleSize: result.sampleSize,
        autoRouteToHuman: result.autoRouteToHuman,
      });

      // Denormalised onto the rule so the compiler and the judge can read it
      // without a join on the hot path.
      await tx
        .update(rules)
        .set({
          calibration: {
            alpha: result.alpha,
            beta: result.beta,
            agreementRate: result.agreementRate,
            overrideRate: round4(1 - result.agreementRate),
            sampleSize: result.sampleSize,
            thresholdOverride: result.thresholdAfter ?? undefined,
            autoRouteToHuman: result.autoRouteToHuman,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(and(eq(rules.brandId, brandId), eq(rules.key, ruleKey)));

      await this.outbox.emitIn(tx, {
        orgId,
        type: 'calibration.updated',
        aggregateType: 'rule',
        aggregateId: null,
        payload: { brandId, ruleKey, ...result },
        idempotencyKey: `calibration:${brandId}:${ruleKey}:${result.sampleSize}`,
      });
    });

    if (autoRouteToHuman) {
      this.logger.warn({ ruleKey, beta: result.beta }, 'rule auto-routed to human review (beta below floor)');
    }
    return result;
  }

  async latestFor(orgId: string, brandId: string, ruleKey: string) {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(ruleCalibrations)
        .where(and(eq(ruleCalibrations.brandId, brandId), eq(ruleCalibrations.ruleKey, ruleKey)))
        .orderBy(desc(ruleCalibrations.createdAt))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** Per-rule override rate — the single best product-health metric we own. */
  async overrideRates(orgId: string, brandId?: string): Promise<Map<string, { total: number; overrides: number }>> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          ruleKey: reviewDecisions.ruleKey,
          action: reviewDecisions.action,
          n: sql<number>`count(*)::int`,
        })
        .from(reviewDecisions)
        .where(eq(reviewDecisions.orgId, orgId))
        .groupBy(reviewDecisions.ruleKey, reviewDecisions.action),
    );

    const out = new Map<string, { total: number; overrides: number }>();
    for (const row of rows) {
      if (!row.ruleKey) continue;
      const bucket = out.get(row.ruleKey) ?? { total: 0, overrides: 0 };
      bucket.total += row.n;
      if (isOverride(row.action)) bucket.overrides += row.n;
      out.set(row.ruleKey, bucket);
    }
    void brandId;
    return out;
  }
}

function isOverride(action: string): boolean {
  return action === 'override_pass' || action === 'override_fail';
}

function humanSaysFail(action: string, machineSaidFail: boolean): boolean {
  if (action === 'override_pass') return false;
  if (action === 'override_fail') return true;
  if (action === 'waive') return false;
  return machineSaidFail; // confirm / comment / escalate: the human agreed
}

/**
 * Logistic regression by batch gradient ascent on the log-likelihood.
 *
 * One feature, a few hundred points, refitted after every review — a hand
 * written 200-iteration loop is microseconds and adds no dependency. L2
 * regularisation keeps beta finite when the data are perfectly separable,
 * which happens constantly early on (the first eight decisions all agree).
 */
export function fitLogistic(
  samples: readonly CalibrationSample[],
  opts: { iterations?: number; learningRate?: number; l2?: number } = {},
): { alpha: number; beta: number } {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;

  let alpha = 0;
  let beta = 0;
  const n = samples.length;
  if (n === 0) return { alpha: 0, beta: 0 };

  for (let i = 0; i < iterations; i += 1) {
    let gAlpha = 0;
    let gBeta = 0;
    for (const s of samples) {
      const p = sigmoid(alpha + beta * s.x);
      const err = s.y - p;
      gAlpha += err;
      gBeta += err * s.x;
    }
    alpha += (lr * (gAlpha / n - l2 * alpha));
    beta += (lr * (gBeta / n - l2 * beta));
  }

  return { alpha, beta };
}

/**
 * Isotonic (pool-adjacent-violators) fit — a monotone step function, used when
 * the relationship is clearly non-linear. Returned as breakpoints rather than
 * coefficients.
 */
export function fitIsotonic(samples: readonly CalibrationSample[]): Array<{ x: number; y: number }> {
  const sorted = [...samples].sort((a, b) => a.x - b.x);
  const blocks: Array<{ sum: number; count: number; x: number }> = [];

  for (const s of sorted) {
    blocks.push({ sum: s.y, count: 1, x: s.x });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.count <= last.sum / last.count) break;
      blocks.pop();
      prev.sum += last.sum;
      prev.count += last.count;
      prev.x = last.x;
    }
  }

  return blocks.map((b) => ({ x: b.x, y: b.sum / b.count }));
}

/** Chance-corrected agreement. Raw agreement flatters any rule that mostly passes. */
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
  const pe =
    (machineFails / n) * (humanFails / n) + ((n - machineFails) / n) * ((n - humanFails) / n);
  if (pe === 1) return 0;
  return (po - pe) / (1 - pe);
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
