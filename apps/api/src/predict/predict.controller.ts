import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CreatePredictionInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { CreatePanelInput, PredictService } from './predict.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('predict')
@ApiBearerAuth()
@Controller('v1')
export class PredictController {
  constructor(private readonly predict: PredictService) {}

  @Get('panels')
  @ApiOperation({ summary: 'List synthetic audience panels' })
  listPanels(@OrgId() orgId: string, @Query('brandId') brandId?: string) {
    return this.predict.listPanels(orgId, brandId);
  }

  @Post('panels')
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create an audience panel' })
  createPanel(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreatePanelInput)) body: z.infer<typeof CreatePanelInput>,
  ) {
    return this.predict.createPanel(orgId, user.userId, body);
  }

  @Post('predictions')
  @Roles('creator')
  @ApiOperation({ summary: 'Predict audience response, ranked against the tenant corpus' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreatePredictionInput)) body: z.infer<typeof CreatePredictionInput>,
  ) {
    return this.predict.createPrediction(orgId, user.userId, body);
  }

  @Get('predictions/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch a prediction with its confidence interval' })
  get(@OrgId() orgId: string, @Param('id') id: string) {
    return this.predict.getPrediction(orgId, id);
  }
}
