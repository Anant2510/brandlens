import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CreateCheckInput, ListChecksQuery } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Scopes } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { correlationIdOf } from '../common/correlation-id.middleware';
import { ChecksService } from './checks.service';
import type { TenantContext } from '../database/tenant-context.service';

@ApiTags('checks')
@ApiBearerAuth()
@Controller('v1/checks')
export class ChecksController {
  constructor(private readonly checks: ChecksService) {}

  /**
   * The wedge: asset in, structured findings out.
   *
   * `async: true` (the default) returns 202 with a run id. `async: false`
   * blocks and returns the completed run, because an agent in a
   * generate → verify → fix loop has nothing to poll with.
   */
  @Post()
  @Scopes('checks:write')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Partitions the job key for deliberate re-runs' })
  @ApiOperation({ summary: 'Run a brand-compliance check on an asset' })
  @ApiResponse({ status: 202, description: 'Queued — poll GET /v1/checks/:id' })
  @ApiResponse({ status: 200, description: 'Completed run with traces and findings (async:false)' })
  async create(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(CreateCheckInput)) body: z.infer<typeof CreateCheckInput>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.checks.create(orgId, user.userId, body, {
      triggeredBy: user.apiKeyId ? 'api' : 'ui',
      idempotencyKey: idempotencyKey ?? body.idempotencyKey,
      correlationId: correlationIdOf(req as unknown as { headers: Record<string, unknown> }),
    });

    res.status(result.status === 'queued' ? 202 : 200);
    return result;
  }

  @Get()
  @Scopes('checks:read')
  @ApiOperation({ summary: 'List check runs' })
  list(@OrgId() orgId: string, @Query() query: Record<string, string>) {
    return this.checks.list(orgId, ListChecksQuery.parse(query));
  }

  @Get(':id')
  @Scopes('checks:read')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetch a check run with its decision traces and findings' })
  detail(@OrgId() orgId: string, @Param('id') id: string) {
    return this.checks.detail(orgId, id);
  }

  @Get(':id/traces')
  @Scopes('checks:read')
  @ApiOperation({ summary: 'Decision traces only — the audit view' })
  traces(@OrgId() orgId: string, @Param('id') id: string) {
    return this.checks.traces(orgId, id);
  }

  @Post(':id/rerun')
  @Scopes('checks:write')
  @HttpCode(202)
  @ApiOperation({ summary: 'Re-run a check, bypassing the result cache' })
  rerun(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('id') id: string,
    @Query('async') async?: string,
  ) {
    return this.checks.rerun(orgId, user.userId, id, async !== 'false');
  }
}
