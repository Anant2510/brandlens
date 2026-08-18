import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../api-key.service';
import { correlationIdOf } from '../../common/correlation-id.middleware';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';

/**
 * `Authorization: Bearer bl_live_…`
 *
 * API keys carry the `service` role: they can submit assets, run checks and
 * read results, but they can never activate a rule or change the ontology.
 * Governance actions must be attributable to a human — that is the whole
 * point of the audit trail.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
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
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing API key');

    const resolved = await this.apiKeys.resolve(header.slice(7).trim());
    if (!resolved) throw new UnauthorizedException('Invalid API key');

    req.brandlens = {
      orgId: resolved.orgId,
      role: 'service',
      apiKeyId: resolved.id,
      scopes: resolved.scopes,
      correlationId: correlationIdOf(req as unknown as { headers: Record<string, unknown> }),
    };
    return true;
  }
}
