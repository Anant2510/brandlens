import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@brandlens/db';
import {
  assets,
  brandDocumentChunks,
  brandDocuments,
  brands,
  designTokens,
  imageStyleProfiles,
  rules,
  rulesets,
  voiceAttributes,
} from '@brandlens/db';
import type { RuleDefinition } from '@brandlens/contracts';
import { compileRows, type CompilableRuleRow } from '@brandlens/api/rulesets/compile';
import { computeSpecificity } from '@brandlens/api/rulesets/specificity';
import { hexToLab } from '@brandlens/api/common/color';
import { env } from '../config';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import { buildBrandContext } from '../services/brand-context';

/* ==========================================================================
 * Ontology jobs: extract from documents, induce from the corpus, compile.
 *
 * Both extraction and induction produce rules with `status: 'proposed'`, with
 * no exception and no configuration flag. A machine may propose; only a human
 * may activate. That single invariant is what makes the audit trail defensible
 * when a regulator asks who decided a rule was policy.
 * ========================================================================== */

export interface ExtractDocumentJob {
  orgId: string;
  brandId: string;
  documentId: string;
  requestedByUserId?: string | null;
}

export async function extractBrandDocument(job: ExtractDocumentJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'ontology.extract-document', documentId: job.documentId });

  const doc = await ctx.withTenant(job.orgId, async (tx) => {
    const rows = await tx.select().from(brandDocuments).where(eq(brandDocuments.id, job.documentId)).limit(1);
    return rows[0] ?? null;
  });
  if (!doc) {
    log.warn('document not found');
    return;
  }
  // At-least-once: a document already extracted must not be re-billed.
  if (doc.status === 'extracted') {
    log.debug('document already extracted — idempotent no-op');
    return;
  }

  await ctx.withTenant(job.orgId, (tx) =>
    tx.update(brandDocuments).set({ status: 'extracting', updatedAt: new Date() }).where(eq(brandDocuments.id, doc.id)),
  );

  try {
    const response = await ctx.engine.extractRules({
      requestId: job.documentId,
      orgId: job.orgId,
      brandId: job.brandId,
      documentUri: ctx.storage.engineUri(doc.storageKey),
      documentName: doc.name,
      mimeType: doc.mimeType ?? undefined,
      provider: env.LLM_EXTRACT_PROVIDER,
      model: env.LLM_EXTRACT_MODEL,
    });

    await ctx.withTenant(job.orgId, async (tx) => {
      // Chunks first: extracted rules cite them by page + bbox, and a citation
      // that points at a chunk we did not store is worse than no citation.
      for (const chunk of response.chunks) {
        await tx
          .insert(brandDocumentChunks)
          .values({
            orgId: job.orgId,
            documentId: doc.id,
            page: chunk.page,
            ordinal: chunk.ordinal,
            heading: chunk.heading ?? null,
            text: chunk.text,
            bbox: chunk.bbox ?? null,
          })
          .onConflictDoNothing();
      }

      const ruleIds = await insertProposedRules(tx, job.orgId, job.brandId, response.rules, 'deductive', doc.id);

      for (const token of response.tokens) {
        const lab = token.hex ? hexToLab(token.hex) : null;
        await tx
          .insert(designTokens)
          .values({
            orgId: job.orgId,
            brandId: job.brandId,
            path: token.path.slice(0, 300),
            type: token.type as typeof designTokens.$inferInsert.type,
            value: (token.value ?? null) as unknown,
            hex: token.hex ?? null,
            labL: lab?.[0] ?? null,
            labA: lab?.[1] ?? null,
            labB: lab?.[2] ?? null,
            source: 'brandbook',
          })
          .onConflictDoNothing();
      }

      for (const voice of response.voiceAttributes) {
        await tx
          .insert(voiceAttributes)
          .values({
            orgId: job.orgId,
            brandId: job.brandId,
            name: voice.name.slice(0, 120),
            weAre: voice.weAre,
            weAreNot: voice.weAreNot,
          })
          .onConflictDoNothing();
      }

      await tx
        .update(brandDocuments)
        .set({
          status: 'extracted',
          pageCount: response.pageCount,
          extractionStats: {
            proposedRules: ruleIds.length,
            tokens: response.tokens.length,
            voiceAttributes: response.voiceAttributes.length,
            chunks: response.chunks.length,
            costUsd: response.costUsd,
            warnings: response.warnings,
          },
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(brandDocuments.id, doc.id));

      for (const ruleId of ruleIds) {
        await emitEvent(tx, {
          orgId: job.orgId,
          type: 'rule.proposed',
          aggregateType: 'rule',
          aggregateId: ruleId,
          payload: { brandId: job.brandId, ruleId, source: 'document', documentId: doc.id },
          idempotencyKey: `rule.proposed:${ruleId}`,
        });
      }
    });

    log.info({ rules: response.rules.length, pages: response.pageCount }, 'document extracted');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(brandDocuments)
        .set({ status: 'failed', error: message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(brandDocuments.id, doc.id)),
    );
    throw err;
  }
}

export interface InduceRulesJob {
  orgId: string;
  brandId: string;
  percentile?: number;
  minSupport?: number;
  assetIds?: string[];
  requestedByUserId?: string | null;
}

/**
 * `ontology.induce-rules` — measure the approved corpus to find the rules the
 * team actually enforces, as opposed to the ones they wrote down.
 */
export async function induceRules(job: InduceRulesJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'ontology.induce-rules', brandId: job.brandId });

  const { exemplars, brandContext } = await ctx.withTenant(job.orgId, async (tx) => {
    const exemplars = await tx
      .select()
      .from(assets)
      .where(
        and(eq(assets.brandId, job.brandId), eq(assets.isApprovedExemplar, true), isNull(assets.deletedAt)),
      )
      .limit(500);
    const brandContext = await buildBrandContext(tx, ctx.storage, job.brandId);
    return { exemplars, brandContext };
  });

  const selected = job.assetIds?.length ? exemplars.filter((a) => job.assetIds?.includes(a.id)) : exemplars;
  const minSupport = job.minSupport ?? 20;

  if (selected.length < Math.min(minSupport, 5)) {
    // Induction on a handful of assets produces thresholds that are noise
    // dressed up as policy; refusing is more useful than proposing rubbish.
    log.warn({ available: selected.length, minSupport }, 'not enough approved exemplars to induce rules');
    return;
  }

  const response = await ctx.engine.induceRules({
    requestId: `induce:${job.brandId}:${Date.now()}`,
    orgId: job.orgId,
    brandId: job.brandId,
    assets: selected.map((a) => ({
      id: a.id,
      kind: a.kind,
      uri: ctx.storage.engineUri(a.storageKey),
      mimeType: a.mimeType ?? undefined,
      contentHash: a.contentHash,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
      dpi: a.dpi ?? undefined,
      colorProfile: a.colorProfile ?? undefined,
      structuredSource: a.structuredSource ?? undefined,
      copyFields: a.copyFields ?? {},
      market: a.market ?? undefined,
      channel: a.channel ?? undefined,
      assetType: a.assetType ?? undefined,
      locale: a.locale ?? undefined,
    })),
    brand: brandContext,
    percentile: job.percentile ?? 5,
    minSupport,
  });

  await ctx.withTenant(job.orgId, async (tx) => {
    const ruleIds = await insertProposedRules(tx, job.orgId, job.brandId, response.rules, 'inductive', null);

    if (response.styleProfile) {
      const profile = response.styleProfile as {
        name?: string;
        featureStats?: Record<string, unknown>;
        centroid?: number[];
        distanceP5?: number;
        distanceP50?: number;
        allowedMediums?: string[];
        prohibitedSubjects?: string[];
      };
      const existing = await tx
        .select({ id: imageStyleProfiles.id })
        .from(imageStyleProfiles)
        .where(eq(imageStyleProfiles.brandId, job.brandId))
        .limit(1);

      const values = {
        orgId: job.orgId,
        brandId: job.brandId,
        name: profile.name ?? 'Induced style profile',
        featureStats: profile.featureStats ?? {},
        centroid: profile.centroid ?? null,
        distanceP5: profile.distanceP5 ?? null,
        distanceP50: profile.distanceP50 ?? null,
        sampleSize: response.measuredCount,
        allowedMediums: profile.allowedMediums ?? null,
        prohibitedSubjects: profile.prohibitedSubjects ?? null,
        embeddingModel: env.IMAGE_EMBEDDING_PROVIDER,
        updatedAt: new Date(),
      };

      if (existing[0]) {
        await tx.update(imageStyleProfiles).set(values).where(eq(imageStyleProfiles.id, existing[0].id));
      } else {
        await tx.insert(imageStyleProfiles).values(values);
      }
    }

    for (const ruleId of ruleIds) {
      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'rule.proposed',
        aggregateType: 'rule',
        aggregateId: ruleId,
        payload: { brandId: job.brandId, ruleId, source: 'induction', measuredCount: response.measuredCount },
        idempotencyKey: `rule.proposed:${ruleId}`,
      });
    }
  });

  log.info({ proposed: response.rules.length, measured: response.measuredCount }, 'rules induced');
}

export interface CompileRulesetJob {
  orgId: string;
  brandId: string;
  label?: string;
  userId?: string | null;
}

/**
 * `ontology.compile-ruleset` — freeze the active rules and publish.
 *
 * IDEMPOTENT by hash: identical rules produce an identical snapshot, and the
 * unique index on (brand, hash) turns a re-run into a pointer update rather
 * than a duplicate version.
 */
export async function compileRuleset(job: CompileRulesetJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'ontology.compile-ruleset', brandId: job.brandId });

  await ctx.withTenant(job.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.brandId, job.brandId), eq(rules.status, 'active')))
      .orderBy(rules.key);

    const compiled = compileRows(job.brandId, rows as unknown as CompilableRuleRow[]);

    const existing = await tx
      .select({ id: rulesets.id, version: rulesets.version })
      .from(rulesets)
      .where(and(eq(rulesets.brandId, job.brandId), eq(rulesets.hash, compiled.hash)))
      .limit(1);

    if (existing[0]) {
      await tx
        .update(brands)
        .set({ activeRulesetId: existing[0].id, updatedAt: new Date() })
        .where(eq(brands.id, job.brandId));
      log.debug({ version: existing[0].version }, 'identical ruleset already published — pointer updated');
      return;
    }

    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${rulesets.version}), 0)::int` })
      .from(rulesets)
      .where(eq(rulesets.brandId, job.brandId));
    const version = (max ?? 0) + 1;

    const [row] = await tx
      .insert(rulesets)
      .values({
        orgId: job.orgId,
        brandId: job.brandId,
        version,
        hash: compiled.hash,
        label: job.label ?? `v${version}`,
        compiled: { rules: compiled.rules, scoringConfig: compiled.scoringConfig } as Record<string, unknown>,
        ruleCount: compiled.ruleCount,
        scoringConfig: compiled.scoringConfig as unknown as Record<string, unknown>,
        publishedByUserId: job.userId ?? null,
      })
      .returning({ id: rulesets.id });

    await tx
      .update(brands)
      .set({ activeRulesetId: row.id, updatedAt: new Date() })
      .where(eq(brands.id, job.brandId));

    await emitEvent(tx, {
      orgId: job.orgId,
      type: 'ruleset.published',
      aggregateType: 'ruleset',
      aggregateId: row.id,
      payload: { brandId: job.brandId, rulesetId: row.id, version, hash: compiled.hash, ruleCount: compiled.ruleCount },
      idempotencyKey: `ruleset.published:${row.id}`,
    });

    log.info({ version, ruleCount: compiled.ruleCount }, 'ruleset published');
  });
}

/**
 * Inserts machine-generated rules. ALWAYS `proposed` — the parameter for
 * "activate these automatically" deliberately does not exist.
 */
async function insertProposedRules(
  tx: Database,
  orgId: string,
  brandId: string,
  proposals: RuleDefinition[],
  provenance: 'deductive' | 'inductive' | 'transfer',
  documentId: string | null,
): Promise<string[]> {
  const ids: string[] = [];

  for (const p of proposals) {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${rules.version}), 0)::int` })
      .from(rules)
      .where(and(eq(rules.brandId, brandId), eq(rules.key, p.key)));

    const [row] = await tx
      .insert(rules)
      .values({
        orgId,
        brandId,
        key: p.key.slice(0, 160),
        version: (max ?? 0) + 1,
        statement: p.statement,
        rationale: p.rationale ?? null,
        dimension: p.dimension,
        tier: p.tier,
        severity: p.severity,
        weight: p.weight,
        scope: p.scope,
        specificity: computeSpecificity(p.scope),
        check: { fn: p.check.fn, params: p.check.params ?? {} },
        rubric: (p.rubric ?? null) as Record<string, unknown> | null,
        provenance,
        citation: documentId ? { ...(p.citation ?? {}), documentId } : (p.citation ?? null),
        support: p.support ?? null,
        status: 'proposed',
      })
      .returning({ id: rules.id });
    ids.push(row.id);
  }

  return ids;
}
