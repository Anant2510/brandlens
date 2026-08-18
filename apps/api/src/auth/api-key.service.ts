import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { apiKeys } from '@brandlens/db';
import { AppConfigService } from '../config/config.service';
import { TenantRepository } from '../database/tenant.repository';
import { generateApiKey, hashApiKey, safeEqual } from '../common/hash';

export interface ResolvedApiKey {
  id: string;
  orgId: string;
  scopes: string[];
}

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Resolves `bl_live_…` to a tenant.
   *
   * Lookup is by the non-secret `prefix` column (indexed) and then a
   * constant-time compare of the peppered digest. Doing it the other way round
   * — scanning every key and hashing — would make auth O(keys) per request and
   * leak timing information about which org a key belongs to.
   *
   * This runs BEFORE any tenant context exists, so it is one of the few
   * queries that legitimately uses the platform escape hatch.
   */
  async resolve(plaintext: string): Promise<ResolvedApiKey | null> {
    if (!plaintext.startsWith('bl_')) return null;
    const prefix = plaintext.slice(0, 16);
    const digest = hashApiKey(plaintext, this.config.env.API_KEY_PEPPER);

    const rows = await this.repo.platform((tx) =>
      tx
        .select({
          id: apiKeys.id,
          orgId: apiKeys.orgId,
          scopes: apiKeys.scopes,
          keyHash: apiKeys.keyHash,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
        .limit(8),
    );

    const now = Date.now();
    for (const row of rows) {
      if (row.expiresAt && row.expiresAt.getTime() < now) continue;
      if (!safeEqual(row.keyHash, digest)) continue;

      // Fire-and-forget: `lastUsedAt` is telemetry, and blocking every
      // authenticated request on a write would be a poor trade.
      void this.touch(row.id, row.orgId);
      return { id: row.id, orgId: row.orgId, scopes: row.scopes ?? [] };
    }
    return null;
  }

  private async touch(id: string, orgId: string): Promise<void> {
    try {
      await this.repo.runAs(orgId, undefined, (tx) =>
        tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id)),
      );
    } catch {
      /* telemetry only — never fail a request because of it */
    }
  }

  /** Mints a key. The plaintext is returned once and never stored. */
  async create(input: {
    orgId: string;
    userId?: string;
    name: string;
    scopes: string[];
    expiresInDays?: number;
  }): Promise<{ id: string; plaintext: string; prefix: string; scopes: string[]; expiresAt: Date | null }> {
    const { plaintext, prefix } = generateApiKey('bl_live');
    const keyHash = hashApiKey(plaintext, this.config.env.API_KEY_PEPPER);
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;

    const [row] = await this.repo.runAs(input.orgId, input.userId, (tx) =>
      tx
        .insert(apiKeys)
        .values({
          orgId: input.orgId,
          name: input.name,
          prefix,
          keyHash,
          scopes: input.scopes,
          createdByUserId: input.userId ?? null,
          expiresAt,
        })
        .returning({ id: apiKeys.id }),
    );

    return { id: row.id, plaintext, prefix, scopes: input.scopes, expiresAt };
  }

  async list(orgId: string): Promise<
    Array<{
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      lastUsedAt: Date | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    }>
  > {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.orgId, orgId))
        .orderBy(sql`${apiKeys.createdAt} DESC`),
    );
  }

  /** Revocation is a soft delete: the audit trail must keep the key's history. */
  async revoke(orgId: string, id: string): Promise<void> {
    await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId), or(isNull(apiKeys.revokedAt), sql`true`))),
    );
  }
}
