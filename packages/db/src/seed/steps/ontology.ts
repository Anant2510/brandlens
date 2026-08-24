/* ==========================================================================
 * Step 2 — the brand ontology.
 *
 *   Brand ─┬─ sub-brand (Northwind Reserve)
 *          ├─ markets (en-US, en-GB, de-DE)
 *          ├─ design tokens        DTCG + precomputed CIELAB
 *          ├─ logo variants        real PNG files, real geometry
 *          ├─ type styles          + forbidden fonts
 *          ├─ voice attributes     4 axes, 3 exemplars per side
 *          ├─ lexicon              25 terms
 *          ├─ claims register      6, two deliberately broken
 *          ├─ disclaimers          3, with size/contrast/proximity
 *          ├─ image style profile  fitted from the "approved corpus"
 *          └─ rules ─► ruleset     compiled, hashed, published
 * ========================================================================== */

import { eq } from 'drizzle-orm';
import {
  brandDocumentChunks,
  brandDocuments,
  brands,
  claims,
  designTokens,
  disclaimers,
  forbiddenFonts,
  imageStyleProfiles,
  lexiconTerms,
  logoVariants,
  markets,
  rules,
  rulesets,
  typeStyles,
  voiceAttributes,
} from '../../schema/index.js';
import type { Database } from '../../client.js';
import { computeSpecificity, rulesetHash, seedId, sha256 } from '../lib/ids.js';
import { upsertRows } from '../lib/upsert.js';
import { storeSeedFile } from '../lib/io.js';
import { generateLogos, type GeneratedLogo } from '../generate/logos.js';
import { SEED_TOKENS } from '../data/tokens.js';
import {
  SEED_CLAIMS,
  SEED_DISCLAIMERS,
  SEED_FORBIDDEN_FONTS,
  SEED_LEXICON,
  SEED_MARKETS,
  SEED_TYPE_STYLES,
  SEED_VOICE,
} from '../data/brand.js';
import { SEED_RULES, SEED_SCORING_CONFIG, type SeedRule } from '../data/rules.js';
import { assertSeedRulesExecutable } from '../data/validate.js';
import { inheritedCompileRows } from './rule-packs.js';
import { USERS } from './tenant.js';

export interface OntologyResult {
  brandId: string;
  reserveBrandId: string;
  rulesetId: string;
  rulesetHash: string;
  activeRuleCount: number;
  proposedRuleCount: number;
  logos: GeneratedLogo[];
  logoStorageKeys: string[];
  ruleIdByKey: Map<string, string>;
  ruleVersionByKey: Map<string, number>;
  claimIdByKey: Map<string, string>;
  disclaimerIdByKey: Map<string, string>;
  documentId: string;
}

/** Fixed so the compiled snapshot is byte-identical on every re-seed. */
const COMPILED_AT = new Date('2026-03-01T00:00:00Z');

const BRAND_SLUG = 'northwind';
const RESERVE_SLUG = 'northwind-reserve';

export async function seedOntology(tx: Database, orgId: string): Promise<OntologyResult> {
  const brandId = seedId('brand', orgId, BRAND_SLUG);
  const reserveBrandId = seedId('brand', orgId, RESERVE_SLUG);

  /* ------------------------------------------------------------------ *
   * Brands. `activeRulesetId` is set at the end, once the ruleset exists.
   * ------------------------------------------------------------------ */
  await upsertRows(
    tx,
    brands,
    [
      {
        id: brandId,
        orgId,
        parentBrandId: null,
        name: 'Northwind',
        slug: BRAND_SLUG,
        description: 'The house brand: everyday specialty coffee, sold direct and through independents.',
        positioning:
          'Specialty coffee for people who want a better cup without a hobby. We compete on freshness and on being straight with people about where the coffee came from — not on romance and not on price.',
        settings: { primaryMarket: 'en-US', reviewSlaHours: 24 },
      },
      {
        id: reserveBrandId,
        orgId,
        parentBrandId: brandId,
        name: 'Northwind Reserve',
        slug: RESERVE_SLUG,
        description: 'Micro-lot sub-brand. Inverted palette, numbered releases, sold out in days.',
        positioning:
          'The lots we would keep for ourselves. Scarce by nature, not by marketing. Reserve inherits the house ontology and overrides colour and type scale.',
        settings: { inheritsFrom: BRAND_SLUG, primaryMarket: 'en-GB' },
      },
    ],
    // activeRulesetId is owned by the publish step, not by the seed data.
    { skip: ['id', 'createdAt', 'activeRulesetId'] },
  );

  /* ------------------------------------------------------------------ *
   * Markets
   * ------------------------------------------------------------------ */
  await upsertRows(
    tx,
    markets,
    SEED_MARKETS.map((m) => ({
      id: seedId('market', brandId, m.code),
      orgId,
      brandId,
      code: m.code,
      name: m.name,
      localeRules: m.localeRules,
    })),
  );

  /* ------------------------------------------------------------------ *
   * Design tokens
   * ------------------------------------------------------------------ */
  await upsertRows(
    tx,
    designTokens,
    SEED_TOKENS.map((t) => {
      const lab = (t.value as { $extensions?: { 'com.brandlens'?: { lab?: { l: number; a: number; b: number } } } })
        .$extensions?.['com.brandlens']?.lab;
      return {
        id: seedId('token', brandId, t.path),
        orgId,
        brandId,
        path: t.path,
        type: t.type,
        value: t.value,
        description: t.description,
        hex: t.hex ?? null,
        labL: lab?.l ?? null,
        labA: lab?.a ?? null,
        labB: lab?.b ?? null,
        role: t.role ?? null,
        allowedTints: t.allowedTints ?? null,
        usage: t.usage ?? {},
        source: t.source ?? 'manual',
      };
    }),
  );

  /* ------------------------------------------------------------------ *
   * Logo variants — real PNGs written to seed/assets/logos and to storage.
   * ------------------------------------------------------------------ */
  const logos = generateLogos();
  const logoStorageKeys: string[] = [];
  const logoRows: Record<string, unknown>[] = [];

  for (const logo of logos) {
    const stored = await storeSeedFile(`logos/${logo.fileName}`, orgId, logo.png, 'png');
    logoStorageKeys.push(stored.storageKey);
    logoRows.push({
      id: seedId('logo', brandId, logo.key),
      orgId,
      brandId,
      name: logo.name,
      kind: logo.kind,
      storageKey: stored.storageKey,
      contentHash: stored.hash,
      mimeType: 'image/png',
      width: logo.width,
      height: logo.height,
      aspectRatio: logo.aspectRatio,
      logomarkHeightPx: logo.logomarkHeightPx,
      palette: logo.palette,
      constraints: logo.constraints,
      isActive: true,
    });
  }
  await upsertRows(tx, logoVariants, logoRows);

  /* ------------------------------------------------------------------ *
   * Typography
   * ------------------------------------------------------------------ */
  await upsertRows(
    tx,
    typeStyles,
    SEED_TYPE_STYLES.map((s) => ({
      id: seedId('typestyle', brandId, s.name),
      orgId,
      brandId,
      name: s.name,
      role: s.role,
      fontFamily: s.fontFamily,
      fontAliases: s.fontAliases,
      fontWeight: s.fontWeight,
      isItalic: s.isItalic ?? false,
      minSizePx: s.minSizePx ?? null,
      minSizePt: s.minSizePt ?? null,
      minSizePctOfCanvas: s.minSizePctOfCanvas ?? null,
      maxSizePx: s.maxSizePx ?? null,
      lineHeightRatio: s.lineHeightRatio ?? null,
      letterSpacingEm: s.letterSpacingEm ?? null,
      casingRules: s.casingRules ?? {},
      scaleRank: s.scaleRank,
    })),
  );

  await upsertRows(
    tx,
    forbiddenFonts,
    SEED_FORBIDDEN_FONTS.map((f) => ({
      id: seedId('forbiddenfont', brandId, f.fontFamily),
      orgId,
      brandId,
      fontFamily: f.fontFamily,
      reason: f.reason,
      severity: f.severity,
    })),
  );

  /* ------------------------------------------------------------------ *
   * Voice + lexicon
   * ------------------------------------------------------------------ */
  await upsertRows(
    tx,
    voiceAttributes,
    SEED_VOICE.map((v) => ({
      id: seedId('voice', brandId, v.name),
      orgId,
      brandId,
      name: v.name,
      weAre: v.weAre,
      weAreNot: v.weAreNot,
      positiveExamples: v.positiveExamples,
      negativeExamples: v.negativeExamples,
      weight: v.weight,
    })),
  );

  await upsertRows(
    tx,
    lexiconTerms,
    SEED_LEXICON.map((t) => ({
      id: seedId('lexicon', brandId, t.kind, t.term),
      orgId,
      brandId,
      term: t.term,
      kind: t.kind,
      replacement: t.replacement ?? null,
      caseSensitive: t.caseSensitive ?? false,
      matchWholeWord: t.matchWholeWord ?? true,
      allowFuzzy: t.allowFuzzy ?? true,
      severity: t.severity,
      marketCodes: t.marketCodes ?? null,
      notes: t.notes ?? null,
    })),
  );

  /* ------------------------------------------------------------------ *
   * Disclaimers first — claims reference them.
   * ------------------------------------------------------------------ */
  const disclaimerIdByKey = new Map<string, string>();
  await upsertRows(
    tx,
    disclaimers,
    SEED_DISCLAIMERS.map((d) => {
      const id = seedId('disclaimer', brandId, d.key);
      disclaimerIdByKey.set(d.key, id);
      return {
        id,
        orgId,
        brandId,
        name: d.name,
        text: d.text,
        marketCodes: d.marketCodes,
        channels: d.channels,
        minFontSizePt: d.minFontSizePt,
        minContrastRatio: d.minContrastRatio,
        maxProximityPct: d.maxProximityPct,
        isRequired: d.isRequired,
        severity: d.severity,
      };
    }),
  );

  const claimIdByKey = new Map<string, string>();
  await upsertRows(
    tx,
    claims,
    SEED_CLAIMS.map((c) => {
      const id = seedId('claim', brandId, c.key);
      claimIdByKey.set(c.key, id);
      return {
        id,
        orgId,
        brandId,
        text: c.text,
        variants: c.variants,
        category: c.category,
        substantiationRef: c.substantiationRef,
        substantiationUrl: c.substantiationUrl ?? null,
        jurisdictions: c.jurisdictions,
        requiredDisclaimerId: c.requiredDisclaimerKey
          ? (disclaimerIdByKey.get(c.requiredDisclaimerKey) ?? null)
          : null,
        approvedAt: new Date(c.approvedAt),
        expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
        isActive: c.isActive,
      };
    }),
  );

  /* ------------------------------------------------------------------ *
   * Image style profile — the "our photography looks like this" object,
   * fitted from the approved corpus rather than written down.
   * ------------------------------------------------------------------ */
  await upsertRows(tx, imageStyleProfiles, [
    {
      id: seedId('imagestyle', brandId, 'photography'),
      orgId,
      brandId,
      name: 'Northwind photography',
      featureStats: {
        saturation: { mean: 0.42, sd: 0.09 },
        luminance: { mean: 0.54, sd: 0.11 },
        warmth: { mean: 0.63, sd: 0.08 },
        contrast: { mean: 0.47, sd: 0.1 },
        hueSpread: { mean: 0.21, sd: 0.06 },
        depthOfField: { mean: 0.71, sd: 0.12 },
      },
      // A short synthetic centroid. Real centroids are EMBEDDING_DIM long and
      // are written by the `ontology.induce-rules` job after the corpus has
      // been embedded; this one exists so the console has something to render
      // before that job has ever run.
      centroid: [0.42, 0.54, 0.63, 0.47, 0.21, 0.71, 0.33, 0.58],
      distanceP5: 0.41,
      distanceP50: 0.22,
      sampleSize: 52,
      allowedMediums: ['photo', 'illustration'],
      prohibitedSubjects: ['alcohol', 'smoking', 'driving while drinking', 'child holding a hot drink'],
      embeddingModel: 'seed-synthetic-v1',
    },
  ]);

  /* ------------------------------------------------------------------ *
   * Brand document — the book every deductive rule cites.
   *
   * The PDF itself is not shipped, so `status` is 'extracted' with the
   * storage key recorded but no bytes behind it. The chunks below are what
   * the citation UI actually renders, and they are real.
   * ------------------------------------------------------------------ */
  const documentId = seedId('document', brandId, 'brandbook-v4.2');
  const documentHash = sha256('northwind-brand-guidelines-v4.2-2026');

  await upsertRows(tx, brandDocuments, [
    {
      id: documentId,
      orgId,
      brandId,
      name: 'Northwind Brand Guidelines v4.2 (2026)',
      kind: 'brandbook',
      storageKey: `originals/${orgId}/${documentHash.slice(0, 2)}/${documentHash}.pdf`,
      contentHash: documentHash,
      mimeType: 'application/pdf',
      pageCount: 68,
      status: 'extracted',
      extractionStats: {
        chunks: 214,
        rulesProposed: 15,
        rulesActivated: 42,
        tokensExtracted: 13,
        // Honest about what the seed contains: the metadata and the cited
        // chunks are real, the 24 MB PDF is not in the repository.
        note: 'Seeded metadata. The source PDF is not shipped with the repository.',
      },
    },
  ]);

  await upsertRows(
    tx,
    brandDocumentChunks,
    [
      {
        page: 11,
        ordinal: 2,
        heading: 'Clear space',
        text:
          'A clear space of 1.35 times the height of the logomark must be maintained on all four sides of the logo. No typography, imagery, rule or edge of the canvas may enter this area. The measurement is taken from the outermost extent of the mark, not from the bounding box of the lockup.',
        bbox: [0.1, 0.2, 0.9, 0.62],
      },
      {
        page: 15,
        ordinal: 1,
        heading: 'Logo colourways',
        text:
          'The logo appears in Espresso on light grounds and in Cream on dark grounds. Solid black and solid white are permitted where the reproduction method allows one ink only. The logo is never set in Copper, Pine or Brass, and never filled with an image or a gradient.',
        bbox: [0.1, 0.18, 0.9, 0.72],
      },
      {
        page: 22,
        ordinal: 3,
        heading: 'Using the palette',
        text:
          'Every colour used in Northwind communication comes from this palette or from a declared tint of it. Espresso and Cream carry the majority of any brand-led surface. Copper is an accent and must not exceed a fifth of the surface. Pine is reserved for sourcing and sustainability communication.',
        bbox: [0.06, 0.1, 0.94, 0.5],
      },
      {
        page: 30,
        ordinal: 1,
        heading: 'Typefaces',
        text:
          'Sole Serif Display sets headlines from 32px upward. Inter sets everything else. No third typeface appears in Northwind communication. Where a licensed face is unavailable, use the declared CSS fallback stack — never substitute a visually similar face by hand.',
        bbox: [0.08, 0.1, 0.92, 0.42],
      },
      {
        page: 49,
        ordinal: 2,
        heading: 'Imagery — what we do not show',
        text:
          'We do not show alcohol, smoking or vaping, anyone drinking while driving, or a child holding a hot drink. This applies to background detail as much as to the subject of the photograph.',
        bbox: [0.1, 0.1, 0.9, 0.6],
      },
    ].map((c) => ({
      id: seedId('chunk', documentId, c.page, c.ordinal),
      orgId,
      documentId,
      page: c.page,
      ordinal: c.ordinal,
      heading: c.heading,
      text: c.text,
      bbox: c.bbox,
      imageKey: null,
    })),
  );

  /* ------------------------------------------------------------------ *
   * Rules
   * ------------------------------------------------------------------ */
  // Before a single row: does every rule's `check.params` name keys the
  // analyzer actually reads? A key it does not read is not an error at check
  // time — the analyzer takes its default — so the rule would display one
  // threshold and enforce another, for as long as nobody read the Python.
  assertSeedRulesExecutable();

  const ruleIdByKey = new Map<string, string>();
  const ruleVersionByKey = new Map<string, number>();

  const ruleRows = SEED_RULES.map((r: SeedRule) => {
    const owningBrandId = r.brand === 'reserve' ? reserveBrandId : brandId;
    const version = r.version ?? 1;
    const id = seedId('rule', owningBrandId, r.key, version);
    ruleIdByKey.set(r.key, id);
    ruleVersionByKey.set(r.key, version);

    const isActive = r.status === 'active';
    return {
      id,
      orgId,
      brandId: owningBrandId,
      key: r.key,
      version,
      statement: r.statement,
      rationale: r.rationale,
      dimension: r.dimension,
      tier: r.tier,
      severity: r.severity,
      weight: r.weight,
      scope: r.scope ?? {},
      // Stored AND recomputed by the compiler. Seeding the same value keeps
      // the published hash stable when the ruleset is next republished.
      specificity: computeSpecificity(r.scope),
      check: r.check,
      rubric: r.rubric ?? null,
      provenance: r.provenance,
      citation: r.citation ?? null,
      support: r.support ?? null,
      status: r.status,
      effectiveFrom: isActive ? new Date('2026-03-01T00:00:00Z') : null,
      effectiveTo: null,
      calibration: r.calibration ?? null,
      optimizedPrompt: null,
      optimizedPromptHash: null,
      createdByUserId: r.provenance === 'manual' ? USERS.owner.id : null,
      // Only an activated rule has an activator. A proposed rule with an
      // activatedByUserId would be a lie in the audit trail.
      activatedByUserId: isActive ? USERS.owner.id : null,
      activatedAt: isActive ? new Date('2026-03-01T00:00:00Z') : null,
    };
  });

  await upsertRows(tx, rules, ruleRows);

  const activeRules = ruleRows.filter((r) => r.status === 'active' && r.brandId === brandId);
  const proposedRuleCount = ruleRows.filter((r) => r.status === 'proposed').length;

  /* ------------------------------------------------------------------ *
   * Brand compile — freeze the active rules and hash them.
   *
   * The compiled snapshot mirrors CompiledRule in
   * apps/api/src/rulesets/compile.ts field for field, and the hash uses the
   * same algorithm. If either drifted, republishing an unchanged ruleset
   * would mint a new version and invalidate every cached verdict.
   * ------------------------------------------------------------------ */
  // Both lists go in together, exactly as the API's compile does. The loser of
  // a key collision is NOT filtered out here: the compiled snapshot records
  // everything that was considered, and resolution picks a winner per asset —
  // a baseline rule the brand overrode is precisely what an auditor asks to
  // see. Northwind overrides several, which is what makes that visible in the
  // demo rather than only in a test.
  const compiledRules = [
    ...activeRules.map((r) => ({ ...r, origin: 'brand' as const, packKey: null as string | null })),
    ...inheritedCompileRows(COMPILED_AT).map((r) => ({
      ...r,
      // The seed writes rules with `specificity` already computed; inherited
      // rows carry an empty scope, so theirs is the empty-scope value.
      specificity: computeSpecificity(r.scope),
    })),
  ]
    .map((r) => ({
      id: r.id,
      key: r.key,
      version: r.version,
      statement: r.statement,
      rationale: r.rationale,
      dimension: r.dimension,
      tier: r.tier,
      severity: r.severity,
      weight: r.weight,
      scope: r.scope,
      specificity: r.specificity,
      check: r.check,
      rubric: r.rubric,
      provenance: r.provenance,
      citation: r.citation,
      status: r.status,
      optimizedPromptHash: r.optimizedPromptHash,
      autoRouteToHuman: Boolean(
        (r.calibration as { autoRouteToHuman?: boolean } | null)?.autoRouteToHuman,
      ),
      origin: r.origin,
      packKey: r.packKey,
      createdAt: COMPILED_AT.toISOString(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version);

  const hash = rulesetHash({
    rules: compiledRules as unknown as ReadonlyArray<Record<string, unknown>>,
    scoringConfig: SEED_SCORING_CONFIG as unknown as Record<string, unknown>,
  });

  const rulesetId = seedId('ruleset', brandId, hash);

  await upsertRows(tx, rulesets, [
    {
      id: rulesetId,
      orgId,
      brandId,
      version: 1,
      hash,
      label: 'Initial publish — seeded demo ruleset',
      compiled: {
        brandId,
        rules: compiledRules,
        scoringConfig: SEED_SCORING_CONFIG,
        ruleCount: compiledRules.length,
        hash,
      },
      ruleCount: compiledRules.length,
      scoringConfig: SEED_SCORING_CONFIG,
      publishedByUserId: USERS.owner.id,
      publishedAt: new Date('2026-03-01T09:30:00Z'),
    },
  ]);

  await tx.update(brands).set({ activeRulesetId: rulesetId }).where(eq(brands.id, brandId));

  return {
    brandId,
    reserveBrandId,
    rulesetId,
    rulesetHash: hash,
    activeRuleCount: compiledRules.length,
    proposedRuleCount,
    logos,
    logoStorageKeys,
    ruleIdByKey,
    ruleVersionByKey,
    claimIdByKey,
    disclaimerIdByKey,
    documentId,
  };
}
