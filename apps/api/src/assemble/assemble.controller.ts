import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CreateBriefInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { AssembleService } from './assemble.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('assemble')
@ApiBearerAuth()
@Controller('v1/briefs')
export class AssembleController {
  constructor(private readonly assemble: AssembleService) {}

  @Get()
  @ApiOperation({ summary: 'List briefs' })
  list(@OrgId() orgId: string, @Query('brandId') brandId?: string) {
    return this.assemble.list(orgId, brandId);
  }

  @Post()
  @Roles('creator')
  @ApiOperation({ summary: 'Create a brief' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateBriefInput)) body: z.infer<typeof CreateBriefInput>,
  ) {
    return this.assemble.create(orgId, user.userId, body);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch a brief and its assembly plans' })
  get(@OrgId() orgId: string, @Param('id') id: string) {
    return this.assemble.get(orgId, id);
  }

  @Post(':id/assemble')
  @Roles('creator')
  @ApiOperation({ summary: 'Build an assembly plan from the brief' })
  run(@OrgId() orgId: string, @CurrentUser() user: TenantContext, @Param('id') id: string) {
    return this.assemble.assemble(orgId, user.userId, id);
  }
}
