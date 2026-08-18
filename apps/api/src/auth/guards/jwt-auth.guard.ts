import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../token.service';
import { correlationIdOf } from '../../common/correlation-id.middleware';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/** Session-only guard. Used on routes that an API key must never reach. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    const claims = this.tokens.verifyAccess(header.slice(7).trim());
    req.brandlens = {
      orgId: claims.orgId,
      userId: claims.sub,
      role: claims.role,
      correlationId: correlationIdOf(req as unknown as { headers: Record<string, unknown> }),
    };
    return true;
  }
}
