import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CreateWebhookInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { WebhooksService } from './webhooks.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('platform')
@ApiBearerAuth()
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List webhook endpoints' })
  list(@OrgId() orgId: string) {
    return this.webhooks.list(orgId);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Register a webhook — the signing secret is shown once' })
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateWebhookInput)) body: z.infer<typeof CreateWebhookInput>,
  ) {
    return this.webhooks.create(orgId, user.userId, body);
  }

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  remove(@OrgId() orgId: string, @Param('id') id: string) {
    return this.webhooks.remove(orgId, id);
  }

  @Get(':id/deliveries')
  @Roles('admin')
  @ApiOperation({ summary: 'Delivery attempts for one endpoint' })
  deliveries(@OrgId() orgId: string, @Param('id') id: string) {
    return this.webhooks.deliveries(orgId, id);
  }
}
