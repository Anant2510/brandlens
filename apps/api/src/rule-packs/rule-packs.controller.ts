import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ForkRuleTemplateInput, SetRulePackEnabledInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { RulePacksService, type InheritedRuleSummary, type RulePackSummary } from './rule-packs.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('rule packs')
@ApiBearerAuth()
@Controller('v1/brands/:brandId/rule-packs')
export class RulePacksController {
  constructor(private readonly packs: RulePacksService) {}

  @Get()
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Rule packs this brand is subject to, and what it has overridden' })
  list(@OrgId() orgId: string, @Param('brandId') brandId: string): Promise<RulePackSummary[]> {
    return this.packs.list(orgId, brandId);
  }

  @Get('inherited-rules')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'The shipped rules this brand inherits, with overrides and drift' })
  inherited(@OrgId() orgId: string, @Param('brandId') brandId: string): Promise<InheritedRuleSummary[]> {
    return this.packs.listInherited(orgId, brandId);
  }

  /**
   * PUT rather than PATCH: enablement is one boolean with a reason, and the
   * request states the whole desired state rather than a change to it. Sending
   * it twice is the same as sending it once.
   */
  @Put(':packKey')
  @Roles('brand_manager')
  @ApiParam({ name: 'packKey' })
  @ApiOperation({ summary: 'Enable or disable a pack for this brand' })
  setEnabled(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Param('packKey') packKey: string,
    @Body(zodBody(SetRulePackEnabledInput)) body: z.infer<typeof SetRulePackEnabledInput>,
  ): Promise<RulePackSummary> {
    return this.packs.setEnabled(orgId, brandId, packKey, user.userId, body);
  }

  @Post('fork')
  @Roles('brand_manager')
  @ApiOperation({
    summary: 'Fork a shipped rule into this brand',
    description:
      'Creates a brand-owned copy of one template, recording which template and which version it came from. ' +
      'The copy lands at the template’s own status, so forking never changes what is being enforced — it ' +
      'changes who owns the rule.',
  })
  fork(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('brandId') brandId: string,
    @Body(zodBody(ForkRuleTemplateInput)) body: z.infer<typeof ForkRuleTemplateInput>,
  ) {
    return this.packs.fork(orgId, brandId, user.userId, body);
  }
}
