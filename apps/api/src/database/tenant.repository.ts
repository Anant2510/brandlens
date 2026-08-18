import { Inject, Injectable } from '@nestjs/common';
import { type Database, withTenant } from '@brandlens/db';
import { DB } from './database.tokens';
import { TenantContextService } from './tenant-context.service';

/**
 * The ONLY sanctioned way to touch a tenant table.
 *
 * `withTenant` opens an explicit transaction and issues
 * `SELECT set_config('app.tenant_id', $1, true)` — the `true` makes it
 * `SET LOCAL`, scoped to the transaction. A plain `SET` would survive the
 * connection's return to the pool and leak the previous tenant's id into the
 * next request's RLS predicate: a cross-tenant read, from a one-word mistake.
 *
 * Because every call is inside a transaction, callers get atomicity for free,
 * which is what lets the outbox write commit with the state change it
 * describes.
 */
@Injectable()
export class TenantRepository {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tenants: TenantContextService,
  ) {}

  /** Raw handle. Only for cross-tenant/platform queries — see `platform()`. */
  get raw(): Database {
    return this.db;
  }

  /** Runs `fn` inside a transaction bound to the ambient tenant. */
  async run<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const ctx = this.tenants.require();
    return withTenant(this.db, { orgId: ctx.orgId, userId: ctx.userId }, fn);
  }

  /** Runs `fn` bound to an explicit tenant (queue handlers, system jobs). */
  async runAs<T>(orgId: string, userId: string | undefined, fn: (tx: Database) => Promise<T>): Promise<T> {
    return withTenant(this.db, { orgId, userId }, fn);
  }

  /**
   * Escape hatch for genuinely global data (the shipped channel-spec registry,
   * health probes, the outbox relay's cross-tenant sweep). It sets
   * `app.bypass_rls` for the transaction, so every use is greppable and
   * intentional.
   */
  async platform<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { orgId: '00000000-0000-0000-0000-000000000000', bypassRls: true },
      fn,
    );
  }
}
