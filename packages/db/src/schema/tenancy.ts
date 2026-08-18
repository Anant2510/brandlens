import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { memberRoleEnum, orgPlanEnum } from './enums';

/**
 * Organisations are the tenant boundary. Every tenant-scoped table carries
 * `org_id`, every index leads with `org_id`, and Postgres RLS enforces
 * isolation at the database rather than trusting application code.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 80 }).notNull(),
    plan: orgPlanEnum('plan').notNull().default('free'),

    /** Soft guard rails; the hard guard is enforced in the cost ledger. */
    dailyUsdLimit: text('daily_usd_limit').notNull().default('25'),

    /** Per-tenant judge/model overrides, feature flags, retention policy. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    slugIdx: uniqueIndex('organizations_slug_uq').on(t.slug),
  }),
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 200 }),
    passwordHash: text('password_hash'),
    avatarUrl: text('avatar_url'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  }),
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId),
    byUser: index('memberships_user_idx').on(t.userId),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: varchar('ip', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    byUser: index('refresh_tokens_user_idx').on(t.userId),
  }),
);

/**
 * API keys are the primary interface — BrandLens is API-first, and the
 * "verify in an agent loop" wedge depends on these being first-class.
 * We store only a hash; the plaintext is shown once at creation.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    /** Displayable, non-secret: `bl_live_a1b2…`. */
    prefix: varchar('prefix', { length: 24 }).notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    byOrg: index('api_keys_org_idx').on(t.orgId),
    prefixIdx: index('api_keys_prefix_idx').on(t.prefix),
  }),
);

/**
 * Append-only audit log. Regulated buyers (pharma MLR, FINRA, insurance) pay
 * for the trail more than for the AI, so it is a core table, not an add-on.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 120 }).notNull(),
    entityType: varchar('entity_type', { length: 80 }).notNull(),
    entityId: uuid('entity_id'),
    /** Redacted diff — never store raw creative content here. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgTime: index('audit_log_org_time_idx').on(t.orgId, t.createdAt),
    byEntity: index('audit_log_entity_idx').on(t.orgId, t.entityType, t.entityId),
  }),
);

/** Per-tenant spend ledger. Every VLM call writes a row; budgets read from it. */
export const costLedger = pgTable(
  'cost_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    checkRunId: uuid('check_run_id'),
    provider: varchar('provider', { length: 60 }).notNull(),
    model: varchar('model', { length: 120 }).notNull(),
    operation: varchar('operation', { length: 60 }).notNull(),
    inputTokens: text('input_tokens').notNull().default('0'),
    cachedInputTokens: text('cached_input_tokens').notNull().default('0'),
    outputTokens: text('output_tokens').notNull().default('0'),
    imageCount: text('image_count').notNull().default('0'),
    costUsd: text('cost_usd').notNull().default('0'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    latencyMs: text('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgTime: index('cost_ledger_org_time_idx').on(t.orgId, t.createdAt),
    byRun: index('cost_ledger_run_idx').on(t.checkRunId),
  }),
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  apiKeys: many(apiKeys),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  org: one(organizations, { fields: [memberships.orgId], references: [organizations.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));
