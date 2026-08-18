import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@brandlens/db';
import type { EngineBrandContext } from '@brandlens/contracts';
import {
  brands,
  channelSpecs,
  claims,
  designTokens,
  disclaimers,
  forbiddenFonts,
  imageStyleProfiles,
  lexiconTerms,
  logoVariants,
  typeStyles,
  voiceAttributes,
} from '@brandlens/db';
import type { StorageService } from './storage.service';

export interface BrandContextOptions {
  market?: string | null;
  channel?: string | null;
  assetType?: string | null;
  platform?: string | null;
  placement?: string | null;
}

/**
 * Flattens the tenant's ontology into what the analyzers need.
 *
 * Mirrors the API's `BrandContextBuilder` because the engine is stateless and
 * both processes have to hand it a complete payload. Filtering by market and
 * channel happens here rather than in the engine: a global brand with 40
 * markets would otherwise ship 40× the disclaimers it can possibly need on
 * every single call.
 */
export async function buildBrandContext(
  tx: Database,
  storage: StorageService,
  brandId: string,
  options: BrandContextOptions = {},
): Promise<EngineBrandContext> {
  const [brand] = await tx.select().from(brands).where(eq(brands.id, brandId)).limit(1);

  const tokens = await tx.select().from(designTokens).where(eq(designTokens.brandId, brandId));
  const logos = await tx
    .select()
    .from(logoVariants)
    .where(and(eq(logoVariants.brandId, brandId), eq(logoVariants.isActive, true)));
  const types = await tx.select().from(typeStyles).where(eq(typeStyles.brandId, brandId));
  const badFonts = await tx.select().from(forbiddenFonts).where(eq(forbiddenFonts.brandId, brandId));
  const voice = await tx.select().from(voiceAttributes).where(eq(voiceAttributes.brandId, brandId));
  const lexicon = await tx.select().from(lexiconTerms).where(eq(lexiconTerms.brandId, brandId));
  const claimRows = await tx.select().from(claims).where(and(eq(claims.brandId, brandId), eq(claims.isActive, true)));
  const disclaimerRows = await tx.select().from(disclaimers).where(eq(disclaimers.brandId, brandId));
  const [styleProfile] = await tx
    .select()
    .from(imageStyleProfiles)
    .where(eq(imageStyleProfiles.brandId, brandId))
    .limit(1);

  let spec: Record<string, unknown> | null = null;
  if (options.platform && options.placement) {
    const rows = await tx
      .select({ spec: channelSpecs.spec })
      .from(channelSpecs)
      .where(
        and(
          eq(channelSpecs.platform, options.platform),
          eq(channelSpecs.placement, options.placement),
          eq(channelSpecs.assetType, options.assetType ?? 'image'),
        ),
      )
      // A tenant override beats the shipped registry row.
      .orderBy(sql`${channelSpecs.orgId} NULLS LAST`)
      .limit(1);
    spec = (rows[0]?.spec as Record<string, unknown>) ?? null;
  }

  const market = options.market ?? null;
  const channel = options.channel ?? null;

  return {
    brandId,
    name: brand?.name ?? 'Unknown brand',
    positioning: brand?.positioning ?? undefined,

    colorTokens: tokens
      .filter((t) => t.type === 'color' && t.hex)
      .map((t) => ({
        path: t.path,
        hex: t.hex as string,
        // Lab was precomputed at import time; analyzers must never re-derive
        // it inside a per-pixel-cluster loop.
        lab:
          t.labL !== null && t.labA !== null && t.labB !== null
            ? ([t.labL, t.labA, t.labB] as [number, number, number])
            : undefined,
        role: t.role ?? undefined,
        allowedTints: t.allowedTints ?? undefined,
        usage: t.usage ?? {},
      })),

    forbiddenColors: tokens
      .filter((t) => t.role === 'forbidden' && t.hex)
      .map((t) => ({ hex: t.hex as string, reason: t.description ?? undefined })),

    logoVariants: logos.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      uri: storage.engineUri(l.storageKey),
      aspectRatio: l.aspectRatio,
      logomarkHeightPx: l.logomarkHeightPx,
      palette: l.palette ?? [],
      constraints: l.constraints ?? {},
    })),

    typeStyles: types.map((t) => ({
      name: t.name,
      role: t.role,
      fontFamily: t.fontFamily,
      fontAliases: t.fontAliases ?? [],
      fontWeight: t.fontWeight,
      minSizePx: t.minSizePx,
      minSizePt: t.minSizePt,
      minSizePctOfCanvas: t.minSizePctOfCanvas,
      lineHeightRatio: t.lineHeightRatio,
      scaleRank: t.scaleRank,
      casingRules: t.casingRules ?? {},
    })),

    forbiddenFonts: badFonts.map((f) => ({ fontFamily: f.fontFamily, reason: f.reason ?? undefined })),

    voiceAttributes: voice.map((v) => ({
      name: v.name,
      weAre: v.weAre,
      weAreNot: v.weAreNot,
      positiveExamples: v.positiveExamples ?? [],
      negativeExamples: v.negativeExamples ?? [],
      weight: v.weight,
    })),

    lexicon: lexicon
      .filter((t) => marketApplies(t.marketCodes, market))
      .map((t) => ({
        term: t.term,
        kind: t.kind as 'banned' | 'required' | 'preferred' | 'trademark',
        replacement: t.replacement,
        caseSensitive: t.caseSensitive,
        matchWholeWord: t.matchWholeWord,
        allowFuzzy: t.allowFuzzy,
        severity: t.severity,
        marketCodes: t.marketCodes,
      })),

    claims: claimRows.map((c) => ({
      id: c.id,
      text: c.text,
      variants: c.variants ?? [],
      category: c.category,
      jurisdictions: c.jurisdictions ?? [],
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      requiredDisclaimerId: c.requiredDisclaimerId,
      isActive: c.isActive,
    })),

    disclaimers: disclaimerRows
      .filter((d) => marketApplies(d.marketCodes, market) && channelApplies(d.channels, channel))
      .map((d) => ({
        id: d.id,
        name: d.name,
        text: d.text,
        marketCodes: d.marketCodes,
        channels: d.channels,
        minFontSizePt: d.minFontSizePt,
        minContrastRatio: d.minContrastRatio,
        maxProximityPct: d.maxProximityPct,
        severity: d.severity,
      })),

    imageStyleProfile: styleProfile
      ? {
          featureStats: styleProfile.featureStats ?? {},
          centroid: styleProfile.centroid,
          distanceP5: styleProfile.distanceP5,
          distanceP50: styleProfile.distanceP50,
          allowedMediums: styleProfile.allowedMediums,
          prohibitedSubjects: styleProfile.prohibitedSubjects,
        }
      : null,

    channelSpec: spec,
  };
}

function marketApplies(codes: string[] | null, market: string | null): boolean {
  if (!codes || codes.length === 0) return true;
  if (!market) return true;
  return codes.includes(market) || codes.includes('*');
}

function channelApplies(channels: string[] | null, channel: string | null): boolean {
  if (!channels || channels.length === 0) return true;
  if (!channel) return true;
  return channels.includes(channel) || channels.includes('*');
}
