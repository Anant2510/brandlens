import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportTokensInput, UpsertTokenInput } from '@brandlens/contracts';
import {
  brandDocumentChunks,
  brandDocuments,
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
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../brands/brands.service';
import { StorageService } from '../storage/storage.service';
import { hexToLab } from '../common/color';
import { normalizeTokens, type ImportFormat } from './tokens/token-normalizer';
import {
  CreateClaimInput,
  CreateDisclaimerInput,
  CreateLexiconTermInput,
  CreateLogoInput,
  CreateTypeStyleInput,
  CreateVoiceAttributeInput,
  UpdateTypeStyleInput,
  UpsertImageStyleProfileInput,
} from './ontology.dto';

@Injectable()
export class OntologyService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /* ---------------------------------------------------------------- tokens */

  async listTokens(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(designTokens).where(eq(designTokens.brandId, brandId)).orderBy(asc(designTokens.path)),
    );
  }

  async upsertToken(orgId: string, brandId: string, input: z.infer<typeof UpsertTokenInput>) {
    await this.brands.requireBrand(orgId, brandId);
    const lab = input.hex ? hexToLab(input.hex) : null;

    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(designTokens)
        .values({
          orgId,
          brandId,
          path: input.path,
          type: input.type,
          value: input.value ?? null,
          description: input.description ?? null,
          hex: input.hex ?? null,
          labL: lab?.[0] ?? null,
          labA: lab?.[1] ?? null,
          labB: lab?.[2] ?? null,
          role: input.role ?? null,
          allowedTints: input.allowedTints ?? null,
          usage: (input.usage ?? {}) as Record<string, unknown>,
          source: 'manual',
        })
        .onConflictDoUpdate({
          target: [designTokens.brandId, designTokens.path],
          set: {
            type: input.type,
            value: input.value ?? null,
            description: input.description ?? null,
            hex: input.hex ?? null,
            labL: lab?.[0] ?? null,
            labA: lab?.[1] ?? null,
            labB: lab?.[2] ?? null,
            role: input.role ?? null,
            allowedTints: input.allowedTints ?? null,
            usage: (input.usage ?? {}) as Record<string, unknown>,
            updatedAt: new Date(),
          },
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'token.upsert',
        entityType: 'design_token',
        entityId: row.id,
        payload: { brandId, path: input.path, type: input.type },
      });
      return row;
    });
  }

  /**
   * Bulk import. Normalises to DTCG and precomputes hex → Lab before the rows
   * are written, so palette conformance at check time is a pure array scan.
   */
  async importTokens(orgId: string, brandId: string, input: z.infer<typeof ImportTokensInput>) {
    await this.brands.requireBrand(orgId, brandId);
    const normalized = normalizeTokens(input.format as ImportFormat, input.payload);

    return this.repo.run(async (tx) => {
      if (input.replace) {
        await tx.delete(designTokens).where(eq(designTokens.brandId, brandId));
      }

      let written = 0;
      for (const token of normalized) {
        if (!token.path) continue;
        await tx
          .insert(designTokens)
          .values({
            orgId,
            brandId,
            path: token.path.slice(0, 300),
            type: token.type,
            value: (token.value ?? null) as unknown,
            description: token.description ?? null,
            hex: token.hex ?? null,
            labL: token.lab?.[0] ?? null,
            labA: token.lab?.[1] ?? null,
            labB: token.lab?.[2] ?? null,
            source: input.format,
          })
          .onConflictDoUpdate({
            target: [designTokens.brandId, designTokens.path],
            set: {
              type: token.type,
              value: (token.value ?? null) as unknown,
              hex: token.hex ?? null,
              labL: token.lab?.[0] ?? null,
              labA: token.lab?.[1] ?? null,
              labB: token.lab?.[2] ?? null,
              source: input.format,
              updatedAt: new Date(),
            },
          });
        written += 1;
      }

      await this.audit.recordIn(tx, {
        action: 'token.import',
        entityType: 'brand',
        entityId: brandId,
        payload: { format: input.format, replace: input.replace, count: written },
      });

      return { imported: written, format: input.format, replaced: input.replace };
    });
  }

  async deleteToken(orgId: string, brandId: string, tokenId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const deleted = await tx
        .delete(designTokens)
        .where(and(eq(designTokens.id, tokenId), eq(designTokens.brandId, brandId)))
        .returning({ id: designTokens.id });
      if (!deleted.length) throw new NotFoundException('Token not found');
      await this.audit.recordIn(tx, { action: 'token.delete', entityType: 'design_token', entityId: tokenId });
      return { id: tokenId, deleted: true as const };
    });
  }

  /* ----------------------------------------------------------------- logos */

  async listLogos(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    const rows = await this.repo.run((tx) =>
      tx.select().from(logoVariants).where(eq(logoVariants.brandId, brandId)).orderBy(asc(logoVariants.name)),
    );
    return Promise.all(
      rows.map(async (r) => ({ ...r, previewUrl: await this.storage.signedUrl(r.storageKey).catch(() => null) })),
    );
  }

  async createLogo(
    orgId: string,
    brandId: string,
    input: z.infer<typeof CreateLogoInput>,
    file?: { buffer: Buffer; mimetype?: string; originalname?: string },
  ) {
    await this.brands.requireBrand(orgId, brandId);

    let storageKey = input.storageKey ?? '';
    let contentHash = input.contentHash ?? '';
    let mimeType = input.mimeType ?? file?.mimetype ?? null;

    if (file) {
      const ext = (file.originalname?.split('.').pop() ?? 'png').toLowerCase();
      const stored = await this.storage.putContentAddressed('originals', orgId, file.buffer, ext, {
        contentType: file.mimetype,
      });
      storageKey = stored.key;
      contentHash = stored.hash;
      mimeType = file.mimetype ?? mimeType;
    }
    if (!storageKey || !contentHash) {
      throw new NotFoundException('A logo file (multipart `file`) or an existing storageKey+contentHash is required');
    }

    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(logoVariants)
        .values({
          orgId,
          brandId,
          name: input.name,
          kind: input.kind,
          storageKey,
          contentHash,
          mimeType,
          width: input.width ?? null,
          height: input.height ?? null,
          aspectRatio: input.aspectRatio ?? (input.width && input.height ? input.width / input.height : null),
          // The "X" unit every brand book expresses clear space in.
          logomarkHeightPx: input.logomarkHeightPx ?? null,
          palette: input.palette ?? [],
          constraints: (input.constraints ?? {}) as Record<string, unknown>,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'logo.create',
        entityType: 'logo_variant',
        entityId: row.id,
        payload: { brandId, name: input.name, kind: input.kind },
      });
      return row;
    });
  }

  async deleteLogo(orgId: string, brandId: string, logoId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const deleted = await tx
        .delete(logoVariants)
        .where(and(eq(logoVariants.id, logoId), eq(logoVariants.brandId, brandId)))
        .returning({ id: logoVariants.id });
      if (!deleted.length) throw new NotFoundException('Logo not found');
      await this.audit.recordIn(tx, { action: 'logo.delete', entityType: 'logo_variant', entityId: logoId });
      return { id: logoId, deleted: true as const };
    });
  }

  /* ----------------------------------------------------------- type styles */

  async listTypeStyles(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(typeStyles).where(eq(typeStyles.brandId, brandId)).orderBy(asc(typeStyles.scaleRank)),
    );
  }

  async createTypeStyle(orgId: string, brandId: string, input: z.infer<typeof CreateTypeStyleInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(typeStyles)
        .values({
          orgId,
          brandId,
          name: input.name,
          role: input.role,
          fontFamily: input.fontFamily,
          // Aliases turn open-set font identification into closed-set
          // verification: a tenant has 3–10 faces, each with many PostScript
          // names, and matching by alias is exact where matching by look is not.
          fontAliases: input.fontAliases ?? [],
          fontWeight: input.fontWeight,
          isItalic: input.isItalic ?? false,
          minSizePx: input.minSizePx ?? null,
          minSizePt: input.minSizePt ?? null,
          minSizePctOfCanvas: input.minSizePctOfCanvas ?? null,
          maxSizePx: input.maxSizePx ?? null,
          lineHeightRatio: input.lineHeightRatio ?? null,
          letterSpacingEm: input.letterSpacingEm ?? null,
          casingRules: (input.casingRules ?? {}) as Record<string, unknown>,
          scaleRank: input.scaleRank ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'type_style.create',
        entityType: 'type_style',
        entityId: row.id,
        payload: { brandId, name: input.name },
      });
      return row;
    });
  }

  async updateTypeStyle(orgId: string, brandId: string, id: string, input: z.infer<typeof UpdateTypeStyleInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .update(typeStyles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
          ...(input.fontAliases !== undefined ? { fontAliases: input.fontAliases } : {}),
          ...(input.fontWeight !== undefined ? { fontWeight: input.fontWeight } : {}),
          ...(input.isItalic !== undefined ? { isItalic: input.isItalic } : {}),
          ...(input.minSizePx !== undefined ? { minSizePx: input.minSizePx } : {}),
          ...(input.minSizePt !== undefined ? { minSizePt: input.minSizePt } : {}),
          ...(input.minSizePctOfCanvas !== undefined ? { minSizePctOfCanvas: input.minSizePctOfCanvas } : {}),
          ...(input.lineHeightRatio !== undefined ? { lineHeightRatio: input.lineHeightRatio } : {}),
          ...(input.scaleRank !== undefined ? { scaleRank: input.scaleRank } : {}),
          ...(input.casingRules !== undefined ? { casingRules: input.casingRules as Record<string, unknown> } : {}),
        })
        .where(and(eq(typeStyles.id, id), eq(typeStyles.brandId, brandId)))
        .returning();
      if (!row) throw new NotFoundException('Type style not found');
      await this.audit.recordIn(tx, { action: 'type_style.update', entityType: 'type_style', entityId: id });
      return row;
    });
  }

  async deleteTypeStyle(orgId: string, brandId: string, id: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const deleted = await tx
        .delete(typeStyles)
        .where(and(eq(typeStyles.id, id), eq(typeStyles.brandId, brandId)))
        .returning({ id: typeStyles.id });
      if (!deleted.length) throw new NotFoundException('Type style not found');
      await this.audit.recordIn(tx, { action: 'type_style.delete', entityType: 'type_style', entityId: id });
      return { id, deleted: true as const };
    });
  }

  async listForbiddenFonts(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) => tx.select().from(forbiddenFonts).where(eq(forbiddenFonts.brandId, brandId)));
  }

  /* ----------------------------------------------------------------- voice */

  async listVoice(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(voiceAttributes).where(eq(voiceAttributes.brandId, brandId)).orderBy(asc(voiceAttributes.name)),
    );
  }

  async createVoice(orgId: string, brandId: string, input: z.infer<typeof CreateVoiceAttributeInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(voiceAttributes)
        .values({
          orgId,
          brandId,
          name: input.name,
          // "Confident, not arrogant" is unusable as a check until it has both
          // poles plus exemplars; the schema makes that non-optional.
          weAre: input.weAre,
          weAreNot: input.weAreNot,
          positiveExamples: input.positiveExamples ?? [],
          negativeExamples: input.negativeExamples ?? [],
          weight: input.weight ?? 1,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'voice.create',
        entityType: 'voice_attribute',
        entityId: row.id,
        payload: { brandId, name: input.name },
      });
      return row;
    });
  }

  /* --------------------------------------------------------------- lexicon */

  async listLexicon(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(lexiconTerms).where(eq(lexiconTerms.brandId, brandId)).orderBy(asc(lexiconTerms.term)),
    );
  }

  async createLexiconTerm(orgId: string, brandId: string, input: z.infer<typeof CreateLexiconTermInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(lexiconTerms)
        .values({
          orgId,
          brandId,
          term: input.term,
          kind: input.kind,
          replacement: input.replacement ?? null,
          caseSensitive: input.caseSensitive ?? false,
          matchWholeWord: input.matchWholeWord ?? true,
          allowFuzzy: input.allowFuzzy ?? true,
          severity: input.severity ?? 'minor',
          marketCodes: input.marketCodes ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'lexicon.create',
        entityType: 'lexicon_term',
        entityId: row.id,
        payload: { brandId, term: input.term, kind: input.kind },
      });
      return row;
    });
  }

  /* ---------------------------------------------------------------- claims */

  async listClaims(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) => tx.select().from(claims).where(eq(claims.brandId, brandId)).orderBy(asc(claims.text)));
  }

  async createClaim(orgId: string, brandId: string, input: z.infer<typeof CreateClaimInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(claims)
        .values({
          orgId,
          brandId,
          text: input.text,
          variants: input.variants ?? [],
          category: input.category ?? null,
          substantiationRef: input.substantiationRef ?? null,
          substantiationUrl: input.substantiationUrl ?? null,
          jurisdictions: input.jurisdictions ?? [],
          requiredDisclaimerId: input.requiredDisclaimerId ?? null,
          approvedAt: input.approvedAt ? new Date(input.approvedAt) : null,
          // An expiry date is what turns a claims register from a document
          // into a control: expired substantiation is the classic MLR finding.
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'claim.create',
        entityType: 'claim',
        entityId: row.id,
        payload: { brandId, category: input.category },
      });
      return row;
    });
  }

  /* ----------------------------------------------------------- disclaimers */

  async listDisclaimers(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(disclaimers).where(eq(disclaimers.brandId, brandId)).orderBy(asc(disclaimers.name)),
    );
  }

  async createDisclaimer(orgId: string, brandId: string, input: z.infer<typeof CreateDisclaimerInput>) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(disclaimers)
        .values({
          orgId,
          brandId,
          name: input.name,
          text: input.text,
          marketCodes: input.marketCodes ?? null,
          channels: input.channels ?? null,
          // Presence is the easy check. Size, contrast and proximity to the
          // claim being qualified are the ones that actually get cited.
          minFontSizePt: input.minFontSizePt ?? 8,
          minContrastRatio: input.minContrastRatio ?? 4.5,
          maxProximityPct: input.maxProximityPct ?? 0.25,
          isRequired: input.isRequired ?? true,
          severity: input.severity ?? 'blocker',
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'disclaimer.create',
        entityType: 'disclaimer',
        entityId: row.id,
        payload: { brandId, name: input.name },
      });
      return row;
    });
  }

  /* -------------------------------------------------- image style profiles */

  async getImageStyleProfile(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    const rows = await this.repo.run((tx) =>
      tx.select().from(imageStyleProfiles).where(eq(imageStyleProfiles.brandId, brandId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async upsertImageStyleProfile(orgId: string, brandId: string, input: z.infer<typeof UpsertImageStyleProfileInput>) {
    await this.brands.requireBrand(orgId, brandId);
    const existing = await this.getImageStyleProfile(orgId, brandId);
    return this.repo.run(async (tx) => {
      if (existing) {
        const [row] = await tx
          .update(imageStyleProfiles)
          .set({
            name: input.name,
            featureStats: (input.featureStats ?? {}) as Record<string, unknown>,
            centroid: input.centroid ?? null,
            distanceP5: input.distanceP5 ?? null,
            distanceP50: input.distanceP50 ?? null,
            sampleSize: input.sampleSize ?? 0,
            allowedMediums: input.allowedMediums ?? null,
            prohibitedSubjects: input.prohibitedSubjects ?? null,
            embeddingModel: input.embeddingModel ?? null,
            updatedAt: new Date(),
          })
          .where(eq(imageStyleProfiles.id, existing.id))
          .returning();
        return row;
      }
      const [row] = await tx
        .insert(imageStyleProfiles)
        .values({
          orgId,
          brandId,
          name: input.name,
          featureStats: (input.featureStats ?? {}) as Record<string, unknown>,
          centroid: input.centroid ?? null,
          distanceP5: input.distanceP5 ?? null,
          distanceP50: input.distanceP50 ?? null,
          sampleSize: input.sampleSize ?? 0,
          allowedMediums: input.allowedMediums ?? null,
          prohibitedSubjects: input.prohibitedSubjects ?? null,
          embeddingModel: input.embeddingModel ?? null,
        })
        .returning();
      return row;
    });
  }

  /* ------------------------------------------------------------- documents */

  async listDocuments(orgId: string, brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.repo.run((tx) =>
      tx.select().from(brandDocuments).where(eq(brandDocuments.brandId, brandId)).orderBy(asc(brandDocuments.name)),
    );
  }

  async createDocument(
    orgId: string,
    brandId: string,
    input: { name: string; kind?: string },
    file: { buffer: Buffer; mimetype?: string; originalname?: string },
  ) {
    await this.brands.requireBrand(orgId, brandId);
    const ext = (file.originalname?.split('.').pop() ?? 'pdf').toLowerCase();
    const stored = await this.storage.putContentAddressed('originals', orgId, file.buffer, ext, {
      contentType: file.mimetype,
    });

    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(brandDocuments)
        .values({
          orgId,
          brandId,
          name: input.name || (file.originalname ?? 'document'),
          kind: input.kind ?? 'brandbook',
          storageKey: stored.key,
          contentHash: stored.hash,
          mimeType: file.mimetype ?? null,
          status: 'uploaded',
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'document.create',
        entityType: 'brand_document',
        entityId: row.id,
        payload: { brandId, name: row.name, kind: row.kind },
      });
      return row;
    });
  }

  async getDocument(orgId: string, brandId: string, documentId: string) {
    await this.brands.requireBrand(orgId, brandId);
    const rows = await this.repo.run((tx) =>
      tx
        .select()
        .from(brandDocuments)
        .where(and(eq(brandDocuments.id, documentId), eq(brandDocuments.brandId, brandId)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException('Document not found');
    return rows[0];
  }

  async documentChunks(orgId: string, documentId: string) {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(brandDocumentChunks)
        .where(eq(brandDocumentChunks.documentId, documentId))
        .orderBy(asc(brandDocumentChunks.page), asc(brandDocumentChunks.ordinal))
        .limit(2000),
    );
  }

  /** Counts used by `/health/deep` and the readiness widget. */
  async ontologyCounts(orgId: string, brandId: string): Promise<Record<string, number>> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const one = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
      return {
        tokens: await one(
          tx.select({ n: sql<number>`count(*)::int` }).from(designTokens).where(eq(designTokens.brandId, brandId)),
        ),
        logos: await one(
          tx.select({ n: sql<number>`count(*)::int` }).from(logoVariants).where(eq(logoVariants.brandId, brandId)),
        ),
        typeStyles: await one(
          tx.select({ n: sql<number>`count(*)::int` }).from(typeStyles).where(eq(typeStyles.brandId, brandId)),
        ),
      };
    });
  }
}
