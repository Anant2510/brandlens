import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { LoginInput, RegisterInput } from '@brandlens/contracts';
import { type Database, memberships, organizations, refreshTokens, users } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { TokenService } from './token.service';
import { sha256 } from '../common/hash';
import type { MemberRole } from '../database/tenant-context.service';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUserDto;
}

export interface SessionUserDto {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: string;
}

/**
 * bcryptjs, not native bcrypt or argon2.
 *
 * The target deployment is a Windows VM with no compiler toolchain; a native
 * postinstall that fails there turns "clone and run" into a support ticket.
 * bcryptjs is pure JS, and at cost 12 the difference in verification time is
 * irrelevant next to the network round trip.
 */
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async register(input: z.infer<typeof RegisterInput>, meta: RequestMeta = {}): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();

    // Registration creates the org, so it necessarily runs before a tenant
    // exists. It is one of a handful of legitimately cross-tenant writes.
    const result = await this.repo.platform(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      if (existing.length) throw new ConflictException('An account with that email already exists');

      const slug = await uniqueSlug(tx, slugify(input.organizationName));
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.organizationName, slug })
        .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });

      const [user] = await tx
        .insert(users)
        .values({
          email,
          name: input.name ?? null,
          passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        })
        .returning({ id: users.id, email: users.email, name: users.name });

      // First user of an org is its owner — nobody else can grant it to them.
      await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: 'owner' });

      await this.audit.recordIn(
        tx,
        {
          action: 'auth.register',
          entityType: 'organization',
          entityId: org.id,
          payload: { email, organizationName: org.name },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        { orgId: org.id, userId: user.id },
      );

      return {
        user: { id: user.id, email: user.email, name: user.name },
        org,
        role: 'owner' as MemberRole,
      };
    });

    return this.issue(result.user, result.org, result.role, meta);
  }

  async login(input: z.infer<typeof LoginInput>, meta: RequestMeta = {}): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();

    const found = await this.repo.platform(async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          passwordHash: users.passwordHash,
          orgId: organizations.id,
          orgName: organizations.name,
          orgSlug: organizations.slug,
          role: memberships.role,
        })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
        .limit(1);
      return rows[0];
    });

    // Hash a dummy even when the user is unknown so that "no such account" and
    // "wrong password" take the same amount of time.
    const hash = found?.passwordHash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(input.password, hash);
    if (!found || !ok) throw new UnauthorizedException('Invalid credentials');

    await this.repo.runAs(found.orgId, found.id, (tx) =>
      tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, found.id)),
    );

    return this.issue(
      { id: found.id, email: found.email, name: found.name },
      { id: found.orgId, name: found.orgName, slug: found.orgSlug },
      found.role as MemberRole,
      meta,
    );
  }

  /**
   * Refresh-token rotation: the presented token is revoked and a new one is
   * issued in the same transaction. Reuse of a revoked token is therefore
   * detectable, which is the whole reason to store hashes of them at all.
   */
  async refresh(refreshToken: string, meta: RequestMeta = {}): Promise<AuthResult> {
    const claims = this.tokens.verifyRefresh(refreshToken);
    const tokenHash = sha256(refreshToken);

    const found = await this.repo.platform(async (tx) => {
      const rows = await tx
        .select({ id: refreshTokens.id, revokedAt: refreshTokens.revokedAt, expiresAt: refreshTokens.expiresAt })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;

      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));

      const user = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          orgId: organizations.id,
          orgName: organizations.name,
          orgSlug: organizations.slug,
          role: memberships.role,
        })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(eq(users.id, claims.sub), eq(memberships.orgId, claims.orgId)))
        .limit(1);
      return user[0] ?? null;
    });

    if (!found) throw new UnauthorizedException('Refresh token is no longer valid');

    return this.issue(
      { id: found.id, email: found.email, name: found.name },
      { id: found.orgId, name: found.orgName, slug: found.orgSlug },
      found.role as MemberRole,
      meta,
    );
  }

  async logout(refreshToken: string | undefined, userId: string | undefined): Promise<{ revoked: number }> {
    if (!refreshToken && !userId) return { revoked: 0 };
    return this.repo.platform(async (tx) => {
      if (refreshToken) {
        const res = await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.tokenHash, sha256(refreshToken)), isNull(refreshTokens.revokedAt)))
          .returning({ id: refreshTokens.id });
        return { revoked: res.length };
      }
      const res = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, userId as string), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      return { revoked: res.length };
    });
  }

  async me(userId: string, orgId: string): Promise<SessionUserDto> {
    const row = await this.repo.runAs(orgId, userId, async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          orgId: organizations.id,
          orgName: organizations.name,
          orgSlug: organizations.slug,
          role: memberships.role,
        })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(eq(users.id, userId), eq(memberships.orgId, orgId)))
        .limit(1);
      return rows[0];
    });
    if (!row) throw new UnauthorizedException('Session no longer valid');
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      orgId: row.orgId,
      orgName: row.orgName,
      orgSlug: row.orgSlug,
      role: row.role,
    };
  }

  private async issue(
    user: { id: string; email: string; name: string | null },
    org: { id: string; name: string; slug: string },
    role: MemberRole,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const jti = randomUUID();
    const accessToken = this.tokens.signAccess({ sub: user.id, orgId: org.id, role, email: user.email });
    const refreshToken = this.tokens.signRefresh({ sub: user.id, orgId: org.id, jti });

    await this.repo.runAs(org.id, user.id, (tx) =>
      tx.insert(refreshTokens).values({
        userId: user.id,
        // Only the hash is stored: a database dump must not be a session hijack.
        tokenHash: sha256(refreshToken),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
      }),
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        orgId: org.id,
        orgName: org.name,
        orgSlug: org.slug,
        role,
      },
    };
  }
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'org'
  );
}

async function uniqueSlug(tx: Database, base: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const hit = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, candidate)).limit(1);
    if (!hit.length) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
