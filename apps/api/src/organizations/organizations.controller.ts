import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { InviteMemberInput } from '@brandlens/contracts';
import { OrgId, CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';
import { PageQuery } from '../common/pagination';
import { OrganizationsService } from './organizations.service';
import type { MemberRole, TenantContext } from '../database/tenant-context.service';

const RoleChangeInput = z.object({
  role: z.enum(['owner', 'admin', 'brand_manager', 'reviewer', 'creator', 'viewer']),
});

const SettingsInput = z.object({
  name: z.string().min(1).optional(),
  dailyUsdLimit: z.number().positive().optional(),
  settings: z.record(z.unknown()).optional(),
});

const AuditQuery = PageQuery.extend({
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

@ApiTags('organization')
@ApiBearerAuth()
@Controller('v1')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get('members')
  @ApiOperation({ summary: 'List organization members' })
  members(@OrgId() orgId: string) {
    return this.orgs.members(orgId);
  }

  @Post('members/invite')
  @Roles('admin')
  @ApiOperation({ summary: 'Invite a member' })
  invite(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(InviteMemberInput)) body: z.infer<typeof InviteMemberInput>,
  ) {
    return this.orgs.invite(orgId, user.userId, body);
  }

  @Patch('members/:userId/role')
  @Roles('admin')
  @ApiOperation({ summary: 'Change a member role' })
  changeRole(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Param('userId') userId: string,
    @Body(zodBody(RoleChangeInput)) body: z.infer<typeof RoleChangeInput>,
  ) {
    return this.orgs.changeRole(orgId, user.userId, userId, body.role as MemberRole);
  }

  @Delete('members/:userId')
  @Roles('admin')
  @ApiOperation({ summary: 'Remove a member' })
  removeMember(@OrgId() orgId: string, @CurrentUser() user: TenantContext, @Param('userId') userId: string) {
    return this.orgs.removeMember(orgId, user.userId, userId);
  }

  @Get('organization')
  @ApiOperation({ summary: 'Organization settings' })
  settings(@OrgId() orgId: string) {
    return this.orgs.settings(orgId);
  }

  @Patch('organization')
  @Roles('admin')
  @ApiOperation({ summary: 'Update organization settings and spend limit' })
  updateSettings(
    @OrgId() orgId: string,
    @CurrentUser() user: TenantContext,
    @Body(zodBody(SettingsInput)) body: z.infer<typeof SettingsInput>,
  ) {
    return this.orgs.updateSettings(orgId, user.userId, body);
  }

  @Get('audit-log')
  @Roles('admin')
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiOperation({ summary: 'Query the append-only audit trail' })
  auditLog(@OrgId() orgId: string, @Query() query: Record<string, string>) {
    return this.orgs.auditLog(orgId, AuditQuery.parse(query));
  }
}
