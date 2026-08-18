/* ==========================================================================
 * Step 1 — the tenant: organisation, users, memberships, demo API key.
 *
 * `organizations`, `users` and `memberships` are the only tables outside the
 * RLS policy set (see packages/db/src/sql/10_rls.sql): they describe who the
 * tenants ARE, so they cannot themselves be tenant-scoped. `api_keys`,
 * `audit_log` and `cost_ledger` are inside it, and are written with the
 * tenant context bound.
 * ========================================================================== */

import { createHash, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { apiKeys, memberships, organizations, users } from '../../schema/index.js';
import type { Database } from '../../client.js';
import { seedId } from '../lib/ids.js';
import { upsertRows } from '../lib/upsert.js';

export const ORG_SLUG = 'northwind-coffee';
export const DEMO_PASSWORD = 'BrandLens!2026';

/**
 * The plaintext of the seeded API key.
 *
 * A fixed demo key is a deliberate trade: it makes `curl` work the moment the
 * seed finishes, which is the difference between the API being real to
 * someone in the first two minutes and being a thing they mean to try later.
 * It is scoped to the demo tenant, printed in the seed summary with a
 * warning, and revoking it is one call.
 */
export const DEMO_API_KEY = 'bl_live_demo_northwind_seed_2026';

export const ORG_ID = seedId('org', ORG_SLUG);

export const USERS = {
  owner: {
    id: seedId('user', 'owner@northwind.test'),
    email: 'owner@northwind.test',
    name: 'Dana Okonkwo',
    role: 'owner' as const,
    title: 'Founder — owns billing and the brand',
  },
  reviewer: {
    id: seedId('user', 'reviewer@northwind.test'),
    email: 'reviewer@northwind.test',
    name: 'Priya Raghunathan',
    role: 'reviewer' as const,
    title: 'Brand + legal reviewer — their decisions become gold labels',
  },
  creator: {
    id: seedId('user', 'creator@northwind.test'),
    email: 'creator@northwind.test',
    name: 'Marco Bellini',
    role: 'creator' as const,
    title: 'Studio designer — submits work, sees their own results',
  },
};

/**
 * bcryptjs at cost 12, matching apps/api/src/auth/auth.service.ts.
 *
 * The salt is DERIVED rather than random so the hash is stable across runs.
 * bcrypt.hashSync with a random salt would rewrite password_hash on every
 * re-seed — harmless, but it makes `git diff`-style comparison of two
 * databases useless and produces a pointless write on every deploy.
 */
export function deterministicBcrypt(password: string, salt: string): string {
  const alphabet = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const digest = createHash('sha256').update(`brandlens.seed.salt:${salt}`).digest();
  let encoded = '';
  for (let i = 0; i < 22; i += 1) encoded += alphabet[digest[i] % alphabet.length];
  return bcrypt.hashSync(password, `$2a$12$${encoded}`);
}

/** Mirrors hashApiKey() in apps/api/src/common/hash.ts: HMAC with the pepper. */
function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext).digest('hex');
}

export interface TenantResult {
  orgId: string;
  users: typeof USERS;
  apiKeyPlaintext: string;
  apiKeyPrefix: string;
  apiKeyUsable: boolean;
}

export async function seedTenant(tx: Database): Promise<TenantResult> {
  await upsertRows(tx, organizations, [
    {
      id: ORG_ID,
      name: 'Northwind Coffee Co.',
      slug: ORG_SLUG,
      plan: 'business',
      dailyUsdLimit: '50',
      settings: {
        demo: true,
        seededBy: '@brandlens/db seed',
        timezone: 'Europe/London',
        // Per-tenant judge overrides live here. Left at the platform defaults
        // so the demo reflects the shipped configuration rather than a
        // special case nobody else gets.
        review: { requireSecondApproverForBlockers: true, slaHours: 24 },
        retention: { decisionTracesDays: 2555, derivativesDays: 90 },
      },
    },
  ]);

  await upsertRows(
    tx,
    users,
    Object.values(USERS).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      passwordHash: deterministicBcrypt(DEMO_PASSWORD, u.email),
      emailVerifiedAt: new Date('2026-01-05T09:00:00Z'),
    })),
    // lastLoginAt is real usage data; a re-seed must not erase it.
    { skip: ['id', 'createdAt', 'lastLoginAt'] },
  );

  await upsertRows(
    tx,
    memberships,
    Object.values(USERS).map((u) => ({
      id: seedId('membership', ORG_ID, u.email),
      orgId: ORG_ID,
      userId: u.id,
      role: u.role,
    })),
  );

  /* --- demo API key ---------------------------------------------------- */
  const pepper = process.env.API_KEY_PEPPER ?? '';
  const apiKeyUsable = pepper.length > 0 && pepper !== 'change-me-api-key-pepper';

  if (pepper.length > 0) {
    await upsertRows(
      tx,
      apiKeys,
      [
        {
          id: seedId('apikey', ORG_ID, 'demo'),
          orgId: ORG_ID,
          name: 'Demo key (seeded)',
          prefix: DEMO_API_KEY.slice(0, 16),
          keyHash: hashApiKey(DEMO_API_KEY, pepper),
          scopes: ['checks:read', 'checks:write', 'assets:read', 'assets:write'],
          createdByUserId: USERS.owner.id,
        },
      ],
      // lastUsedAt is telemetry the running system writes; preserve it.
      { skip: ['id', 'createdAt', 'lastUsedAt'] },
    );
  }

  return {
    orgId: ORG_ID,
    users: USERS,
    apiKeyPlaintext: DEMO_API_KEY,
    apiKeyPrefix: DEMO_API_KEY.slice(0, 16),
    apiKeyUsable,
  };
}
