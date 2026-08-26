import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  type AnalyzeCopyResponse,
  DiscoveryOptions,
  type DiscoveryReport,
  type DiscoveryStage,
  checkDiscoveryUrl,
  discoveryRunStatus,
} from '@brandlens/contracts';
import {
  assets,
  brands,
  checkRuns,
  claims,
  designTokens,
  disclaimers,
  discoveredPages,
  discoveryRuns,
  findings,
  lexiconTerms,
  logoVariants,
  rules,
  rulesets,
  typeStyles,
  voiceAttributes,
} from '@brandlens/db';
import { contentHash, hashObject } from '@brandlens/api/common/hash';
import { env } from '../config';
import { getContext } from '../context';
import { logger } from '../logger';
import { emitEvent } from '../services/outbox';
import {
  DiscoveryBrowser,
  challengeRefusalDiagnosis,
  classifyChallengePage,
  corpusIsMostlyWalls,
  diagnoseHarvestFailure,
  type PageHarvest,
  type ViewportName,
} from '../services/discovery/browser';
import { staticHarvestSite } from '../services/discovery/static-harvest';
import { type BrandEnrichment, type BrandEnrichmentProvider, buildProviders, domainOf, enrichBrand } from '../services/discovery/brand-enrichment';
import { mergeEnrichment } from '../services/discovery/enrichment-merge';
import { CrawlFrontier } from '../services/discovery/frontier';
import {
  extractPalette,
  extractTypeStyles,
  findContrastFailures,
  parseCssColor,
  rankLogoCandidates,
  toHex,
} from '../services/discovery/extract-identity';
import { synthesizeRules } from '../services/discovery/synthesize-rules';
import { synthesizeCopyRules } from '../services/discovery/copy-pass';
import { EMPTY_ROBOTS, crawlDelayMsFor, isAllowed, parseRobotsTxt } from '../services/discovery/robots';
import { insertProposedRules } from './ontology';
import { analyzeAsset } from './analyze-asset';

export const DISCOVERY_PIPELINE_VERSION = '1.0.0';

export interface DiscoverBrandJob {
  discoveryRunId: string;
  orgId: string;
  userId?: string | null;
}

/**
 * `discovery.run` — URL in, brand ontology out.
 *
 * Five stages, each of which persists its result before the next begins:
 *
 *   harvest  → render N pages, register each as an asset
 *   extract  → measure palette, type and logo from computed styles
 *   induce   → propose rules from the measurements; compile a frozen ruleset
 *   check    → run the 40 analyzers over the harvested pages
 *   report   → aggregate
 *
 * The stage boundaries are not decoration. A crawl is the expensive,
 * rude-to-repeat part, so it commits before anything downstream can fail; a
 * run that dies in `check` keeps its pages and its rules, and the report says
 * which stage it lost rather than showing an empty page.
 *
 * IDEMPOTENT: a completed run returns immediately, which matters because
 * pg-boss guarantees at-least-once and a duplicate delivery would otherwise
 * re-crawl somebody else's website.
 */
export async function discoverBrand(job: DiscoverBrandJob): Promise<void> {
  const ctx = getContext();
  const log = logger.child({ handler: 'discovery.run', discoveryRunId: job.discoveryRunId });
  const startedAt = Date.now();

  const run = await ctx.withTenant(job.orgId, async (tx) => {
    const [row] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, job.discoveryRunId)).limit(1);
    return row ?? null;
  });

  if (!run) {
    log.warn('discovery run disappeared before it started');
    return;
  }
  if (run.status === 'completed' || run.status === 'partial' || run.status === 'cancelled') {
    log.debug({ status: run.status }, 'already finished — idempotent no-op');
    return;
  }

  const options = DiscoveryOptions.parse(run.options ?? {});
  // `level` defaults to 'error' at every push site that omits it; only the two
  // "this is how the run got its data" messages are notes. See the contract.
  const stageErrors: Array<{ stage: string; message: string; url?: string | null; level?: 'error' | 'note' }> = [];
  const browser = new DiscoveryBrowser();

  const setStage = async (stage: DiscoveryStage, progress = 0, extra: Record<string, unknown> = {}) => {
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(discoveryRuns)
        .set({ stage, stageProgress: progress, status: 'running', updatedAt: new Date(), ...extra })
        .where(eq(discoveryRuns.id, run.id)),
    );
  };

  try {
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(discoveryRuns)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(eq(discoveryRuns.id, run.id)),
    );

    /* ============================================================ HARVEST */
    await setStage('harvesting');

    const robots = options.respectRobots ? await fetchRobots(run.originUrl) : EMPTY_ROBOTS;
    const politeDelay = Math.max(options.crawlDelayMs, crawlDelayMsFor(robots, 'brandlens-discovery') ?? 0);

    const frontier = new CrawlFrontier({
      originUrl: run.originUrl,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      includeSubdomains: options.includeSubdomains,
      isAllowed: options.respectRobots ? (url) => isAllowed(robots, 'brandlens-discovery', url) : undefined,
    });

    frontier.add(run.seedUrl, 0);
    for (const url of await fetchSitemapUrls(robots.sitemaps, run.originUrl)) frontier.add(url, 1);

    await browser.launch();

    const harvests: PageHarvest[] = [];
    let harvested = 0;
    let failed = 0;
    let blocked = 0;

    for (let entry = frontier.next(); entry; entry = frontier.next()) {
      for (const viewport of options.viewports as ViewportName[]) {
        try {
          const harvest = await browser.harvest(entry.url, viewport);

          // The browser connected, but a WAF may have answered with a challenge
          // page instead of content — HTTP 200, real DOM, entirely the wrong
          // thing to measure. Drop it before it pollutes the corpus, and do not
          // follow its links: a challenge page only links deeper into itself.
          const challenge = classifyChallengePage(harvest);
          if (challenge.isChallenge) {
            blocked += 1;
            log.info({ url: entry.url, reason: challenge.reason }, 'discarded a bot-challenge page');
            await ctx.withTenant(job.orgId, (tx) =>
              tx.insert(discoveredPages).values({
                orgId: job.orgId,
                discoveryRunId: run.id,
                url: entry.url,
                depth: entry.depth,
                role: entry.role,
                viewport,
                error: `bot challenge: ${challenge.reason}`,
              }).onConflictDoNothing(),
            );
            continue;
          }

          harvests.push(harvest);

          const stored = await storeHarvestedPage(ctx, job.orgId, run.id, harvest, entry, viewport);
          if (viewport === 'desktop' || options.viewports.length === 1) {
            // Links are followed from one viewport only. A responsive site
            // hides different links at each width, and crawling the union
            // double-counts the same pages against the budget.
            for (const link of harvest.links) frontier.add(link, entry.depth + 1, harvest.finalUrl);
          }
          if (stored) harvested += 1;
        } catch (err) {
          failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          stageErrors.push({ stage: 'harvesting', message, url: entry.url });
          log.warn({ err, url: entry.url, viewport }, 'page harvest failed; continuing');
          await ctx.withTenant(job.orgId, (tx) =>
            tx.insert(discoveredPages).values({
              orgId: job.orgId,
              discoveryRunId: run.id,
              url: entry.url,
              depth: entry.depth,
              role: entry.role,
              viewport,
              error: message.slice(0, 500),
            }).onConflictDoNothing(),
          );
        }
      }

      await setStage('harvesting', Math.min(1, harvested / Math.max(1, options.maxPages)), {
        pagesDiscovered: frontier.discovered,
        pagesHarvested: harvested,
        pagesFailed: failed,
      });

      if (politeDelay > 0) await sleep(politeDelay);
    }

    await browser.close();

    if (blocked > 0) {
      // Surfaced, not swallowed: a run that silently dropped six pages would
      // look like a thin site rather than a defended one.
      stageErrors.push({
        stage: 'harvesting',
        level: 'note',
        message:
          `${blocked} page(s) were bot-challenge interstitials (e.g. an Akamai/Cloudflare "access denied" ` +
          'or CAPTCHA page) served instead of content, and were discarded so they could not be measured as ' +
          'brand copy or colour.',
      });
    }

    let staticFallbackUsed = false;

    /*
     * Two different shortfalls send us to the plain-HTTP channel.
     *
     * The obvious one is an empty harvest. The less obvious one is a harvest
     * that is mostly wall: when more navigations returned a challenge than
     * returned content, the few that got through are not a sample of the site,
     * they are whatever happened to slip past. Deriving a palette from those
     * is worse than thin — it is confidently wrong about a brand on the
     * strength of two stray pages. So we top the corpus up from the channel
     * the site does keep open, rather than reporting a defended site as a
     * small one.
     */
    const mostlyBlocked = corpusIsMostlyWalls(harvests.length, blocked);
    if (harvests.length === 0 || mostlyBlocked) {
      // Work out WHY before giving up. A bot wall, an outage and a slow site
      // all throw at page.goto, and only a plain probe of the origin tells
      // them apart — UNLESS the site already answered with a challenge page,
      // which settles it outright and needs no probe.
      const firstError = stageErrors.find((e) => e.stage === 'harvesting')?.message ?? 'the site returned no renderable pages';
      const diagnosis =
        blocked > 0 ? challengeRefusalDiagnosis(blocked) : await diagnoseHarvestFailure(run.originUrl, new Error(firstError));
      log.warn(
        { diagnosis, originUrl: run.originUrl, rendered: harvests.length, blocked },
        harvests.length === 0 ? 'rendered harvest produced nothing' : 'rendered harvest was mostly bot challenges',
      );

      if (diagnosis.kind === 'bot-refused' && options.staticFallback) {
        // The origin answered a plain request, so read the ontology from the
        // HTML it serves. This is the channel the site keeps open, taken
        // honestly — see static-harvest.ts on why that is not evasion.
        await setStage('harvesting', 0.5, { note: 'browser refused; reading served HTML' });
        const staticPages = await staticHarvestSite(run.seedUrl, {
          maxPages: options.maxPages,
          crawlDelayMs: politeDelay,
          isAllowed: options.respectRobots ? (url) => isAllowed(robots, 'brandlens-discovery', url) : undefined,
          sleep,
        });
        // On a top-up the browser already got some of these; the same URL
        // harvested twice would double its colours' weight in the palette.
        const already = new Set(harvests.map((h) => h.finalUrl));
        let added = 0;
        for (const page of staticPages) {
          if (already.has(page.finalUrl)) continue;
          already.add(page.finalUrl);
          harvests.push(page);
          await storeHarvestedPage(ctx, job.orgId, run.id, page, { depth: 0, role: 'seed' }, 'desktop');
          harvested += 1;
          added += 1;
        }
        if (added > 0) {
          staticFallbackUsed = true;
          stageErrors.push({
            stage: 'harvesting',
            level: 'note',
            message:
              `This site refused the rendered browser, so ${added} page(s) were read from the ` +
              'HTML it serves to a plain request. Colours and type are read from the CSS, not measured from a ' +
              'render, so treat them as lower-confidence until reviewed.',
          });
          log.info({ pages: added, originUrl: run.originUrl }, 'static fallback harvested pages');
        }

        // The loop above owns the progress counters, and the top-up happens
        // after it has stopped running. Without this the run reports "0 pages
        // harvested" for the whole of extraction and induction while 25 pages
        // of ontology are being built from — which reads as a broken run.
        await setStage('harvesting', 1, {
          pagesDiscovered: frontier.discovered,
          pagesHarvested: harvested,
          pagesFailed: failed,
        });
      }

      if (harvests.length === 0) {
        // Even the plain channel gave nothing, or the failure was not a bot
        // wall. Record the machine-readable kind and fail with the honest hint.
        stageErrors.unshift({ stage: 'harvesting', message: `diagnosis:${diagnosis.kind}` });
        throw new Error(
          `Nothing could be harvested from ${run.originUrl}. ${diagnosis.hint}` +
            (diagnosis.kind === 'bot-refused' ? '' : ` (${diagnosis.detail})`),
        );
      }
    }

    /* ============================================================ EXTRACT */
    await setStage('extracting', 0.1);

    const desktop = harvests.filter((h) => h.screenshotWidth > 800);
    const corpus = desktop.length > 0 ? desktop : harvests;

    let palette = extractPalette(corpus.map((h) => ({ url: h.finalUrl, colors: h.colors })));
    let styles = extractTypeStyles(corpus.map((h) => ({ url: h.finalUrl, runs: h.textRuns })));
    const contrastFailures = findContrastFailures(corpus.map((h) => ({ url: h.finalUrl, runs: h.textRuns })));
    let logos = rankLogoCandidates(corpus.flatMap((h) => h.logoCandidates)).slice(0, 5);

    /* --- Brand-data enrichment --------------------------------------------
     * Fetch the brand's identity from a provider that indexes it BY DOMAIN and
     * fold it in. Runs on every discovery when a key is configured, and is the
     * only source that covers a JS-only SPA — it never touches the site, so it
     * works regardless of what the site does to crawlers. It ADDS candidates;
     * anything the crawl measured on the live site keeps precedence.
     * -------------------------------------------------------------------- */
    let enrichmentProvider: string | null = null;
    const providers = buildProviders({ brandfetchApiKey: env.BRANDFETCH_API_KEY, logoDevToken: env.LOGODEV_TOKEN });
    if (providers.length > 0) {
      const domain = domainOf(run.originUrl);
      if (domain) {
        const enrichment = await getCachedEnrichment(ctx, job.orgId, domain, providers).catch((err) => {
          log.warn({ err }, 'brand enrichment failed; discovery keeps its crawled identity');
          return null;
        });
        if (enrichment) {
          const merged = mergeEnrichment(palette, styles, logos, enrichment);
          palette = merged.colors;
          styles = merged.typeStyles;
          logos = merged.logos.slice(0, 6);
          enrichmentProvider = enrichment.provider;
          stageErrors.push({
            stage: 'extracting',
            message:
              `Enriched with brand data from ${enrichment.provider}: ${enrichment.colors.length} colour(s), ` +
              `${enrichment.fonts.length} font(s), ${enrichment.logos.length} logo(s). These are candidate ` +
              'identity from a third-party record — the crawl keeps precedence where the two agree.',
          });
        }
      }
    }

    const brandName = deriveBrandName(corpus, run.originUrl);
    const brandId = await ensureBrand(ctx, job.orgId, options.brandId ?? run.brandId, brandName, run.originUrl, corpus);

    await persistIdentity(ctx, job.orgId, brandId, palette, styles, logos);
    await setStage('extracting', 0.6, { brandId, tokensProposed: palette.length, enrichedBy: enrichmentProvider });

    /* --- The copy pass ----------------------------------------------------
     * Voice, lexicon, claims and disclaimers. Wrapped in its own try/catch
     * because it is the one stage that depends on an external model: an LLM
     * outage must cost the brand its voice section, not its whole ontology.
     * -------------------------------------------------------------------- */
    let copy: Awaited<ReturnType<typeof runCopyPass>> = null;
    try {
      copy = await runCopyPass(ctx, job.orgId, brandId, brandName, run.originUrl, corpus);
      if (copy) {
        await persistCopyOntology(ctx, job.orgId, brandId, copy);
        for (const warning of copy.warnings) stageErrors.push({ stage: 'extracting', message: warning });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'extracting', message: `copy analysis failed: ${message}` });
      log.warn({ err }, 'copy pass failed; the report keeps its measured identity');
    }

    await setStage('extracting', 1, { brandId, tokensProposed: palette.length });

    /* ============================================================= INDUCE */
    await setStage('inducing', 0.2);

    const uniquePages = new Set(corpus.map((h) => h.finalUrl)).size;

    const proposed = [
      ...synthesizeRules({
        colors: palette,
        typeStyles: styles,
        pageCount: uniquePages,
        logoDetected: logos.length > 0 && logos[0].confidence >= 0.5,
        contrastFailures: contrastFailures.length,
      }),
      ...(copy ? synthesizeCopyRules({ copy, pageCount: uniquePages }) : []),
    ];

    const ruleIds = await ctx.withTenant(job.orgId, (tx) =>
      insertProposedRules(tx, job.orgId, brandId, proposed, 'inductive', null),
    );

    const ruleset = await compileDiscoveryRuleset(ctx, job.orgId, brandId, ruleIds, run.originUrl);
    await setStage('inducing', 1, { rulesetId: ruleset.id, rulesProposed: ruleIds.length });

    for (const ruleId of ruleIds) {
      await ctx.withTenant(job.orgId, (tx) =>
        emitEvent(tx, {
          orgId: job.orgId,
          type: 'rule.proposed',
          aggregateType: 'rule',
          aggregateId: ruleId,
          payload: { brandId, ruleId, source: 'discovery', originUrl: run.originUrl },
          idempotencyKey: `rule.proposed:${ruleId}`,
        }),
      );
    }

    /* ============================================================== CHECK */
    let selfCheck: SelfCheckResult = { ran: false, pagesChecked: 0, findingsTotal: 0, blockersTotal: 0, score: null, top: [] };

    if (options.runSelfCheck) {
      await setStage('checking', 0);
      try {
        selfCheck = await runSelfCheck(ctx, job.orgId, brandId, ruleset.id, ruleset.hash, run.id, (p) =>
          setStage('checking', p),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stageErrors.push({ stage: 'checking', message });
        log.warn({ err }, 'self-check failed; the report keeps its ontology');
      }
    }

    /* ============================================================= REPORT */
    await setStage('reporting', 0.5);

    const report: DiscoveryReport = {
      brandName,
      tagline: corpus[0]?.description ?? null,
      positioning: corpus[0]?.description ?? null,
      identity: {
        colors: palette,
        typeStyles: styles,
        logos: logos.map((l) => ({
          source: l.region === 'header' ? 'header' : 'content',
          url: l.src,
          assetId: null,
          previewUrl: l.src || null,
          width: l.width,
          height: l.height,
          isVector: l.isVector,
          confidence: l.confidence,
        })),
        imagery: {
          totalImages: corpus.reduce((n, h) => n + h.images.length, 0),
          vectorShare: shareOf(corpus.flatMap((h) => h.images), (i) => i.isVector),
          missingAltShare: shareOf(corpus.flatMap((h) => h.images), (i) => !i.alt),
        },
      },
      voice: {
        axes: (copy?.voiceAxes ?? []).map((a) => ({
          name: a.name,
          lowLabel: a.lowLabel,
          highLabel: a.highLabel,
          value: a.value,
          rationale: a.rationale ?? null,
          evidence: a.evidence,
        })),
        lexicon: (copy?.lexicon ?? []).map((t) => ({
          term: t.term,
          kind: t.kind,
          note: t.note ?? null,
          uses: t.uses,
          pageCount: t.pageCount,
        })),
        readability: { ...(copy?.readability.metrics ?? {}), ...(copy?.readability.stats ?? {}) },
        readabilityDegraded: copy?.readability.degraded ?? false,
      },
      legal: {
        claims: (copy?.claims ?? []).map((c) => ({
          text: c.text,
          url: c.url,
          needsSubstantiation: c.needsSubstantiation,
          claimType: c.claimType,
          triggers: c.triggers,
          suggestedEvidence: c.suggestedEvidence ?? null,
          judged: c.judged,
        })),
        disclaimers: (copy?.disclaimers ?? []).map((d) => ({
          text: d.text,
          url: d.url,
          triggerCondition: d.triggerCondition ?? null,
        })),
      },
      ruleset: {
        rulesetId: ruleset.id,
        hash: ruleset.hash,
        proposed: ruleIds.length,
        byDimension: countBy(proposed, (r) => r.dimension),
      },
      selfCheck: {
        ran: selfCheck.ran,
        consistencyScore: selfCheck.score,
        pagesChecked: selfCheck.pagesChecked,
        findingsTotal: selfCheck.findingsTotal,
        blockersTotal: selfCheck.blockersTotal,
        topViolations: selfCheck.top,
      },
      coverage: {
        pagesHarvested: harvested,
        pagesFailed: failed,
        // Named explicitly. A report that quietly stopped at eight pages and
        // implied it had seen the site would be the most damaging kind of
        // wrong: confident, tidy, and missing the evidence that mattered.
        skipped: frontier.skipped().map((e) => ({ url: e.url, reason: 'crawl budget reached' })),
        harvestMode: staticFallbackUsed ? 'static' : 'rendered',
      },
    };

    // Defined in @brandlens/contracts next to the shape it reads, so the rule
    // "a note is not a failure" has one home and the worker cannot drift from
    // what the UI believes.
    const status = discoveryRunStatus(stageErrors);

    await ctx.withTenant(job.orgId, async (tx) => {
      await tx
        .update(discoveryRuns)
        .set({
          status,
          stage: 'done',
          stageProgress: 1,
          brandId,
          rulesetId: ruleset.id,
          pagesDiscovered: frontier.discovered,
          pagesHarvested: harvested,
          pagesFailed: failed,
          tokensProposed: palette.length,
          rulesProposed: ruleIds.length,
          consistencyScore: selfCheck.score,
          findingsTotal: selfCheck.findingsTotal,
          blockersTotal: selfCheck.blockersTotal,
          costUsd: copy?.costUsd ?? 0,
          report: report as unknown as Record<string, unknown>,
          stageErrors,
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(discoveryRuns.id, run.id));

      await emitEvent(tx, {
        orgId: job.orgId,
        type: 'discovery.completed',
        aggregateType: 'discovery_run',
        aggregateId: run.id,
        payload: { discoveryRunId: run.id, brandId, rulesProposed: ruleIds.length, status },
        idempotencyKey: `discovery.completed:${run.id}`,
      });
    });

    log.info(
      { status, harvested, rules: ruleIds.length, findings: selfCheck.findingsTotal, ms: Date.now() - startedAt },
      'discovery complete',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'discovery failed');
    await ctx.withTenant(job.orgId, (tx) =>
      tx
        .update(discoveryRuns)
        .set({
          status: 'failed',
          error: message.slice(0, 2000),
          stageErrors,
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(discoveryRuns.id, run.id)),
    );
    throw err;
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ stages */

type Ctx = ReturnType<typeof getContext>;

/**
 * Registers a rendered page as an ordinary asset.
 *
 * This is the join that makes discovery cheap to build: `kind: 'html'` with
 * `sourceFidelity: 'structured'` means every existing analyzer, evidence crop
 * and finding works on a discovered page with no special-casing, and the
 * computed styles it carries are exact values rather than pixel inference.
 */
/**
 * Enrichment for one domain, from a durable per-domain cache.
 *
 * The cache exists to respect the provider's quota — Brandfetch's free tier is
 * 100 fetches a month — so re-running discovery on the same brand does not
 * spend one. It lives in object storage keyed by domain, survives a worker
 * restart, and carries its own fetch timestamp so a stale record is refreshed
 * rather than trusted forever. A brand's identity is stable, so the TTL is
 * generous.
 */
async function getCachedEnrichment(
  ctx: Ctx,
  orgId: string,
  domain: string,
  providers: BrandEnrichmentProvider[],
): Promise<BrandEnrichment | null> {
  const key = ctx.storage.keyFor('derivatives', orgId, contentHash(Buffer.from(`enrichment:${domain}`)), 'json');
  const ttlMs = env.ENRICHMENT_CACHE_TTL_HOURS * 3_600_000;

  if (await ctx.storage.exists(key)) {
    try {
      const cached = JSON.parse((await ctx.storage.readOrFetch(key)).toString('utf8')) as {
        fetchedAt: number;
        enrichment: BrandEnrichment | null;
      };
      if (Date.now() - cached.fetchedAt < ttlMs) {
        logger.info({ domain }, 'brand enrichment served from cache (no provider fetch)');
        return cached.enrichment;
      }
    } catch {
      // A corrupt cache entry is not worth failing over — fall through and
      // refetch, which overwrites it.
    }
  }

  const enrichment = await enrichBrand(domain, providers);
  // Cache the miss too: a domain the provider has no record for should not be
  // asked again on every re-run. `enrichment` is null there, and null is a
  // valid, quota-saving cache value.
  await ctx.storage
    .put(key, Buffer.from(JSON.stringify({ fetchedAt: Date.now(), enrichment })))
    .catch((err) => logger.warn({ err }, 'could not write enrichment cache'));
  return enrichment;
}

async function storeHarvestedPage(
  ctx: Ctx,
  orgId: string,
  discoveryRunId: string,
  harvest: PageHarvest,
  entry: { depth: number; role: string },
  viewport: ViewportName,
): Promise<boolean> {
  // A rendered page arrives as a PNG; a static-harvest page has no pixels and
  // arrives as its structured source. Store whichever it is, so the asset row
  // is honest about what was captured rather than carrying a 0-byte image.
  const rendered = harvest.screenshot.byteLength > 0;
  const structured = {
    url: harvest.finalUrl,
    viewport,
    textRuns: harvest.textRuns,
    colors: harvest.colors.slice(0, 400),
    images: harvest.images,
    lang: harvest.lang,
  };
  const payload = rendered ? harvest.screenshot : Buffer.from(JSON.stringify(structured), 'utf8');
  const hash = contentHash(payload);
  const key = ctx.storage.keyFor('originals', orgId, hash, rendered ? 'png' : 'json');
  await ctx.storage.put(key, payload);

  return ctx.withTenant(orgId, async (tx) => {
    const [brand] = await tx.select({ id: brands.id }).from(brands).limit(1);
    if (!brand) return false;

    const [asset] = await tx
      .insert(assets)
      .values({
        orgId,
        brandId: brand.id,
        name: `${harvest.title ?? harvest.finalUrl} (${viewport})`.slice(0, 400),
        kind: 'html',
        status: 'ingested',
        contentHash: hash,
        storageKey: key,
        mimeType: rendered ? 'image/png' : 'application/json',
        byteSize: payload.byteLength,
        width: harvest.screenshotWidth,
        height: harvest.screenshotHeight,
        sourceFidelity: 'structured',
        structuredSource: structured,
        channel: 'web',
        assetType: 'webpage',
        locale: harvest.lang ?? null,
        copyFields: { body: harvest.bodyText.slice(0, 8000), title: harvest.title ?? '' },
        tags: rendered ? ['discovery', viewport] : ['discovery', viewport, 'static'],
      })
      .returning({ id: assets.id });

    const summary = {
      textRuns: harvest.textRuns.length,
      colors: harvest.colors.length,
      images: harvest.images.length,
    };
    await tx
      .insert(discoveredPages)
      .values({
        orgId,
        discoveryRunId,
        url: harvest.finalUrl,
        depth: entry.depth,
        role: entry.role,
        title: harvest.title,
        httpStatus: harvest.httpStatus,
        viewport,
        assetId: asset.id,
        extractSummary: summary,
        renderMs: harvest.renderMs,
      })
      // A row may already exist for this URL saying the browser hit a bot
      // challenge. We have since harvested it for real — over plain HTTP, most
      // likely — and the successful harvest is the truth. Leaving the failure
      // row would list a page as blocked while its content sits in the
      // ontology, so the later success overwrites it and clears the error.
      .onConflictDoUpdate({
        target: [discoveredPages.discoveryRunId, discoveredPages.url, discoveredPages.viewport],
        set: {
          title: harvest.title,
          httpStatus: harvest.httpStatus,
          assetId: asset.id,
          extractSummary: summary,
          renderMs: harvest.renderMs,
          error: null,
        },
      });

    return true;
  });
}

/**
 * Sends the harvested copy to the engine for voice, lexicon, claims and
 * disclaimers.
 *
 * One call for the whole corpus rather than one per page. Voice is a property
 * of a body of writing: judged page by page, the legal notice and the careers
 * ad come back as two different brands, and reconciling them afterwards means
 * averaging opinions that were never comparable.
 */
async function runCopyPass(
  ctx: Ctx,
  orgId: string,
  brandId: string,
  brandName: string,
  originUrl: string,
  corpus: PageHarvest[],
): Promise<AnalyzeCopyResponse | null> {
  const pages = corpus
    .map((h) => ({
      url: h.finalUrl,
      role: 'other',
      title: h.title ?? null,
      text: (h.bodyText ?? '').trim(),
    }))
    .filter((p) => p.text.length > 40);

  if (pages.length === 0) return null;

  return ctx.engine.analyzeCopy({
    requestId: `discovery-copy:${brandId}`,
    orgId,
    brandId,
    brandName,
    originUrl,
    pages,
    provider: env.LLM_EXTRACT_PROVIDER,
    model: env.LLM_EXTRACT_MODEL,
  });
}

/**
 * Writes voice, lexicon, claims and disclaimers into the brand ontology.
 *
 * Claims land as `isActive: false` with no approval date. That is the whole
 * point: discovery has found sentences that LOOK like claims on a public
 * site, which is a to-do list for a legal reviewer, not a register of
 * approved copy. Inserting them as approved would manufacture a compliance
 * record nobody signed.
 */
async function persistCopyOntology(
  ctx: Ctx,
  orgId: string,
  brandId: string,
  copy: AnalyzeCopyResponse,
): Promise<void> {
  await ctx.withTenant(orgId, async (tx) => {
    for (const axis of copy.voiceAxes) {
      await tx
        .insert(voiceAttributes)
        .values({
          orgId,
          brandId,
          name: axis.name.slice(0, 120),
          // The schema stores a "we are / we are not" pair, which is exactly
          // an axis with the brand's position picked out. Above the midpoint
          // the high label is what the brand is; below it, the low one.
          weAre: axis.value >= 0.5 ? axis.highLabel : axis.lowLabel,
          weAreNot: axis.value >= 0.5 ? axis.lowLabel : axis.highLabel,
          positiveExamples: axis.evidence.slice(0, 4),
          negativeExamples: [],
          // Confidence, expressed as weight: an axis the brand sits squarely
          // on carries more than one it straddles.
          weight: Math.round(Math.abs(axis.value - 0.5) * 2 * 100) / 100,
        })
        .onConflictDoNothing();
    }

    for (const term of copy.lexicon) {
      const kind = term.kind === 'avoid' ? 'banned' : term.kind;
      await tx
        .insert(lexiconTerms)
        .values({
          orgId,
          brandId,
          term: term.term.slice(0, 300),
          kind: kind.slice(0, 30),
          severity: kind === 'banned' ? 'major' : 'minor',
          notes:
            `${term.note ?? 'Discovered from the brand’s website copy.'} ` +
            `(${term.uses} use${term.uses === 1 ? '' : 's'} across ${term.pageCount} page${term.pageCount === 1 ? '' : 's'})`,
        })
        .onConflictDoNothing();
    }

    for (const claim of copy.claims) {
      if (!claim.needsSubstantiation) continue;
      await tx
        .insert(claims)
        .values({
          orgId,
          brandId,
          text: claim.text,
          category: claim.claimType.slice(0, 80),
          substantiationRef: claim.suggestedEvidence ?? null,
          substantiationUrl: claim.url,
          // Unapproved and inactive on purpose — see the doc comment above.
          approvedAt: null,
          isActive: false,
        })
        .onConflictDoNothing();
    }

    for (const [index, disclaimer] of copy.disclaimers.entries()) {
      await tx
        .insert(disclaimers)
        .values({
          orgId,
          brandId,
          name: (disclaimer.triggerCondition || `Discovered disclaimer ${index + 1}`).slice(0, 200),
          text: disclaimer.text,
          isRequired: false,
          severity: 'minor',
        })
        .onConflictDoNothing();
    }
  });
}

async function ensureBrand(
  ctx: Ctx,
  orgId: string,
  existingBrandId: string | null | undefined,
  name: string,
  originUrl: string,
  corpus: PageHarvest[],
): Promise<string> {
  if (existingBrandId) return existingBrandId;

  const slug = `${slugify(name)}-${hashObject({ originUrl }).slice(0, 6)}`.slice(0, 120);

  return ctx.withTenant(orgId, async (tx) => {
    /*
     * This function is called ensureBrand, and it was a bare INSERT.
     *
     * The slug is deterministic by design — same name, same origin, same slug
     * — so the SECOND discovery of a site collided with the first and killed
     * the run on `brands_org_slug_uq`. Discovery is the one operation a person
     * naturally repeats (a site changes, a harvest was thin, the first run was
     * measuring CAPTCHAs), and it was the one operation that could only be run
     * once.
     *
     * Identity is the ORIGIN, not the name. Looking up by slug alone would
     * still split one site across two brands whenever the discovered name
     * shifted — "Academy Sports + Outdoors" from a rendered crawl versus
     * "academy.com" from served HTML is the same company — so the origin
     * recorded in settings is checked first.
     */
    const [byOrigin] = await tx
      .select({ id: brands.id, deletedAt: brands.deletedAt })
      .from(brands)
      .where(and(eq(brands.orgId, orgId), sql`${brands.settings}->>'discoveredFrom' = ${originUrl}`))
      .limit(1);

    const [existing] = byOrigin
      ? [byOrigin]
      : await tx
          .select({ id: brands.id, deletedAt: brands.deletedAt })
          .from(brands)
          .where(and(eq(brands.orgId, orgId), eq(brands.slug, slug)))
          .limit(1);

    if (existing) {
      // Deliberately NOT refreshing name, description or positioning: a person
      // may have corrected them since the first run, and a re-crawl is not a
      // reason to overwrite their edit with whatever the CSS said today. Only
      // the discovery bookkeeping is updated.
      await tx
        .update(brands)
        .set({
          updatedAt: new Date(),
          // Re-discovering a site that was archived is a request to have it
          // back. Leaving it soft-deleted would write this run's identity into
          // a brand that never appears anywhere.
          ...(existing.deletedAt ? { deletedAt: null } : {}),
          settings: sql`${brands.settings} || ${JSON.stringify({ rediscoveredAt: new Date().toISOString() })}::jsonb`,
        })
        .where(eq(brands.id, existing.id));
      return existing.id;
    }

    const [row] = await tx
      .insert(brands)
      .values({
        orgId,
        name: name.slice(0, 200),
        slug,
        description: corpus[0]?.description?.slice(0, 1000) ?? null,
        positioning: corpus[0]?.description ?? null,
        settings: { discoveredFrom: originUrl, discoveredAt: new Date().toISOString() },
      })
      // Two runs on the same origin started together would both miss the reads
      // above and race to insert. The loser takes the winner's row.
      .onConflictDoUpdate({ target: [brands.orgId, brands.slug], set: { updatedAt: new Date() } })
      .returning({ id: brands.id });
    return row.id;
  });
}

async function persistIdentity(
  ctx: Ctx,
  orgId: string,
  brandId: string,
  palette: Awaited<ReturnType<typeof extractPalette>>,
  styles: Awaited<ReturnType<typeof extractTypeStyles>>,
  logos: Array<{ src: string; width: number; height: number; isVector: boolean; confidence: number }>,
): Promise<void> {
  // Fetched before the transaction opens: a logo download is a network call to
  // somebody else's CDN and holding a Postgres transaction open across it
  // would pin a pooled connection for however long they take to respond.
  const logo = await downloadLogo(ctx, orgId, logos[0]);

  await ctx.withTenant(orgId, async (tx) => {
    for (const color of palette) {
      await tx
        .insert(designTokens)
        .values({
          orgId,
          brandId,
          path: `color.${color.role}.${color.hex.slice(1)}`,
          type: 'color',
          value: { colorSpace: 'srgb', hex: color.hex },
          hex: color.hex,
          // Lab is precomputed at import so palette conformance never re-derives
          // it inside its per-cluster ΔE loop.
          labL: color.lab[0],
          labA: color.lab[1],
          labB: color.lab[2],
          role: color.role.slice(0, 40),
          source: 'induced',
          description:
            `Discovered: ${color.role}, ${(color.coverage * 100).toFixed(1)}% of painted area ` +
            `across ${color.pageCount} page(s)`,
          usage: { coverage: color.coverage, pageCount: color.pageCount, citations: color.citations },
        })
        .onConflictDoNothing();
    }

    for (const [index, style] of styles.entries()) {
      await tx
        .insert(typeStyles)
        .values({
          orgId,
          brandId,
          name: style.name.slice(0, 120),
          role: style.role.slice(0, 60),
          fontFamily: style.fontFamily.slice(0, 200),
          fontWeight: style.fontWeight ?? 400,
          // The observed size becomes the enforceable floor for that role;
          // creative smaller than the site's own body copy is the failure the
          // rule is meant to catch.
          minSizePx: style.fontSizePx,
          lineHeightRatio: style.lineHeightPx ? round(style.lineHeightPx / style.fontSizePx, 3) : null,
          letterSpacingEm: style.letterSpacingPx ? round(style.letterSpacingPx / style.fontSizePx, 4) : null,
          scaleRank: index + 1,
        })
        .onConflictDoNothing();
    }

    if (logo) {
      await tx
        .insert(logoVariants)
        .values({
          orgId,
          brandId,
          kind: 'primary',
          name: 'Discovered primary mark',
          storageKey: logo.storageKey,
          contentHash: logo.contentHash,
          mimeType: logo.mimeType,
          width: logo.width,
          height: logo.height,
          aspectRatio: logo.height > 0 ? round(logo.width / logo.height, 4) : null,
          constraints: {
            clearSpaceMultiple: 0.5,
            minWidthPx: Math.max(24, Math.round(logo.width * 0.5)),
            allowedBackgrounds: 'any',
            source: 'discovery-default',
          },
        })
        .onConflictDoNothing();
    }
  });
}

/**
 * Pulls the logo bytes so the brand owns a copy.
 *
 * Storing the remote URL instead would make the ontology depend on somebody
 * else's CDN staying up and serving the same file — and every later
 * `logo.presence` check would silently start failing the day they redesign.
 */
async function downloadLogo(
  ctx: Ctx,
  orgId: string,
  candidate: { src: string; width: number; height: number; isVector: boolean } | undefined,
): Promise<{ storageKey: string; contentHash: string; mimeType: string; width: number; height: number } | null> {
  if (!candidate?.src) return null;

  const guard = checkDiscoveryUrl(candidate.src);
  if (!guard.ok || !guard.url) return null;

  try {
    const res = await fetch(guard.url, {
      headers: { 'user-agent': 'brandlens-discovery' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) return null;

    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream';
    if (!/^image\//.test(mimeType)) return null;

    const hash = contentHash(buffer);
    const ext = mimeType.includes('svg') ? 'svg' : mimeType.includes('png') ? 'png' : mimeType.split('/')[1] || 'bin';
    const key = ctx.storage.keyFor('originals', orgId, hash, ext);
    await ctx.storage.put(key, buffer);

    return { storageKey: key, contentHash: hash, mimeType, width: candidate.width, height: candidate.height };
  } catch {
    // A logo we cannot fetch is not a reason to lose the rest of the ontology.
    return null;
  }
}

/**
 * Compiles a frozen snapshot containing the PROPOSED rules.
 *
 * Checking a brand against rules it has not activated sounds like a
 * contradiction, and it would be if this snapshot were the brand's published
 * ruleset. It is not: it is labelled `discovery`, never becomes
 * `brands.activeRulesetId`, and exists so the report can say "here is what
 * your site would score against the standard we just inferred from it".
 * Activating any of it stays a human act.
 */
async function compileDiscoveryRuleset(
  ctx: Ctx,
  orgId: string,
  brandId: string,
  ruleIds: string[],
  originUrl: string,
): Promise<{ id: string; hash: string }> {
  return ctx.withTenant(orgId, async (tx) => {
    const rows = ruleIds.length
      ? await tx.select().from(rules).where(and(eq(rules.brandId, brandId), inArray(rules.id, ruleIds)))
      : [];

    const compiled = {
      rules: rows.map((r) => ({
        id: r.id,
        key: r.key,
        version: r.version,
        statement: r.statement,
        dimension: r.dimension,
        tier: r.tier,
        severity: r.severity,
        weight: r.weight,
        scope: r.scope,
        check: r.check,
        rubric: r.rubric,
        provenance: r.provenance,
      })),
      source: 'discovery',
      originUrl,
    };

    const hash = hashObject(compiled);
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${rulesets.version}), 0)::int` })
      .from(rulesets)
      .where(eq(rulesets.brandId, brandId));

    const [row] = await tx
      .insert(rulesets)
      .values({
        orgId,
        brandId,
        version: (max ?? 0) + 1,
        hash,
        label: `Discovery — ${new URL(originUrl).hostname}`,
        compiled: compiled as unknown as Record<string, unknown>,
        ruleCount: rows.length,
      })
      .onConflictDoUpdate({
        target: [rulesets.brandId, rulesets.hash],
        set: { ruleCount: rows.length },
      })
      .returning({ id: rulesets.id, hash: rulesets.hash });

    return { id: row.id, hash: row.hash };
  });
}

interface SelfCheckResult {
  ran: boolean;
  pagesChecked: number;
  findingsTotal: number;
  blockersTotal: number;
  score: number | null;
  top: DiscoveryReport['selfCheck']['topViolations'];
}

/**
 * Runs the 40 analyzers over the pages we just harvested.
 *
 * This is the beat that makes the report worth reading. Anyone can list a
 * brand's colours back to them; showing that four of their eight pages break
 * the palette their own site established is the finding they cannot get
 * anywhere else.
 */
async function runSelfCheck(
  ctx: Ctx,
  orgId: string,
  brandId: string,
  rulesetId: string,
  rulesetHash: string,
  discoveryRunId: string,
  onProgress: (fraction: number) => Promise<void>,
): Promise<SelfCheckResult> {
  const pages = await ctx.withTenant(orgId, (tx) =>
    tx
      .select({ assetId: discoveredPages.assetId, url: discoveredPages.url })
      .from(discoveredPages)
      .where(and(eq(discoveredPages.discoveryRunId, discoveryRunId), eq(discoveredPages.viewport, 'desktop'))),
  );

  const targets = pages.filter((p): p is { assetId: string; url: string } => Boolean(p.assetId));
  if (targets.length === 0) return { ran: false, pagesChecked: 0, findingsTotal: 0, blockersTotal: 0, score: null, top: [] };

  const runIds: string[] = [];

  for (const [index, page] of targets.entries()) {
    const jobKey = hashObject({ assetId: page.assetId, rulesetHash, pipeline: DISCOVERY_PIPELINE_VERSION });

    const created = await ctx.withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(checkRuns)
        .values({
          orgId,
          brandId,
          assetId: page.assetId,
          rulesetId,
          jobKey,
          rulesetHash,
          pipelineVersion: DISCOVERY_PIPELINE_VERSION,
          status: 'queued',
          triggeredBy: 'discovery',
        })
        .returning({ id: checkRuns.id });
      return row.id;
    });

    // Run inline rather than enqueueing: the report needs the results, and a
    // fan-out to the queue would leave the run "completed" with an empty
    // self-check section until the jobs happened to drain.
    await analyzeAsset({ orgId, checkRunId: created });
    runIds.push(created);
    await onProgress((index + 1) / targets.length);
  }

  return ctx.withTenant(orgId, async (tx) => {
    const runs = await tx.select().from(checkRuns).where(inArray(checkRuns.id, runIds));
    const found = await tx.select().from(findings).where(inArray(findings.checkRunId, runIds));

    const scored = runs.filter((r) => typeof r.score === 'number');
    const score = scored.length
      ? Math.round((scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length) * 10) / 10
      : null;

    const byRule = new Map<string, { title: string; dimension: string; severity: string; pages: Set<string>; example: { url: string; detail: string } | null }>();
    const urlByRun = new Map(runs.map((r) => [r.id, r.assetId]));
    const urlByAsset = new Map(targets.map((t) => [t.assetId, t.url]));

    for (const f of found) {
      const key = f.ruleKey ?? 'unknown';
      const bucket = byRule.get(key) ?? {
        title: f.title ?? key,
        dimension: f.dimension ?? 'other',
        severity: f.severity ?? 'minor',
        pages: new Set<string>(),
        example: null,
      };
      const url = urlByAsset.get(urlByRun.get(f.checkRunId) ?? '') ?? '';
      if (url) bucket.pages.add(url);
      if (!bucket.example && url) bucket.example = { url, detail: (f.detail ?? f.title ?? '').slice(0, 300) };
      byRule.set(key, bucket);
    }

    const severityRank: Record<string, number> = { blocker: 0, major: 1, minor: 2, advisory: 3 };
    const top = [...byRule.entries()]
      .map(([ruleKey, b]) => ({
        ruleKey,
        title: b.title,
        dimension: b.dimension,
        severity: b.severity,
        pageCount: b.pages.size,
        example: b.example,
      }))
      .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || b.pageCount - a.pageCount)
      .slice(0, 12);

    return {
      ran: true,
      pagesChecked: runs.length,
      findingsTotal: found.length,
      blockersTotal: found.filter((f) => f.severity === 'blocker').length,
      score,
      top,
    };
  });
}

/* ------------------------------------------------------------------ helpers */

async function fetchRobots(originUrl: string) {
  const guard = checkDiscoveryUrl(new URL('/robots.txt', originUrl).toString());
  if (!guard.ok || !guard.url) return EMPTY_ROBOTS;

  try {
    const res = await fetch(guard.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'brandlens-discovery' },
      signal: AbortSignal.timeout(10_000),
    });
    // A 404 means no restrictions. A 500 means the server is unwell, and
    // assuming "allowed" there is the polite reading of an unclear answer.
    if (!res.ok) return EMPTY_ROBOTS;
    return parseRobotsTxt((await res.text()).slice(0, 512_000));
  } catch {
    return EMPTY_ROBOTS;
  }
}

/** Seeds the frontier from sitemap.xml when robots.txt advertises one. */
async function fetchSitemapUrls(sitemaps: string[], originUrl: string): Promise<string[]> {
  const candidates = sitemaps.length ? sitemaps.slice(0, 2) : [new URL('/sitemap.xml', originUrl).toString()];
  const urls: string[] = [];

  for (const candidate of candidates) {
    const guard = checkDiscoveryUrl(candidate);
    if (!guard.ok || !guard.url) continue;
    try {
      const res = await fetch(guard.url, {
        headers: { 'user-agent': 'brandlens-discovery' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const xml = (await res.text()).slice(0, 4_000_000);
      for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        urls.push(match[1]);
        if (urls.length >= 500) break;
      }
    } catch {
      // A missing or malformed sitemap is normal; the crawl falls back to links.
    }
  }

  return urls;
}

function deriveBrandName(corpus: PageHarvest[], originUrl: string): string {
  const siteName = corpus.find((h) => h.siteName)?.siteName;
  if (siteName) return siteName.trim();

  const title = corpus.find((h) => h.title)?.title ?? '';
  // Page titles are "Acme — Coffee for everyone" or "Home | Acme". The brand
  // is the shortest segment, which is almost never the tagline.
  const segments = title.split(/[|—–·-]/).map((s) => s.trim()).filter(Boolean);
  const candidate = segments.sort((a, b) => a.length - b.length)[0];
  if (candidate && candidate.length >= 2 && !/^home$/i.test(candidate)) return candidate;

  return new URL(originUrl).hostname.replace(/^www\./, '');
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'brand'
  );
}

function shareOf<T>(items: T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter(predicate).length / items.length) * 1000) / 1000;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
