import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { TenantContextService } from '../database/tenant-context.service';
import type { AuthenticatedRequest } from './decorators/current-user.decorator';

/**
 * Publishes the authenticated principal into AsyncLocalStorage for the whole
 * handler chain.
 *
 * This has to be an interceptor rather than part of the guard: `canActivate`
 * returns before the controller runs, so an `als.run()` opened inside a guard
 * would have already unwound by the time the handler needs the org id. An
 * interceptor wraps the downstream observable, so the store stays alive for
 * every awaited query underneath it — which is exactly the scope `withTenant`
 * reads from.
 */
@Injectable()
export class TenantBindingInterceptor implements NestInterceptor {
  constructor(private readonly tenants: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.brandlens) return next.handle();
    return this.tenants.run(req.brandlens, () => next.handle());
  }
}
