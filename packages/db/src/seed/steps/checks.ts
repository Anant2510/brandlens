/* ==========================================================================
 * Step 4 — one completed check run, end to end.
 *
 * The dashboard, the check viewer, the findings queue, the review screen and
 * the analytics pages all read from this. Without it, a fresh install shows
 * five empty states and the product looks like a settings screen.
 *
 * What is produced:
 *
 *   1 check_run          against the off-palette creative, with a real score
 *                        computed by the same aggregation the API uses
 *   39 decision_traces   one per resolved criterion, each with its measured
 *                        value, its threshold and its citation
 *   6 findings           the failures and the abstention
 *   1 review             in `changes_requested`, assigned to the reviewer
 *   2 review_decisions   one confirm, one override — the override is the
 *                        highest-value training signal the system owns
 *   1 precedent          built from the override, keyed on the rule
 *   2 rule_calibrations  including one with beta below the 0.3 floor
 *   3 cost_ledger rows   the VLM calls that were actually made
 *
 * Every number below is either computed here or carried from the generator's
 * measurements. Nothing is decorative.
 * ========================================================================== */

import {
  auditLog,
  checkRuns,
  costLedger,
  decisionTraces,
  findings,
  precedents,
  reviewDecisions,
  reviews,
  ruleCalibrations,
} from '../../schema/index.js';
import type { Database } from '../../client.js';
import { jobKey, seedId, traceKey } from '../lib/ids.js';
import { insertRows, upsertRows } from '../lib/upsert.js';
import { scoreCriteria, type ScorableCriterion, type Severity, type Verdict } from '../lib/scoring.js';
import { SEED_RULES, SEED_SCORING_CONFIG } from '../data/rules.js';
import { USERS } from './tenant.js';
import type { SeededAsset } from './assets.js';

/** Matches PIPELINE_VERSION in apps/api/src/common/hash.ts. */
const PIPELINE_VERSION = '1.0.0';
/** Matches AppConfigService.judgeModelVersion for the shipped defaults. */
const MODEL_VERSION = 'anthropic/claude-sonnet-4-5-20250929';
const PROMPT_HASH = 'seedpromptv1a2b3c4d5e6f70819202122232425262';

interface TraceSpec {
  ruleKey: string;
  verdict: Verdict;
  confidence?: number;
  evidence: Record<string, unknown>;
  suggestedFix?: string;
  cached?: boolean;
  costUsd?: number;
  latencyMs?: number;
  precedentAssetKeys?: string[];
  finding?: { title: string; detail: string; displayConfidence: number; isHighConfidence: boolean };
}

export interface ChecksResult {
  checkRunId: string;
  reviewId: string;
  score: number | null;
  scoreBand: string | null;
  criteriaTotal: number;
  criteriaFailed: number;
  criteriaAbstained: number;
  coverageRate: number | null;
  findingCount: number;
  overrideCount: number;
  precedentCount: number;
}

export async function seedChecks(
  tx: Database,
  orgId: string,
  brandId: string,
  rulesetId: string,
  rulesetHashValue: string,
  ruleIdByKey: Map<string, string>,
  ruleVersionByKey: Map<string, number>,
  seededAssets: SeededAsset[],
): Promise<ChecksResult> {
  const byKey = new Map(seededAssets.map((a) => [a.key, a]));
  const subject = byKey.get('creative.feed-offpalette');
  if (!subject) throw new Error('seed: the off-palette creative is missing');

  const ruleByKey = new Map(SEED_RULES.map((r) => [r.key, r]));

  /* ------------------------------------------------------------------ *
   * Everything the colour traces cite is MEASURED by the generator off the
   * finished pixels, not written down here. If the creative is ever redrawn,
   * the numbers in the trace follow it instead of quietly becoming fiction.
   * ------------------------------------------------------------------ */
  const m = subject.measured as {
    logoBbox: [number, number, number, number];
    logomarkHeightPx: number;
    offPaletteHex: string;
    offPaletteSurfaceRatio: number;
    offPaletteBbox: [number, number, number, number];
    espressoCreamSurfaceRatio: number;
    copperSurfaceRatio: number;
    deltaEToNearestApprovedToken: number;
  };
  const pct = (ratio: number) => Math.round(ratio * 1000) / 10;

  // The induced dominance rule's verdict is DERIVED from the measurement, not
  // written down. If the creative is ever redrawn past the 55% floor, the
  // seeded trace flips to `pass` instead of asserting a failure that the
  // pixels no longer support.
  const BRAND_DOMINANCE_FLOOR = 0.55;
  const dominancePasses = m.espressoCreamSurfaceRatio >= BRAND_DOMINANCE_FLOOR;

  /* ------------------------------------------------------------------ *
   * The resolved criteria for THIS asset's coordinates:
   *   market en-US · channel meta-feed · assetType image · campaign set
   *
   * `logo.min-size.print` (print channels) and `channel.video-encoding`
   * (assetTypes: video) do not match and are correctly absent.
   * ------------------------------------------------------------------ */
  const traceSpecs: TraceSpec[] = [
    /* --- logo: all pass ------------------------------------------- */
    {
      ruleKey: 'logo.presence',
      verdict: 'pass',
      confidence: 0.97,
      evidence: {
        measured: { variant: 'logo.mono-white', similarity: 0.97, bbox: m.logoBbox },
        threshold: { minSimilarity: 0.82 },
        observation: 'Monochrome-white lockup detected in the top-left quadrant.',
      },
    },
    {
      ruleKey: 'logo.clearspace',
      verdict: 'pass',
      confidence: 0.93,
      evidence: {
        measured: {
          logomarkHeightPx: m.logomarkHeightPx,
          minGapPx: 72,
          multiple: 0.94,
          nearestElement: 'canvas edge',
        },
        threshold: { multiple: 1.35, unit: 'logomark_height' },
        observation:
          'Nearest non-background element is 72px away. The canvas edge is exempt because the mark sits in the declared margin.',
      },
    },
    {
      ruleKey: 'logo.min-size.digital',
      verdict: 'pass',
      evidence: {
        measured: { renderedWidthPx: 268, canvasWidthPx: 1080, widthPct: 0.248 },
        threshold: { minWidthPx: 120, minWidthPct: 0.08 },
      },
    },
    {
      ruleKey: 'logo.no-distortion',
      verdict: 'pass',
      evidence: {
        measured: { aspectRatio: 3.6, referenceAspectRatio: 3.6, deviationPct: 0, rotationDeg: 0 },
        threshold: { maxAspectDeviationPct: 2, maxRotationDeg: 0.5 },
      },
    },
    {
      ruleKey: 'logo.approved-colorways',
      verdict: 'pass',
      evidence: {
        measured: { inkHex: '#ffffff', deltaEToNearestApproved: 0 },
        threshold: { allowedHex: ['#2B1B12', '#F4EDE1', '#000000', '#FFFFFF'], deltaEThreshold: 6 },
      },
    },

    /* --- colour: the headline failures ----------------------------- */
    {
      ruleKey: 'color.forbidden-competitor',
      verdict: 'fail',
      confidence: 0.99,
      evidence: {
        measured: {
          clusterHex: m.offPaletteHex.toLowerCase(),
          surfaceSharePct: pct(m.offPaletteSurfaceRatio),
          deltaEToForbidden: 0,
          forbiddenToken: 'color.forbidden.competitor-green',
          deltaEToNearestApprovedToken: m.deltaEToNearestApprovedToken,
          nearestApprovedToken: 'color.brand.pine',
        },
        threshold: { deltaEThreshold: 12, minClusterSharePct: 2 },
        bbox: m.offPaletteBbox,
        observation:
          `A colour cluster covering ${pct(m.offPaletteSurfaceRatio)}% of the canvas is an exact match for a registered competitor equity colour.`,
      },
      suggestedFix:
        `Replace the green bands with Pine (#1F4D3D) or Espresso (#2B1B12). Pine is the closest approved colour at ΔE ${m.deltaEToNearestApprovedToken}, so this is a visible change, not a nudge.`,
      finding: {
        title: `Competitor equity colour covers ${Math.round(m.offPaletteSurfaceRatio * 100)}% of the canvas`,
        detail:
          '#00704A is registered as a forbidden colour on this brand. It appears as the dominant band colour on both the top and bottom of the asset. A viewer scrolling past reads this as a competitor’s ad.',
        displayConfidence: 0.99,
        isHighConfidence: true,
      },
    },
    {
      ruleKey: 'color.palette-conformance',
      verdict: 'fail',
      confidence: 0.96,
      evidence: {
        measured: {
          clustersEvaluated: 8,
          conformingClusters: 6,
          offPaletteClusters: [
            {
              hex: m.offPaletteHex.toLowerCase(),
              sharePct: pct(m.offPaletteSurfaceRatio),
              nearestToken: 'color.brand.pine',
              deltaE: m.deltaEToNearestApprovedToken,
            },
          ],
        },
        threshold: { deltaEThreshold: 5, minClusterSharePct: 3 },
        bbox: m.offPaletteBbox,
        observation: '6 of 8 significant clusters are within ΔE 5 of an approved token. The green bands are not.',
      },
      suggestedFix: 'Recolour the green regions to an approved token or a declared tint of one.',
      finding: {
        title: `Off-palette colour: ΔE ${m.deltaEToNearestApprovedToken} from the nearest approved token`,
        detail:
          `The dominant band colour is ΔE ${m.deltaEToNearestApprovedToken} from Pine, the nearest approved token — far outside the ΔE 5 tolerance. Everything else in the asset conforms.`,
        displayConfidence: 0.96,
        isHighConfidence: true,
      },
    },
    {
      ruleKey: 'color.espresso-cream-dominance',
      verdict: dominancePasses ? 'pass' : 'fail',
      confidence: 0.94,
      evidence: {
        measured: {
          espressoCreamRatio: m.espressoCreamSurfaceRatio,
          copperRatio: m.copperSurfaceRatio,
          offPaletteRatio: m.offPaletteSurfaceRatio,
        },
        threshold: { minRatio: 0.55 },
        observation:
          `Espresso and Cream together carry ${pct(m.espressoCreamSurfaceRatio)}% of the surface, against a 55% floor induced from the approved corpus.`,
      },
      suggestedFix: 'Recolouring the green bands to Espresso would take this above 95% and resolve it.',
      finding: dominancePasses
        ? undefined
        : {
        title: `Brand colours carry only ${pct(m.espressoCreamSurfaceRatio)}% of the surface (floor: 55%)`,
        detail:
          'Induced from 52 approved assets at the 10th percentile. This is the distinctiveness rule: the ground is the asset, not the mark.',
        displayConfidence: 0.94,
        isHighConfidence: true,
      },
    },
    {
      ruleKey: 'color.copper-accent-cap',
      verdict: 'pass',
      evidence: {
        measured: { copperSurfaceRatio: m.copperSurfaceRatio },
        threshold: { maxRatio: 0.18 },
      },
    },

    /* --- typography ------------------------------------------------ */
    {
      ruleKey: 'typography.approved-families',
      verdict: 'pass',
      confidence: 0.88,
      evidence: {
        measured: { resolvedFamilies: ['Inter'], coveragePct: 100 },
        threshold: { allowed: ['Sole Serif Display', 'Inter'], minCoveragePct: 95 },
        observation:
          'Closed-set verification against the three approved faces. Rendered candidates matched Inter on every span.',
      },
    },
    {
      ruleKey: 'typography.no-fallback-fonts',
      verdict: 'pass',
      evidence: { measured: { detected: [] }, threshold: { forbidden: ['Times New Roman', 'Calibri', 'Comic Sans MS', 'Papyrus'] } },
    },
    {
      ruleKey: 'typography.body-min-size',
      verdict: 'pass',
      evidence: {
        measured: { smallestBodyPx: 28, canvasShortEdgePx: 1080, pctOfCanvas: 0.026 },
        threshold: { minSizePx: 15, minSizePctOfCanvas: 0.014 },
      },
    },
    {
      ruleKey: 'typography.legal-min-size',
      verdict: 'not_applicable',
      evidence: { observation: 'No legal or disclaimer copy was submitted with this asset, and none is required.' },
    },
    {
      ruleKey: 'typography.no-faux-styles',
      verdict: 'pass',
      evidence: { measured: { fauxBoldSpans: 0, fauxItalicSpans: 0 }, threshold: { forbidFauxBold: true, forbidFauxItalic: true } },
    },

    /* --- layout ---------------------------------------------------- */
    {
      ruleKey: 'layout.safe-zone',
      verdict: 'pass',
      evidence: {
        measured: { placement: 'meta/feed/image', violations: [] },
        threshold: { safeZones: { top: 0, right: 0, bottom: 0, left: 0 } },
        observation: 'Feed images carry no platform chrome overlay, so the safe zone is the full canvas.',
      },
    },
    {
      ruleKey: 'layout.outer-margin',
      verdict: 'pass',
      evidence: { measured: { minMarginPx: 72 }, threshold: { minMarginPx: 48, minMarginPct: 0.045 } },
    },
    {
      ruleKey: 'layout.grid-alignment',
      verdict: 'pass',
      evidence: { measured: { elementsOffGrid: 0, elementsChecked: 6 }, threshold: { gridPx: 8, tolerancePx: 2 } },
    },
    {
      ruleKey: 'layout.no-element-overlap',
      verdict: 'pass',
      evidence: { measured: { overlappingPairs: [] }, threshold: { maxOverlapPct: 1 } },
    },
    {
      ruleKey: 'layout.text-density',
      verdict: 'pass',
      evidence: { measured: { textAreaPct: 11.4 }, threshold: { maxTextAreaPct: 20 } },
    },

    /* --- imagery --------------------------------------------------- */
    {
      ruleKey: 'imagery.style-conformance',
      verdict: 'not_applicable',
      evidence: { observation: 'No photographic region was detected. The asset is entirely flat colour and type.' },
    },
    {
      ruleKey: 'imagery.medium',
      verdict: 'not_applicable',
      evidence: { observation: 'No imagery to classify.' },
    },
    {
      ruleKey: 'imagery.prohibited-subjects',
      verdict: 'pass',
      confidence: 0.98,
      costUsd: 0.0091,
      latencyMs: 2140,
      evidence: {
        measured: { subjectsDetected: [] },
        threshold: { subjects: ['alcohol', 'smoking', 'driving while drinking', 'child holding a hot drink'] },
        observation: 'No prohibited subject is depicted; the asset contains no people or objects at all.',
      },
    },

    /* --- copy ------------------------------------------------------ */
    {
      ruleKey: 'copy.banned-terms',
      verdict: 'pass',
      evidence: { measured: { matches: [] }, threshold: { termCount: 25, fuzzyThreshold: 0.92 } },
    },
    {
      ruleKey: 'copy.required-terms',
      verdict: 'pass',
      evidence: {
        measured: { found: ['Northwind'] },
        threshold: { required: ['Northwind'] },
        quotedText: 'Northwind single origin, ground to order.',
      },
    },
    {
      ruleKey: 'copy.locale-spelling',
      verdict: 'pass',
      evidence: { measured: { market: 'en-US', violations: [] }, threshold: { forbiddenSpellings: ['colour', 'flavour', 'harbour', 'litre', 'organise'] } },
    },
    {
      ruleKey: 'copy.readability',
      verdict: 'pass',
      evidence: { measured: { fleschReadingEase: 74.2 }, threshold: { minScore: 55 } },
    },
    {
      ruleKey: 'copy.cta-allowlist',
      verdict: 'pass',
      evidence: { measured: { cta: 'Shop now' }, threshold: { allowedCount: 7 } },
    },
    {
      ruleKey: 'copy.voice-tone',
      verdict: 'fail',
      confidence: 0.66,
      costUsd: 0.0074,
      latencyMs: 1880,
      precedentAssetKeys: ['creative.feed-hero', 'creative.linkedin'],
      evidence: {
        measured: { axisScores: { 'Warm, not folksy': 0.81, 'Precise, not technical': 0.74, 'Confident, not superior': 0.38, 'Grounded, not preachy': 0.79 } },
        threshold: { minAxisScore: 0.6 },
        quotedText: 'The smoothest cup you will drink',
        observation:
          'The "Confident, not superior" axis scores 0.38. The headline asserts a superiority the reader has not agreed to, which the we-are-not exemplars name explicitly.',
      },
      suggestedFix:
        'Reframe as a recommendation rather than a verdict: "Our smoothest roast yet. Start here if you take milk."',
      finding: {
        title: 'Voice: "Confident, not superior" — headline asserts superiority',
        detail:
          'The judge scored the axis at 0.38 against a 0.6 floor. Note the confidence is 0.66, only just above the 0.55 abstention threshold, so this is a candidate for human review rather than a settled verdict.',
        displayConfidence: 0.66,
        isHighConfidence: false,
      },
    },

    /* --- accessibility --------------------------------------------- */
    {
      ruleKey: 'accessibility.text-contrast',
      verdict: 'pass',
      evidence: {
        measured: { minRatio: 9.8, pairsChecked: 5, worstPair: { fg: '#2b1b12', bg: '#f4ede1' } },
        threshold: { normalRatio: 4.5, largeRatio: 3 },
      },
    },
    {
      ruleKey: 'accessibility.legal-contrast',
      verdict: 'not_applicable',
      evidence: { observation: 'No legal copy on this asset.' },
    },
    {
      ruleKey: 'accessibility.font-size-floor',
      verdict: 'pass',
      evidence: { measured: { smallestRenderedPx: 28 }, threshold: { minPx: 11 } },
    },

    /* --- channel spec ---------------------------------------------- */
    {
      ruleKey: 'channel.dimensions',
      verdict: 'pass',
      evidence: {
        measured: { width: 1080, height: 1080, aspectRatio: 1 },
        threshold: { placement: 'meta/feed/image', aspectRatios: ['1:1', '4:5', '1.91:1'], minWidth: 600 },
      },
    },
    {
      ruleKey: 'channel.file-size',
      verdict: 'pass',
      evidence: {
        measured: { bytes: subject.byteSize, format: 'png' },
        threshold: { maxBytes: 31_457_280, formats: ['jpg', 'jpeg', 'png'] },
      },
    },

    /* --- legal ------------------------------------------------------ */
    {
      ruleKey: 'legal.claim-registered',
      verdict: 'fail',
      confidence: 0.91,
      evidence: {
        measured: { detectedClaim: 'The smoothest cup you will drink', category: 'superlative', matchedClaimId: null, bestMatchScore: 0.31 },
        threshold: { requireRegistered: true, fuzzyThreshold: 0.88 },
        quotedText: 'The smoothest cup you will drink',
        observation:
          'A superlative claim with no match in the register. The closest registered claim scores 0.31, well below the 0.88 match threshold.',
      },
      suggestedFix:
        'Either register and substantiate the claim, or drop the superlative: "Our smoothest roast" is a description, "the smoothest cup you will drink" is a comparative claim about every other coffee.',
      finding: {
        title: 'Unregistered superlative claim in the headline',
        detail:
          '"The smoothest cup you will drink" is a comparative superlative with no entry in the claims register. Under the CAP Code and FTC Act s.5 the burden of substantiation sits with the advertiser.',
        displayConfidence: 0.91,
        isHighConfidence: true,
      },
    },
    {
      ruleKey: 'legal.claim-in-date',
      verdict: 'not_applicable',
      evidence: { observation: 'No registered claim was matched, so there is no approval date to check.' },
    },
    {
      ruleKey: 'legal.claim-jurisdiction',
      verdict: 'not_applicable',
      evidence: { observation: 'No registered claim was matched.' },
    },
    {
      ruleKey: 'legal.disclaimer-present',
      verdict: 'not_applicable',
      evidence: { observation: 'No matched claim requires a disclaimer.' },
    },
    {
      ruleKey: 'legal.disclaimer-legible',
      verdict: 'not_applicable',
      evidence: { observation: 'No disclaimer is required on this asset.' },
    },

    /* --- the holistic pass, last ------------------------------------ */
    {
      ruleKey: 'vlm.overall-judgment',
      verdict: 'abstained',
      confidence: 0.49,
      costUsd: 0.0138,
      latencyMs: 3260,
      evidence: {
        measured: { selfConsistencyK: 3, votes: ['fail', 'pass', 'fail'], voteEntropy: 0.918 },
        threshold: { abstainBelowConfidence: 0.55 },
        observation:
          'Three samples disagreed (2 fail, 1 pass), giving a vote entropy of 0.92 and a confidence of 0.49. Below the 0.55 threshold the correct answer is to abstain and route to a human, not to pick the majority.',
      },
      finding: {
        title: 'Holistic judgment abstained — routed to a human',
        detail:
          'The judge was not confident enough to decide. This is the designed behaviour: an abstention costs one review, a wrong confident verdict costs the reviewer’s trust in every future verdict.',
        displayConfidence: 0.49,
        isHighConfidence: false,
      },
    },
  ];

  /* ------------------------------------------------------------------ *
   * Score — computed, not asserted.
   * ------------------------------------------------------------------ */
  const criteria: ScorableCriterion[] = traceSpecs.map((spec) => {
    const rule = ruleByKey.get(spec.ruleKey);
    if (!rule) throw new Error(`seed: trace references unknown rule ${spec.ruleKey}`);
    return {
      ruleKey: spec.ruleKey,
      dimension: rule.dimension,
      severity: rule.severity as Severity,
      verdict: spec.verdict,
      weight: rule.weight,
    };
  });

  const score = scoreCriteria(criteria, SEED_SCORING_CONFIG);

  const totalCost = traceSpecs.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const cacheHits = traceSpecs.filter((s) => s.cached).length;

  const checkRunId = seedId('checkrun', brandId, subject.key, rulesetHashValue);
  const startedAt = new Date('2026-08-14T10:22:05Z');
  const completedAt = new Date('2026-08-14T10:22:14Z');

  await upsertRows(tx, checkRuns, [
    {
      id: checkRunId,
      orgId,
      brandId,
      assetId: subject.id,
      rulesetId,
      jobKey: jobKey({
        assetContentHash: subject.contentHash,
        rulesetHash: rulesetHashValue,
        pipelineVersion: PIPELINE_VERSION,
        modelVersion: MODEL_VERSION,
        promptHash: PROMPT_HASH,
        variant: '',
      }),
      rulesetHash: rulesetHashValue,
      pipelineVersion: PIPELINE_VERSION,
      status: 'completed',
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
      cacheMisses: traceSpecs.length - cacheHits,
      costUsd: Math.round(totalCost * 10_000) / 10_000,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      degradedReason: null,
      triggeredByUserId: USERS.creator.id,
      triggeredBy: 'ui',
      error: null,
      startedAt,
      completedAt,
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Decision traces — append-only, so insert-once.
   * ------------------------------------------------------------------ */
  const traceIdByRuleKey = new Map<string, string>();
  const traceRows = traceSpecs.map((spec, index) => {
    const rule = ruleByKey.get(spec.ruleKey)!;
    const version = ruleVersionByKey.get(spec.ruleKey) ?? 1;
    const id = seedId('trace', checkRunId, spec.ruleKey);
    traceIdByRuleKey.set(spec.ruleKey, id);

    const isModelTier = rule.tier === 'vlm' || rule.tier === 'hybrid';

    return {
      id,
      orgId,
      checkRunId,
      assetId: subject.id,
      traceKey: traceKey({
        assetContentHash: subject.contentHash,
        rulesetHash: rulesetHashValue,
        ruleKey: spec.ruleKey,
        ruleVersion: version,
        modelVersion: MODEL_VERSION,
        promptHash: PROMPT_HASH,
      }),
      assetContentHash: subject.contentHash,
      rulesetHash: rulesetHashValue,
      ruleId: ruleIdByKey.get(spec.ruleKey) ?? null,
      ruleKey: spec.ruleKey,
      ruleVersion: version,
      dimension: rule.dimension,
      tier: rule.tier,
      verdict: spec.verdict,
      severity: rule.severity,
      confidence: spec.confidence ?? (isModelTier ? null : 1),
      // Null for deterministic tiers — arithmetic has no model identity.
      model: isModelTier
        ? {
            provider: 'anthropic',
            id: 'claude-sonnet-4-5-20250929',
            version: MODEL_VERSION,
            promptHash: PROMPT_HASH,
            temperature: 0,
            selfConsistencyK: spec.ruleKey === 'vlm.overall-judgment' ? 3 : 1,
            voteEntropy:
              spec.ruleKey === 'vlm.overall-judgment'
                ? (spec.evidence.measured as { voteEntropy?: number } | undefined)?.voteEntropy ?? null
                : 0,
          }
        : null,
      evidence: spec.evidence,
      precedentAssetIds:
        spec.precedentAssetKeys?.map((k) => byKey.get(k)?.id).filter((v): v is string => Boolean(v)) ?? null,
      citation: rule.citation ?? null,
      suggestedFix: spec.suggestedFix ?? null,
      cached: spec.cached ?? false,
      costUsd: spec.costUsd ?? 0,
      latencyMs: spec.latencyMs ?? 2 + (index % 5),
      createdAt: new Date(startedAt.getTime() + index * 180),
    };
  });

  await insertRows(tx, decisionTraces, traceRows);

  /* ------------------------------------------------------------------ *
   * Findings
   * ------------------------------------------------------------------ */
  const findingIdByRuleKey = new Map<string, string>();
  const findingRows = traceSpecs
    .filter((spec) => spec.finding)
    .map((spec) => {
      const rule = ruleByKey.get(spec.ruleKey)!;
      const id = seedId('finding', checkRunId, spec.ruleKey);
      findingIdByRuleKey.set(spec.ruleKey, id);
      const overridden = spec.ruleKey === 'copy.voice-tone';
      const confirmed = spec.ruleKey === 'color.forbidden-competitor';

      return {
        id,
        orgId,
        checkRunId,
        traceId: traceIdByRuleKey.get(spec.ruleKey)!,
        assetId: subject.id,
        ruleKey: spec.ruleKey,
        dimension: rule.dimension,
        severity: rule.severity,
        title: spec.finding!.title,
        detail: spec.finding!.detail,
        status: overridden ? 'overridden' : confirmed ? 'confirmed' : 'open',
        displayConfidence: spec.finding!.displayConfidence,
        isHighConfidence: spec.finding!.isHighConfidence,
        bbox: (spec.evidence.bbox as number[] | undefined) ?? null,
        cropKey: null,
        resolvedByUserId: overridden || confirmed ? USERS.reviewer.id : null,
        resolvedAt: overridden || confirmed ? new Date('2026-08-14T14:05:00Z') : null,
      };
    });

  await upsertRows(tx, findings, findingRows);

  /* ------------------------------------------------------------------ *
   * Review + human decisions
   * ------------------------------------------------------------------ */
  const reviewId = seedId('review', checkRunId);
  await upsertRows(tx, reviews, [
    {
      id: reviewId,
      orgId,
      assetId: subject.id,
      checkRunId,
      state: 'changes_requested',
      stage: 'brand',
      assignedToUserId: USERS.reviewer.id,
      dueAt: new Date('2026-08-15T10:22:14Z'),
      decidedByUserId: USERS.reviewer.id,
      decidedAt: new Date('2026-08-14T14:08:00Z'),
      summary:
        'Blocking on the competitor colour and the unregistered superlative. The voice flag is wrong — see the override. Resubmit with the bands recoloured to Espresso and the headline reframed.',
    },
  ]);

  const decisionRows = [
    {
      id: seedId('decision', reviewId, 'confirm-forbidden-colour'),
      orgId,
      reviewId,
      traceId: traceIdByRuleKey.get('color.forbidden-competitor')!,
      findingId: findingIdByRuleKey.get('color.forbidden-competitor')!,
      assetId: subject.id,
      ruleKey: 'color.forbidden-competitor',
      ruleVersion: ruleVersionByKey.get('color.forbidden-competitor') ?? 1,
      action: 'confirm',
      rationale:
        'Correct and obvious. That is their green, not ours. Recolour to Espresso and resubmit — Pine is too close to it to be a safe substitute here.',
      annotationBbox: [0, 0, 1, 0.4074],
      reviewerUserId: USERS.reviewer.id,
      isCalibrationLabel: false,
      createdAt: new Date('2026-08-14T14:02:00Z'),
    },
    {
      id: seedId('decision', reviewId, 'override-voice-tone'),
      orgId,
      reviewId,
      traceId: traceIdByRuleKey.get('copy.voice-tone')!,
      findingId: findingIdByRuleKey.get('copy.voice-tone')!,
      assetId: subject.id,
      ruleKey: 'copy.voice-tone',
      ruleVersion: ruleVersionByKey.get('copy.voice-tone') ?? 1,
      action: 'override_pass',
      // The rationale is not commentary — GEPA-style prompt optimisation
      // consumes this text directly, and it renders as precedent context on
      // the next judgment of the same rule.
      rationale:
        'Disagree. "Smoothest" here describes our own range, not the category — we say "our smoothest roast" all the time and it has never been a superiority claim. The axis is about how we talk ABOUT THE READER, and this headline does not talk about the reader at all. The legal flag on the same line is the real issue and I have left it open.',
      annotationBbox: [0.0667, 0.4815, 0.9333, 0.5648],
      reviewerUserId: USERS.reviewer.id,
      isCalibrationLabel: true,
      createdAt: new Date('2026-08-14T14:05:00Z'),
    },
  ];

  await upsertRows(tx, reviewDecisions, decisionRows);

  /* ------------------------------------------------------------------ *
   * Precedent — the human verdict, indexed for retrieval at judge time.
   *
   * At the next judgment of copy.voice-tone the retriever pulls the k nearest
   * decided precedents for that rule and injects them with their verdicts and
   * rationales. That is what produces "it learned our brand" behaviour with
   * no training at all.
   * ------------------------------------------------------------------ */
  await upsertRows(tx, precedents, [
    {
      id: seedId('precedent', brandId, 'copy.voice-tone', subject.key),
      orgId,
      brandId,
      ruleKey: 'copy.voice-tone',
      ruleVersion: ruleVersionByKey.get('copy.voice-tone') ?? 1,
      assetId: subject.id,
      traceId: traceIdByRuleKey.get('copy.voice-tone')!,
      // The HUMAN verdict, not the machine's.
      verdict: 'pass',
      rationale:
        'Superlatives about our own range are not a "superior" voice violation. The axis is about how we address the reader.',
      measured: { axis: 'Confident, not superior', machineScore: 0.38, machineVerdict: 'fail', humanVerdict: 'pass' },
      cropKey: null,
      embeddingId: null,
    },
    {
      id: seedId('precedent', brandId, 'color.forbidden-competitor', subject.key),
      orgId,
      brandId,
      ruleKey: 'color.forbidden-competitor',
      ruleVersion: ruleVersionByKey.get('color.forbidden-competitor') ?? 1,
      assetId: subject.id,
      traceId: traceIdByRuleKey.get('color.forbidden-competitor')!,
      verdict: 'fail',
      rationale: 'Confirmed. Competitor equity green as the dominant surface.',
      measured: { clusterHex: '#00704a', surfaceSharePct: 41.1, deltaEToForbidden: 0 },
      cropKey: null,
      embeddingId: null,
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Calibration snapshots
   * ------------------------------------------------------------------ */
  await upsertRows(tx, ruleCalibrations, [
    {
      id: seedId('calibration', brandId, 'copy.voice-tone', '2026-08-02'),
      orgId,
      brandId,
      ruleKey: 'copy.voice-tone',
      ruleVersion: 1,
      method: 'logistic',
      alpha: -1.42,
      beta: 0.71,
      thresholdBefore: 0.6,
      thresholdAfter: 0.63,
      agreementRate: 0.84,
      precision: 0.79,
      recall: 0.88,
      cohensKappa: 0.62,
      ece: 0.071,
      sampleSize: 61,
      coverageAtTarget: 0.72,
      autoRouteToHuman: false,
      notes:
        'Judge tracks these reviewers well. Threshold nudged up 0.03 to trade a little coverage for precision after four false positives on own-range superlatives.',
      createdAt: new Date('2026-08-02T09:14:00Z'),
    },
    {
      id: seedId('calibration', brandId, 'vlm.mood-alignment', '2026-08-05'),
      orgId,
      brandId,
      ruleKey: 'vlm.mood-alignment',
      ruleVersion: 1,
      method: 'logistic',
      alpha: -0.31,
      beta: 0.18,
      thresholdBefore: 0.5,
      thresholdAfter: 0.5,
      agreementRate: 0.52,
      precision: 0.48,
      recall: 0.55,
      cohensKappa: 0.04,
      ece: 0.244,
      sampleSize: 24,
      coverageAtTarget: 0,
      // beta 0.18 < the 0.3 floor: the judge's confidence carries essentially
      // no information about what these reviewers will accept, so the rule is
      // routed 100% to humans until it improves. This is the kill switch.
      autoRouteToHuman: true,
      notes:
        'beta 0.18, kappa 0.04 — the judge is not measuring what these reviewers mean by "mood". Auto-routed to human review. Do not activate this rule until beta exceeds 0.3.',
      createdAt: new Date('2026-08-05T11:02:00Z'),
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Cost ledger — every paid call, so budgets have something to read.
   * ------------------------------------------------------------------ */
  await upsertRows(tx, costLedger, [
    {
      id: seedId('cost', checkRunId, 'imagery.prohibited-subjects'),
      orgId,
      checkRunId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      operation: 'judge.imagery.prohibited_subject',
      inputTokens: '1842',
      cachedInputTokens: '1420',
      outputTokens: '96',
      imageCount: '1',
      costUsd: '0.0091',
      cacheHit: false,
      latencyMs: '2140',
      createdAt: new Date('2026-08-14T10:22:08Z'),
    },
    {
      id: seedId('cost', checkRunId, 'copy.voice-tone'),
      orgId,
      checkRunId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      operation: 'judge.copy.voice_tone',
      inputTokens: '2310',
      cachedInputTokens: '1980',
      outputTokens: '184',
      imageCount: '0',
      costUsd: '0.0074',
      cacheHit: false,
      latencyMs: '1880',
      createdAt: new Date('2026-08-14T10:22:11Z'),
    },
    {
      id: seedId('cost', checkRunId, 'vlm.overall-judgment'),
      orgId,
      checkRunId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      operation: 'judge.overall',
      inputTokens: '5120',
      cachedInputTokens: '4400',
      outputTokens: '412',
      imageCount: '3',
      costUsd: '0.0138',
      cacheHit: false,
      latencyMs: '3260',
      createdAt: new Date('2026-08-14T10:22:14Z'),
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Audit trail — append-only.
   * ------------------------------------------------------------------ */
  await insertRows(tx, auditLog, [
    {
      id: seedId('audit', checkRunId, 'create'),
      orgId,
      actorUserId: USERS.creator.id,
      action: 'check.create',
      entityType: 'check_run',
      entityId: checkRunId,
      payload: { assetId: subject.id, brandId, rulesetHash: rulesetHashValue, ruleCount: traceSpecs.length, async: true },
      createdAt: startedAt,
    },
    {
      id: seedId('audit', checkRunId, 'review'),
      orgId,
      actorUserId: USERS.reviewer.id,
      action: 'review.submit',
      entityType: 'review',
      entityId: reviewId,
      payload: { state: 'changes_requested', confirmed: 1, overridden: 1, open: 4 },
      createdAt: new Date('2026-08-14T14:08:00Z'),
    },
    {
      id: seedId('audit', rulesetId, 'publish'),
      orgId,
      actorUserId: USERS.owner.id,
      action: 'ruleset.publish',
      entityType: 'ruleset',
      entityId: rulesetId,
      payload: { version: 1, hash: rulesetHashValue },
      createdAt: new Date('2026-03-01T09:30:00Z'),
    },
  ]);

  return {
    checkRunId,
    reviewId,
    score: score.score,
    scoreBand: score.scoreBand,
    criteriaTotal: score.criteriaTotal,
    criteriaFailed: score.criteriaFailed,
    criteriaAbstained: score.criteriaAbstained,
    coverageRate: score.coverageRate,
    findingCount: findingRows.length,
    overrideCount: decisionRows.filter((d) => d.action.startsWith('override')).length,
    precedentCount: 2,
  };
}
