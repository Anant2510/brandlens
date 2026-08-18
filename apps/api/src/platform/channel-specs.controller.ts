import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { channelSpecs } from '@brandlens/db';
import { OrgId } from '../auth/decorators/current-user.decorator';
import { TenantRepository } from '../database/tenant.repository';

/**
 * The channel-spec registry.
 *
 * Boring, tedious and constantly drifting — every platform changes its safe
 * zones two to four times a year and nobody maintains them well, which is
 * exactly why a versioned, declarative registry is a real moat. Validating
 * against it costs zero model tokens and is 100% precise.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('v1/channel-specs')
export class ChannelSpecsController {
  constructor(private readonly repo: TenantRepository) {}

  @Get()
  @ApiQuery({ name: 'platform', required: false, example: 'meta' })
  @ApiQuery({ name: 'placement', required: false, example: 'feed' })
  @ApiQuery({ name: 'assetType', required: false, example: 'image' })
  @ApiOperation({ summary: 'Read channel specs (tenant overrides shadow the shipped registry)' })
  async list(@OrgId() orgId: string, @Query() query: Record<string, string>) {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const conditions = [or(isNull(channelSpecs.orgId), eq(channelSpecs.orgId, orgId))];
      if (query.platform) conditions.push(eq(channelSpecs.platform, query.platform));
      if (query.placement) conditions.push(eq(channelSpecs.placement, query.placement));
      if (query.assetType) conditions.push(eq(channelSpecs.assetType, query.assetType));

      const rows = await tx
        .select()
        .from(channelSpecs)
        .where(and(...conditions))
        // Tenant overrides sort first so the client can take the first match.
        .orderBy(sql`${channelSpecs.orgId} NULLS LAST`, channelSpecs.platform, channelSpecs.placement)
        .limit(500);

      return rows.map((r) => ({ ...r, isOverride: r.orgId !== null }));
    });
  }
}
