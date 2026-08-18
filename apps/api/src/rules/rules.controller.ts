import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BulkRuleDecisionInput, CreateRuleInput, UpdateRuleInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { RulesService, type RuleRow } from './rules.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('rules')
@ApiBearerAuth()
@Controller('v1/brands/:brandId/rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: ['proposed', 'active', 'deprecated', 'rejected'] })
  @ApiQuery({ name: 'dimension', required: false })
  @ApiQuery({ name: 'tier', required: false })
  @ApiQuery({ name: 'provenance', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiOperation({ summary: 'List rules for a brand' })
  list(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Query() query: Record<string, string>,
  ): Promise<RuleRow[]> {
    return this.rules.list(orgId, brandId, {
      status: query.status,
      dimension: query.dimension,
      tier: query.tier,
      provenance: query.provenance,
      search: query.search,
    });
  }

  @Post()
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create a rule (defaults to `proposed`)' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Body(zodBody(CreateRuleInput)) body: z.infer<typeof CreateRuleInput>,
  ): Promise<RuleRow> {
    return this.rules.create(orgId, brandId, user.userId, body);
  }

  @Get('history/:key')
  @ApiOperation({ summary: 'Every version recorded for one rule key' })
  history(@OrgId() orgId: string, @Param('brandId') brandId: string, @Param('key') key: string): Promise<RuleRow[]> {
    return this.rules.history(orgId, brandId, key);
  }

  /**
   * Bulk decision. Activation is the human act that turns proposals into
   * policy, so it is audited with the actor and emits `rule.activated`.
   */
  @Post('bulk-decision')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Bulk activate / reject / deprecate proposed rules' })
  bulk(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Body(zodBody(BulkRuleDecisionInput)) body: z.infer<typeof BulkRuleDecisionInput>,
  ) {
    return this.rules.bulkDecision(orgId, brandId, user.userId, body);
  }

  @Patch(':ruleId')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Update a rule (editing an active rule creates version+1)' })
  update(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Param('ruleId') ruleId: string,
    @Body(zodBody(UpdateRuleInput)) body: z.infer<typeof UpdateRuleInput>,
  ): Promise<RuleRow> {
    return this.rules.update(orgId, brandId, ruleId, user.userId, body);
  }
}
