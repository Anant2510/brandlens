import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export type MemberRole = 'owner' | 'admin' | 'brand_manager' | 'reviewer' | 'creator' | 'viewer' | 'service';

export interface TenantContext {
  orgId: string;
  userId?: string;
  role: MemberRole;
  /** Present when the caller authenticated with an API key. */
  apiKeyId?: string;
  scopes?: string[];
  correlationId?: string;
}

/**
 * The authenticated tenant, carried implicitly for the lifetime of a request.
 *
 * AsyncLocalStorage rather than a request-scoped provider on purpose: making
 * every service `Scope.REQUEST` would force Nest to rebuild the whole
 * dependency subtree per request, and the org id has to be reachable from
 * places that are not in the injector graph at all (queue handlers invoked
 * inline, the outbox writer, the audit interceptor).
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContext>();

  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  get(): TenantContext | undefined {
    return this.als.getStore();
  }

  /** Throws rather than returning undefined — a missing tenant is a bug. */
  require(): TenantContext {
    const ctx = this.als.getStore();
    if (!ctx) throw new Error('No tenant context bound to this async scope');
    return ctx;
  }

  get orgId(): string {
    return this.require().orgId;
  }

  get userId(): string | undefined {
    return this.get()?.userId;
  }
}
