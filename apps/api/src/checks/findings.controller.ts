import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ReviewDecisionInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { PageQuery } from '../common/pagination';
import { FindingsService } from './findings.service';
import type { TenantContext } from '../database/tenant-context.service';

const ListQuery = PageQuery.extend({
  brandId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  checkRunId: z.string().uuid().optional(),
  ruleKey: z.string().optional(),
  severity: z.enum(['blocker', 'major', 'minor', 'advisory']).optional(),
  status: z.enum(['open', 'confirmed', 'overridden', 'waived', 'fixed']).optional(),
  highConfidenceOnly: z.coerce.boolean().optional(),
});

@ApiTags('findings')
@ApiBearerAuth()
@Controller('v1/findings')
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}

  @Get()
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'highConfidenceOnly', required: false, type: Boolean })
  @ApiOperation({ summary: 'List findings across the organization' })
  list(@OrgId() orgId: string, @Query() query: Record<string, string>) {
    return this.findings.list(orgId, ListQuery.parse(query));
  }

  @Get(':id/explain')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Everything needed to answer "why did this fail?"' })
  explain(@OrgId() orgId: string, @Param('id') id: string) {
    return this.findings.explain(orgId, id);
  }

  /**
   * The gold-label stream. Every override is a training signal, and the
   * override rate per rule is the single best product-health metric we own.
   */
  @Post(':id/decision')
  @Roles('reviewer')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Record a human decision on a finding' })
  decide(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('id') id: string,
    @Body(zodBody(ReviewDecisionInput)) body: z.infer<typeof ReviewDecisionInput>,
  ) {
    return this.findings.decide(orgId, user.userId, id, body);
  }
}
