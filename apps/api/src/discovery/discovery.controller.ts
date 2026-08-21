import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { StartDiscoveryRequest } from '@brandlens/contracts';
import { CurrentUser, OrgId } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { DiscoveryService } from './discovery.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('discovery')
@ApiBearerAuth()
@Controller('v1/discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Requires `brand_manager`, not `creator`.
   *
   * Starting a run creates a brand, writes design tokens and proposes rules —
   * it shapes the ontology rather than submitting work against it. It also
   * points a crawler at a third party's servers under the customer's name,
   * which is not a thing every seat should be able to do.
   */
  @Post()
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Discover a brand from its public website' })
  start(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(StartDiscoveryRequest)) body: StartDiscoveryRequest,
  ) {
    return this.discovery.start(orgId, user.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List discovery runs, newest first' })
  list(@OrgId() orgId: string, @Query('limit') limit?: string) {
    return this.discovery.list(orgId, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch a discovery run with its consolidated report' })
  get(@OrgId() orgId: string, @Param('id') id: string) {
    return this.discovery.get(orgId, id);
  }

  @Get(':id/pages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'List the pages harvested by a discovery run' })
  pages(@OrgId() orgId: string, @Param('id') id: string) {
    return this.discovery.pages(orgId, id);
  }

  @Post(':id/cancel')
  @Roles('brand_manager')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Stop a running discovery at the next stage boundary' })
  cancel(@OrgId() orgId: string, @Param('id') id: string) {
    return this.discovery.cancel(orgId, id);
  }
}
