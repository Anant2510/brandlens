import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { InviteMemberInput } from '@brandlens/contracts';
import { auditLog, memberships, organizations, users } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { offsetOf, paginate, type PageResult } from '../common/pagination';
import { randomToken } from '../common/hash';
import type { MemberRole } from '../database/tenant-context.service';

export interface MemberDto {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
  lastLoginAt: string | null;
}

export interface AuditLogQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
  ) {}

  async members(orgId: string): Promise<MemberDto[]> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          joinedAt: memberships.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, orgId))
        .orderBy(users.email),
    );
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      joinedAt: r.joinedAt.toISOString(),
      lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
    }));
  }

  /**
   * Invite. If the person already has an account they are added straight away;
   * otherwise a placeholder user is created with no password, so the invite
   * link is the only way in. We never set a password on someone's behalf.
   */
  async invite(
    orgId: string,
    actorUserId: string | undefined,
    input: z.infer<typeof InviteMemberInput>,
  ): Promise<{ userId: string; role: string; invited: boolean; inviteToken?: string }> {
    const email = input.email.toLowerCase().trim();

    return this.repo.platform(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);

      let userId = existing[0]?.id;
      let invited = false;
      let inviteToken: string | undefined;

      if (!userId) {
        const [created] = await tx.insert(users).values({ email, passwordHash: null }).returning({ id: users.id });
        userId = created.id;
        invited = true;
        inviteToken = randomToken(24);
      }

      const already = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1);
      if (already.length) throw new BadRequestException('That user is already a member of this organization');

      await tx.insert(memberships).values({ orgId, userId, role: input.role as MemberRole });

      await this.audit.recordIn(
        tx,
        {
          action: 'member.invite',
          entityType: 'membership',
          entityId: userId,
          payload: { email, role: input.role, newAccount: invited },
        },
        { orgId, userId: actorUserId },
      );

      return { userId, role: input.role, invited, inviteToken };
    });
  }

  /**
   * Role change. The last owner cannot be demoted — an org with no owner has
   * nobody who can pay the bill or delete it, which is an unrecoverable state.
   */
  async changeRole(
    orgId: string,
    actorUserId: string | undefined,
    userId: string,
    role: MemberRole,
  ): Promise<MemberDto> {
    return this.repo.runAs(orgId, actorUserId, async (tx) => {
      const current = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1);
      if (!current[0]) throw new NotFoundException('That user is not a member of this organization');

      if (current[0].role === 'owner' && role !== 'owner') {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));
        if ((n ?? 0) <= 1) throw new BadRequestException('An organization must retain at least one owner');
      }

      await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

      await this.audit.recordIn(tx, {
        action: 'member.role_change',
        entityType: 'membership',
        entityId: userId,
        payload: { from: current[0].role, to: role },
      });

      const [row] = await tx
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          joinedAt: memberships.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1);

      return {
        userId: row.userId,
        email: row.email,
        name: row.name,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      };
    });
  }

  async removeMember(orgId: string, actorUserId: string | undefined, userId: string): Promise<{ removed: boolean }> {
    return this.repo.runAs(orgId, actorUserId, async (tx) => {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));
      const current = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1);
      if (current[0]?.role === 'owner' && (n ?? 0) <= 1) {
        throw new BadRequestException('Cannot remove the last owner');
      }

      await tx.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
      await this.audit.recordIn(tx, { action: 'member.remove', entityType: 'membership', entityId: userId });
      return { removed: true };
    });
  }

  async settings(orgId: string) {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          plan: organizations.plan,
          dailyUsdLimit: organizations.dailyUsdLimit,
          settings: organizations.settings,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException('Organization not found');
    // `daily_usd_limit` is a `text` column — money is kept out of float
    // arithmetic on purpose — but the wire contract says number, and the
    // console formats it as one. Converting HERE, at the boundary that owns
    // the column, is what keeps that promise true; leaving it as text made
    // every screen that renders it throw "toFixed is not a function".
    return { ...rows[0], dailyUsdLimit: Number(rows[0].dailyUsdLimit) };
  }

  async updateSettings(
    orgId: string,
    actorUserId: string | undefined,
    input: { name?: string; dailyUsdLimit?: number; settings?: Record<string, unknown> },
  ) {
    return this.repo.runAs(orgId, actorUserId, async (tx) => {
      const [row] = await tx
        .update(organizations)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.dailyUsdLimit !== undefined ? { dailyUsdLimit: String(input.dailyUsdLimit) } : {}),
          ...(input.settings !== undefined ? { settings: input.settings } : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, orgId))
        .returning();
      await this.audit.recordIn(tx, {
        action: 'org.update_settings',
        entityType: 'organization',
        entityId: orgId,
        payload: input as Record<string, unknown>,
      });
      // Same conversion as `settings()` — the save response feeds straight
      // back into the form, so returning text here would break the screen on
      // save even though the initial load worked.
      return { ...row, dailyUsdLimit: Number(row.dailyUsdLimit) };
    });
  }

  /**
   * Audit-log query. Append-only and never redacted at read time: the buyer
   * who cares about this table cares precisely because nobody can edit it.
   */
  async auditLog(orgId: string, query: AuditLogQuery): Promise<PageResult<typeof auditLog.$inferSelect>> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const conditions = [eq(auditLog.orgId, orgId)];
      if (query.action) conditions.push(eq(auditLog.action, query.action));
      if (query.entityType) conditions.push(eq(auditLog.entityType, query.entityType));
      if (query.entityId) conditions.push(eq(auditLog.entityId, query.entityId));
      if (query.actorUserId) conditions.push(eq(auditLog.actorUserId, query.actorUserId));
      if (query.from) conditions.push(sql`${auditLog.createdAt} >= ${new Date(query.from)}`);
      if (query.to) conditions.push(sql`${auditLog.createdAt} <= ${new Date(query.to)}`);

      const rows = await tx
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(query.pageSize)
        .offset(offsetOf(query));

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(...conditions));

      return paginate(rows, n ?? 0, query);
    });
  }
}
