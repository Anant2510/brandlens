import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../api-key.service';
import { TokenService } from '../token.service';
import { correlationIdOf } from '../../common/correlation-id.middleware';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/**
 * The default guard on every route.
 *
 * A single `Authorization: Bearer …` header carries either a browser session
 * JWT or a machine API key, and the prefix disambiguates them. Agents in a
 * generate → verify → fix loop are the fastest-growing consumer of this API,
 * so paying an extra header or a different scheme for them would be friction
 * on the wedge.
 */
@Injectable()
export class CombinedAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer credentials');

    const credential = header.slice(7).trim();
    const correlationId = correlationIdOf(req as unknown as { headers: Record<string, unknown> });

    if (credential.startsWith('bl_')) {
      const resolved = await this.apiKeys.resolve(credential);
      if (!resolved) throw new UnauthorizedException('Invalid API key');
      req.brandlens = {
        orgId: resolved.orgId,
        role: 'service',
        apiKeyId: resolved.id,
        scopes: resolved.scopes,
        correlationId,
      };
      return true;
    }

    const claims = this.tokens.verifyAccess(credential);
    req.brandlens = { orgId: claims.orgId, userId: claims.sub, role: claims.role, correlationId };
    return true;
  }
}
