import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CreateBrandInput, UpdateBrandInput } from '@brandlens/contracts';
import {
  assets,
  brands,
  checkRuns,
  claims,
  designTokens,
  disclaimers,
  findings,
  logoVariants,
  rules,
  rulesets,
  typeStyles,
  voiceAttributes,
} from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';

export interface BrandDto {
  id: string;
  orgId: string;
  parentBrandId: string | null;
  name: string;
  slug: string;
  description: string | null;
  positioning: string | null;
  activeRulesetId: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrandOverview extends BrandDto {
  counts: {
    tokens: number;
    logos: number;
    typeStyles: number;
    voiceAttributes: number;
    claims: number;
    disclaimers: number;
    rulesActive: number;
    rulesProposed: number;
    assets: number;
  };
  activeRuleset: { id: string; version: number; hash: string; ruleCount: number; publishedAt: string } | null;
  recentChecks: Array<{ id: string; score: number | null; scoreBand: string | null; createdAt: string }>;
  openFindings: number;
  /** Onboarding progress — the thing the empty-state UI renders. */
  readiness: { hasTokens: boolean; hasLogos: boolean; hasRules: boolean; hasRuleset: boolean; percent: number };
}

@Injectable()
export class BrandsService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<BrandDto[]> {
    const rows = await this.repo.run((tx) =>
      tx
        .select()
        .from(brands)
        .where(and(eq(brands.orgId, orgId), isNull(brands.deletedAt)))
        .orderBy(brands.name),
    );
    return rows.map(toDto);
  }

  async get(orgId: string, brandId: string): Promise<BrandDto> {
    const row = await this.findRow(orgId, brandId);
    return toDto(row);
  }

  /** Shared by every module that has to prove a brand belongs to the tenant. */
  async requireBrand(orgId: string, brandId: string): Promise<BrandDto> {
    return this.get(orgId, brandId);
  }

  async create(orgId: string, userId: string | undefined, input: z.infer<typeof CreateBrandInput>): Promise<BrandDto> {
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .insert(brands)
        .values({
          orgId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          positioning: input.positioning ?? null,
          parentBrandId: input.parentBrandId ?? null,
        })
        .returning();
      await this.audit.recordIn(tx, {
        action: 'brand.create',
        entityType: 'brand',
        entityId: row.id,
        payload: { name: input.name, slug: input.slug },
      });
      return toDto(row);
    });
  }

  async update(orgId: string, brandId: string, input: z.infer<typeof UpdateBrandInput>): Promise<BrandDto> {
    await this.findRow(orgId, brandId);
    return this.repo.run(async (tx) => {
      const [row] = await tx
        .update(brands)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.positioning !== undefined ? { positioning: input.positioning } : {}),
          ...(input.parentBrandId !== undefined ? { parentBrandId: input.parentBrandId } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId)))
        .returning();
      await this.audit.recordIn(tx, {
        action: 'brand.update',
        entityType: 'brand',
        entityId: brandId,
        payload: input as Record<string, unknown>,
      });
      return toDto(row);
    });
  }

  /**
   * Soft delete. Check runs, decision traces and the audit trail must survive
   * the deletion of the brand they refer to — a regulator asking "why was this
   * approved in 2024" does not accept "we deleted the brand".
   */
  async remove(orgId: string, brandId: string): Promise<{ id: string; deleted: true }> {
    await this.findRow(orgId, brandId);
    return this.repo.run(async (tx) => {
      await tx
        .update(brands)
        .set({ deletedAt: new Date() })
        .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId)));
      await this.audit.recordIn(tx, { action: 'brand.delete', entityType: 'brand', entityId: brandId });
      return { id: brandId, deleted: true as const };
    });
  }

  async overview(orgId: string, brandId: string): Promise<BrandOverview> {
    const brand = await this.findRow(orgId, brandId);

    return this.repo.run(async (tx) => {
      const [tokenCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(designTokens)
        .where(eq(designTokens.brandId, brandId));
      const [logoCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(logoVariants)
        .where(eq(logoVariants.brandId, brandId));
      const [typeCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(typeStyles)
        .where(eq(typeStyles.brandId, brandId));
      const [voiceCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(voiceAttributes)
        .where(eq(voiceAttributes.brandId, brandId));
      const [claimCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(claims)
        .where(eq(claims.brandId, brandId));
      const [disclaimerCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(disclaimers)
        .where(eq(disclaimers.brandId, brandId));
      const [activeRules] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.status, 'active')));
      const [proposedRules] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(rules)
        .where(and(eq(rules.brandId, brandId), eq(rules.status, 'proposed')));
      const [assetCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(assets)
        .where(and(eq(assets.brandId, brandId), isNull(assets.deletedAt)));
      const [openFindingCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(findings)
        .innerJoin(checkRuns, eq(checkRuns.id, findings.checkRunId))
        .where(and(eq(checkRuns.brandId, brandId), eq(findings.status, 'open')));

      const recent = await tx
        .select({
          id: checkRuns.id,
          score: checkRuns.score,
          scoreBand: checkRuns.scoreBand,
          createdAt: checkRuns.createdAt,
        })
        .from(checkRuns)
        .where(eq(checkRuns.brandId, brandId))
        .orderBy(desc(checkRuns.createdAt))
        .limit(10);

      let activeRuleset: BrandOverview['activeRuleset'] = null;
      if (brand.activeRulesetId) {
        const [rs] = await tx
          .select({
            id: rulesets.id,
            version: rulesets.version,
            hash: rulesets.hash,
            ruleCount: rulesets.ruleCount,
            publishedAt: rulesets.publishedAt,
          })
          .from(rulesets)
          .where(eq(rulesets.id, brand.activeRulesetId))
          .limit(1);
        if (rs) {
          activeRuleset = { ...rs, publishedAt: rs.publishedAt.toISOString() };
        }
      }

      const readinessFlags = {
        hasTokens: (tokenCount?.n ?? 0) > 0,
        hasLogos: (logoCount?.n ?? 0) > 0,
        hasRules: (activeRules?.n ?? 0) > 0,
        hasRuleset: Boolean(activeRuleset),
      };
      const percent = Math.round((Object.values(readinessFlags).filter(Boolean).length / 4) * 100);

      return {
        ...toDto(brand),
        counts: {
          tokens: tokenCount?.n ?? 0,
          logos: logoCount?.n ?? 0,
          typeStyles: typeCount?.n ?? 0,
          voiceAttributes: voiceCount?.n ?? 0,
          claims: claimCount?.n ?? 0,
          disclaimers: disclaimerCount?.n ?? 0,
          rulesActive: activeRules?.n ?? 0,
          rulesProposed: proposedRules?.n ?? 0,
          assets: assetCount?.n ?? 0,
        },
        activeRuleset,
        recentChecks: recent.map((r) => ({
          id: r.id,
          score: r.score,
          scoreBand: r.scoreBand,
          createdAt: r.createdAt.toISOString(),
        })),
        openFindings: openFindingCount?.n ?? 0,
        readiness: { ...readinessFlags, percent },
      };
    });
  }

  private async findRow(orgId: string, brandId: string) {
    const rows = await this.repo.run((tx) =>
      tx
        .select()
        .from(brands)
        .where(and(eq(brands.id, brandId), eq(brands.orgId, orgId), isNull(brands.deletedAt)))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException(`Brand ${brandId} not found`);
    return rows[0];
  }
}

function toDto(row: typeof brands.$inferSelect): BrandDto {
  return {
    id: row.id,
    orgId: row.orgId,
    parentBrandId: row.parentBrandId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    positioning: row.positioning,
    activeRulesetId: row.activeRulesetId,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
