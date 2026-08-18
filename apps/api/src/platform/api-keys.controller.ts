import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CreateApiKeyInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { ApiKeyService } from '../auth/api-key.service';
import { AuditService } from '../audit/audit.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('platform')
@ApiBearerAuth()
@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List API keys (never returns the secret)' })
  list(@OrgId() orgId: string) {
    return this.apiKeys.list(orgId);
  }

  /**
   * The plaintext key is returned exactly once, here. We store only a peppered
   * digest, so there is no "show key again" endpoint to build and no way for a
   * database dump to yield working credentials.
   */
  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Mint an API key — the secret is shown once' })
  async create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateApiKeyInput)) body: z.infer<typeof CreateApiKeyInput>,
  ) {
    const created = await this.apiKeys.create({
      orgId,
      userId: user.userId,
      name: body.name,
      scopes: body.scopes,
      expiresInDays: body.expiresInDays,
    });

    await this.audit.record({
      action: 'api_key.create',
      entityType: 'api_key',
      entityId: created.id,
      payload: { name: body.name, scopes: body.scopes, prefix: created.prefix },
    });

    return {
      id: created.id,
      name: body.name,
      prefix: created.prefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt,
      key: created.plaintext,
      warning: 'Store this key now — it will not be shown again.',
    };
  }

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Revoke an API key (soft; history is retained)' })
  async revoke(@OrgId() orgId: string, @Param('id') id: string) {
    await this.apiKeys.revoke(orgId, id);
    await this.audit.record({ action: 'api_key.revoke', entityType: 'api_key', entityId: id });
    return { id, revoked: true };
  }
}
