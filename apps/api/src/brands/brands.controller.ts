import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CreateBrandInput, UpdateBrandInput } from '@brandlens/contracts';
import { BrandsService, type BrandDto, type BrandOverview } from './brands.service';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('brands')
@ApiBearerAuth()
@Controller('v1/brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get()
  @ApiOperation({ summary: 'List brands in the organization' })
  @ApiOkResponse({ description: 'Brands, alphabetically' })
  list(@OrgId() orgId: string): Promise<BrandDto[]> {
    return this.brands.list(orgId);
  }

  @Post()
  @Roles('brand_manager')
  @ApiOperation({ summary: 'Create a brand' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateBrandInput)) body: z.infer<typeof CreateBrandInput>,
  ): Promise<BrandDto> {
    return this.brands.create(orgId, user.userId, body);
  }

  @Get(':brandId')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch one brand' })
  get(@OrgId() orgId: string, @Param('brandId') brandId: string): Promise<BrandDto> {
    return this.brands.get(orgId, brandId);
  }

  @Patch(':brandId')
  @Roles('brand_manager')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Update a brand' })
  update(
    @OrgId() orgId: string,
    @Param('brandId') brandId: string,
    @Body(zodBody(UpdateBrandInput)) body: z.infer<typeof UpdateBrandInput>,
  ): Promise<BrandDto> {
    return this.brands.update(orgId, brandId, body);
  }

  @Delete(':brandId')
  @Roles('admin')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Soft-delete a brand (history is retained)' })
  remove(@OrgId() orgId: string, @Param('brandId') brandId: string): Promise<{ id: string; deleted: true }> {
    return this.brands.remove(orgId, brandId);
  }

  @Get(':brandId/overview')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiOperation({ summary: 'Aggregate dashboard for one brand' })
  overview(@OrgId() orgId: string, @Param('brandId') brandId: string): Promise<BrandOverview> {
    return this.brands.overview(orgId, brandId);
  }
}
