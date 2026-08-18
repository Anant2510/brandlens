import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, SCOPES_KEY, roleAtLeast } from '../decorators/roles.decorator';
import type { MemberRole } from '../../database/tenant-context.service';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MemberRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length && !requiredScopes?.length) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = req.brandlens;
    if (!principal) throw new ForbiddenException('Not authenticated');

    if (required?.length) {
      const ok = required.some((r) => roleAtLeast(principal.role, r));
      if (!ok) {
        throw new ForbiddenException(`Requires role ${required.join(' or ')}; caller is ${principal.role}`);
      }
    }

    // Scopes only apply to API keys. A human session is governed by its role;
    // asking a browser session for `checks:write` would be meaningless.
    if (requiredScopes?.length && principal.apiKeyId) {
      const granted = new Set(principal.scopes ?? []);
      const missing = requiredScopes.filter((s) => !granted.has(s) && !granted.has('*'));
      if (missing.length) throw new ForbiddenException(`API key missing scope(s): ${missing.join(', ')}`);
    }

    return true;
  }
}
