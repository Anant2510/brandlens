import { Injectable } from '@nestjs/common';
import { type Database, auditLog } from '@brandlens/db';
import { TenantRepository } from '../database/tenant.repository';
import { TenantContextService } from '../database/tenant-context.service';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Append-only audit trail.
 *
 * Regulated buyers (pharma MLR, FINRA, insurance) buy the trail more than they
 * buy the AI, so every governance act — activating a rule, publishing a
 * ruleset, overriding a finding, minting a key — writes a row here, inside the
 * same transaction as the change it describes. An audit row that can be lost
 * independently of its state change is worse than no audit row, because it
 * looks trustworthy and is not.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly tenants: TenantContextService,
  ) {}

  /** Writes inside a caller-supplied transaction. Prefer this form. */
  async recordIn(tx: Database, entry: AuditEntry, ctxOverride?: { orgId: string; userId?: string; apiKeyId?: string }) {
    const ctx = ctxOverride ?? this.tenants.get();
    if (!ctx) return;
    await tx.insert(auditLog).values({
      orgId: ctx.orgId,
      actorUserId: ctx.userId ?? null,
      actorApiKeyId: ctx.apiKeyId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      payload: redact(entry.payload ?? {}),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  /** Standalone write, for callers not already inside a transaction. */
  async record(entry: AuditEntry): Promise<void> {
    await this.repo.run((tx) => this.recordIn(tx, entry));
  }
}

const SENSITIVE = new Set(['password', 'passwordhash', 'plaintext', 'secret', 'token', 'keyhash', 'refreshtoken']);

/**
 * The audit payload is a redacted diff. Raw creative content and credentials
 * must never land here — the log is retained far longer than the assets are,
 * and it is the table most likely to be exported to a third party.
 */
function redact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string' && v.length > 2000) {
      out[k] = `${v.slice(0, 2000)}…[truncated]`;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
