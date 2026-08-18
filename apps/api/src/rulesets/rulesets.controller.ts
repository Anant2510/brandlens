import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CompileRulesetInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { BrandsService } from '../brands/brands.service';
import { RulesetCompilerService } from './ruleset-compiler.service';
import type { TenantContext } from '../database/tenant-context.service';

const EffectiveQuery = z.object({
  subBrand: z.string().optional(),
  market: z.string().optional(),
  channel: z.string().optional(),
  assetType: z.string().optional(),
  campaign: z.string().optional(),
});

@ApiTags('rulesets')
@ApiBearerAuth()
@Controller('v1/brands/:brandId/rulesets')
export class RulesetsController {
  constructor(
    private readonly compiler: RulesetCompilerService,
    private readonly brands: BrandsService,
  ) {}

  @Get()
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'List published rulesets, newest first' })
  async list(@OrgId() orgId: string, @Param('brandId') brandId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.compiler.listRulesets(orgId, brandId);
  }

  /**
   * The "brand compile" step: freeze every active rule into a snapshot, hash
   * it, and point the brand at it. The hash becomes the cache key, the audit
   * anchor and the reproducibility guarantee for every check that follows.
   */
  @Post()
  @Roles('brand_manager')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Compile and publish a ruleset (brand compile)' })
  async publish(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Body(zodBody(CompileRulesetInput)) body: z.infer<typeof CompileRulesetInput>,
  ) {
    await this.brands.requireBrand(orgId, brandId);
    return this.compiler.publish(orgId, brandId, user.userId, {
      label: body.label,
      scoringConfig: body.scoringConfig,
    });
  }

  @Get('effective')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiQuery({ name: 'market', required: false, example: 'de-DE' })
  @ApiQuery({ name: 'channel', required: false, example: 'meta-feed' })
  @ApiQuery({ name: 'assetType', required: false, example: 'image' })
  @ApiQuery({ name: 'subBrand', required: false })
  @ApiQuery({ name: 'campaign', required: false })
  @ApiOperation({ summary: 'Resolve the effective ruleset for one scope context' })
  async effective(@OrgId() orgId: string, @Param('brandId') brandId: string, @Query() query: Record<string, string>) {
    await this.brands.requireBrand(orgId, brandId);
    const ctx = EffectiveQuery.parse(query);
    return this.compiler.effective(orgId, brandId, ctx);
  }

  @Get(':rulesetId')
  @ApiOperation({ summary: 'Fetch one compiled ruleset snapshot' })
  async get(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('rulesetId') rulesetId: string) {
    await this.brands.requireBrand(orgId, brandId);
    return this.compiler.loadRuleset(orgId, rulesetId);
  }
}
