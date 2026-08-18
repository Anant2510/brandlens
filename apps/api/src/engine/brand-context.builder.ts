import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
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
import { TenantRepository } from '../database/tenant.repository';
import { StorageService } from '../storage/storage.service';

export interface BrandContextOptions {
  market?: string | null;
  channel?: string | null;
  assetType?: string | null;
  /** Platform/placement for the channel-spec lookup, e.g. `meta`/`feed`. */
  platform?: string | null;
  placement?: string | null;
}

/**
 * Flattens the tenant's ontology into exactly what the analyzers need.
 *
 * The engine is stateless, so this payload has to be complete — but it also
 * has to be small, because it is serialised on every analyze call. So we
 * filter by market and channel HERE rather than shipping the whole ontology
 * and letting the engine sort it out: a global brand with 40 markets would
 * otherwise send 40× the disclaimers it can possibly need.
 */
@Injectable()
export class BrandContextBuilder {
  constructor(
    private readonly repo: TenantRepository,
    private readonly storage: StorageService,
  ) {}

  async build(orgId: string, brandId: string, options: BrandContextOptions = {}): Promise<EngineBrandContext> {
    const data = await this.repo.runAs(orgId, undefined, async (tx) => {
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

      const claimRows = await tx
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.brandId, brandId),
            eq(claims.isActive, true),
            // An expired claim is still worth sending: the check that matters
            // is "this asset uses a claim whose substantiation lapsed".
            or(isNull(claims.expiresAt), gt(claims.expiresAt, new Date(Date.now() - 365 * 86_400_000))),
          ),
        );

      const disclaimerRows = await tx.select().from(disclaimers).where(eq(disclaimers.brandId, brandId));
      const [styleProfile] = await tx
        .select()
        .from(imageStyleProfiles)
        .where(eq(imageStyleProfiles.brandId, brandId))
        .limit(1);

      let spec: Record<string, unknown> | null = null;
      if (options.platform && options.placement) {
        const rows = await tx
          .select({ spec: channelSpecs.spec, orgId: channelSpecs.orgId })
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

      return { brand, tokens, logos, types, badFonts, voice, lexicon, claimRows, disclaimerRows, styleProfile, spec };
    });

    const market = options.market ?? null;
    const channel = options.channel ?? null;

    const logoUris = await Promise.all(
      data.logos.map(async (l) => ({ id: l.id, uri: await this.storage.engineUri(l.storageKey).catch(() => '') })),
    );
    const uriById = new Map(logoUris.map((l) => [l.id, l.uri]));

    return {
      brandId,
      name: data.brand?.name ?? 'Unknown brand',
      positioning: data.brand?.positioning ?? undefined,

      colorTokens: data.tokens
        .filter((t) => t.type === 'color' && t.hex)
        .map((t) => ({
          path: t.path,
          hex: t.hex as string,
          // Lab was precomputed at import time; the analyzers must never have
          // to re-derive it inside a per-pixel-cluster loop.
          lab:
            t.labL !== null && t.labA !== null && t.labB !== null
              ? ([t.labL, t.labA, t.labB] as [number, number, number])
              : undefined,
          role: t.role ?? undefined,
          allowedTints: t.allowedTints ?? undefined,
          usage: t.usage ?? {},
        })),

      forbiddenColors: data.tokens
        .filter((t) => t.role === 'forbidden' && t.hex)
        .map((t) => ({ hex: t.hex as string, reason: t.description ?? undefined })),

      logoVariants: data.logos.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        uri: uriById.get(l.id) ?? '',
        aspectRatio: l.aspectRatio,
        logomarkHeightPx: l.logomarkHeightPx,
        palette: l.palette ?? [],
        constraints: l.constraints ?? {},
      })),

      typeStyles: data.types.map((t) => ({
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

      forbiddenFonts: data.badFonts.map((f) => ({ fontFamily: f.fontFamily, reason: f.reason ?? undefined })),

      voiceAttributes: data.voice.map((v) => ({
        name: v.name,
        weAre: v.weAre,
        weAreNot: v.weAreNot,
        positiveExamples: v.positiveExamples ?? [],
        negativeExamples: v.negativeExamples ?? [],
        weight: v.weight,
      })),

      lexicon: data.lexicon
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

      claims: data.claimRows.map((c) => ({
        id: c.id,
        text: c.text,
        variants: c.variants ?? [],
        category: c.category,
        jurisdictions: c.jurisdictions ?? [],
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        requiredDisclaimerId: c.requiredDisclaimerId,
        isActive: c.isActive,
      })),

      disclaimers: data.disclaimerRows
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

      imageStyleProfile: data.styleProfile
        ? {
            featureStats: data.styleProfile.featureStats ?? {},
            centroid: data.styleProfile.centroid,
            distanceP5: data.styleProfile.distanceP5,
            distanceP50: data.styleProfile.distanceP50,
            allowedMediums: data.styleProfile.allowedMediums,
            prohibitedSubjects: data.styleProfile.prohibitedSubjects,
          }
        : null,

      channelSpec: data.spec,
    };
  }
}

/** Null/empty market list means "every market". */
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
