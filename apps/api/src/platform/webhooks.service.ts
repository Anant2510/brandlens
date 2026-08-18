import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreateWebhookInput, EVENT_TYPES } from '@brandlens/contracts';
import { webhookDeliveries, webhookEndpoints } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { AuditService } from '../audit/audit.service';
import { randomToken } from '../common/hash';

export type WebhookRow = typeof webhookEndpoints.$inferSelect;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<Array<Omit<WebhookRow, 'secret'> & { secretPreview: string }>> {
    const rows = await this.repo.runAs(orgId, undefined, (tx) =>
      tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId)).orderBy(desc(webhookEndpoints.createdAt)),
    );
    return rows.map(({ secret, ...rest }) => ({ ...rest, secretPreview: `${secret.slice(0, 8)}…` }));
  }

  /**
   * The signing secret is returned once at creation. Consumers verify
   * `X-BrandLens-Signature: sha256=<hmac>` over `timestamp.body`, which is what
   * makes a replayed or forged delivery detectable.
   */
  async create(
    orgId: string,
    userId: string | undefined,
    input: z.infer<typeof CreateWebhookInput>,
  ): Promise<{ id: string; url: string; events: string[]; secret: string; warning: string }> {
    const unknown = input.events.filter((e) => e !== '*' && !EVENT_TYPES.includes(e as (typeof EVENT_TYPES)[number]));
    if (unknown.length) {
      throw new NotFoundException(`Unknown event type(s): ${unknown.join(', ')}. Use '*' to subscribe to everything.`);
    }

    const secret = `whsec_${randomToken(24)}`;
    return this.repo.runAs(orgId, userId, async (tx) => {
      const [row] = await tx
        .insert(webhookEndpoints)
        .values({
          orgId,
          url: input.url,
          description: input.description ?? null,
          events: input.events,
          secret,
          status: 'active',
        })
        .returning();

      await this.audit.recordIn(tx, {
        action: 'webhook.create',
        entityType: 'webhook_endpoint',
        entityId: row.id,
        payload: { url: input.url, events: input.events },
      });

      return {
        id: row.id,
        url: row.url,
        events: row.events,
        secret,
        warning: 'Store this signing secret now — it will not be shown again.',
      };
    });
  }

  async remove(orgId: string, id: string): Promise<{ id: string; deleted: true }> {
    return this.repo.runAs(orgId, undefined, async (tx) => {
      const deleted = await tx
        .delete(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, orgId)))
        .returning({ id: webhookEndpoints.id });
      if (!deleted.length) throw new NotFoundException('Webhook not found');
      await this.audit.recordIn(tx, { action: 'webhook.delete', entityType: 'webhook_endpoint', entityId: id });
      return { id, deleted: true as const };
    });
  }

  /** Delivery attempts, newest first — the debugging surface customers ask for. */
  async deliveries(orgId: string, endpointId: string, limit = 100) {
    return this.repo.runAs(orgId, undefined, (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.endpointId, endpointId)))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit),
    );
  }
}
