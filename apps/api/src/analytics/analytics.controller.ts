import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsQuery, type DashboardSummary, type RuleHealthRow } from '@brandlens/contracts';
import { OrgId } from '../auth/decorators/current-user.decorator';
import { AnalyticsService, type CostReport, type CoverageReport } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiQuery({ name: 'brandId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date; defaults to 30 days ago' })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'granularity', required: false, enum: ['day', 'week', 'month'] })
  @ApiOperation({ summary: 'Dashboard summary' })
  summary(@OrgId() orgId: string, @Query() query: Record<string, string>): Promise<DashboardSummary> {
    return this.analytics.summary(orgId, AnalyticsQuery.parse(query));
  }

  @Get('rule-health')
  @ApiOperation({ summary: 'Per-rule health — override rate is the key metric' })
  ruleHealth(@OrgId() orgId: string, @Query() query: Record<string, string>): Promise<RuleHealthRow[]> {
    return this.analytics.ruleHealth(orgId, AnalyticsQuery.parse(query));
  }

  @Get('cost')
  @ApiOperation({ summary: 'Cost per asset, per rule, and cache hit rate' })
  cost(@OrgId() orgId: string, @Query() query: Record<string, string>): Promise<CostReport> {
    return this.analytics.cost(orgId, AnalyticsQuery.parse(query));
  }

  @Get('coverage')
  @ApiOperation({ summary: 'Auto-cleared rate and the rules routed to humans' })
  coverage(@OrgId() orgId: string, @Query() query: Record<string, string>): Promise<CoverageReport> {
    return this.analytics.coverage(orgId, AnalyticsQuery.parse(query));
  }
}
