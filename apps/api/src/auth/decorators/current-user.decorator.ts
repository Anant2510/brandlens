import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '../../database/tenant-context.service';

export interface AuthenticatedRequest extends Request {
  brandlens?: TenantContext;
}

/** `@CurrentUser() user: TenantContext` — the authenticated principal. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.brandlens) throw new Error('Route reached without an authenticated principal');
  return req.brandlens;
});

/** `@OrgId() orgId: string` — the tenant boundary, in one character of noise. */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.brandlens) throw new Error('Route reached without an authenticated principal');
  return req.brandlens.orgId;
});
