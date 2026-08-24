import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenancy';
import { brands } from './ontology';
import { checkTierEnum, rulePackCategoryEnum, ruleDimensionEnum, severityEnum } from './enums';

/* ==========================================================================
 * RULE PACKS — the standards every brand gets before anyone writes a rule.
 *
 * The problem this solves: a brand created five minutes ago has no rules, so
 * checking it returns nothing. Asking a customer to author forty rules before
 * the product does anything is how onboarding dies.
 *
 * So BrandLens ships packs of rules that are true for ANY brand — WCAG
 * contrast, logo distortion, channel safe zones — and every brand inherits
 * them. A brand can then override any single rule by forking it, or enable an
 * opt-in pack for its industry.
 *
 * WHY THIS IS NOT JUST "COPY THE RULES INTO EACH BRAND":
 * a copy is frozen at creation. When we correct a threshold, or a platform
 * changes its safe-zone spec, brands created last month never see it. Packs
 * are inherited live and merged at compile time, so a fix reaches everyone on
 * their next compile — while `ruleset_hash` still freezes the MERGED result,
 * so a check run stays reproducible for audit.
 *
 * Ownership follows the `channel_specs` convention already in this schema:
 * `org_id IS NULL` means a row BrandLens ships and every tenant can read;
 * a non-null `org_id` is that tenant's private pack. RLS enforces both.
 * ========================================================================== */

export const rulePacks = pgTable(
  'rule_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null = shipped with BrandLens, readable by every tenant. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),

    key: varchar('key', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    category: rulePackCategoryEnum('category').notNull().default('baseline'),

    /**
     * Bumped when any template in the pack changes. A forked brand rule records
     * the version it was taken from, so the console can say "the baseline has
     * moved on since you forked this" rather than letting the fork rot silently.
     */
    version: integer('version').notNull().default(1),

    /**
     * Whether a brand gets this pack without asking.
     *
     * True for the universal packs — a brand cannot really disagree that text
     * should be legible. False for regulated packs: failing a coffee brand
     * against financial-promotion rules would be nonsense, and a tool that
     * cries wolf gets switched off.
     */
    enabledByDefault: boolean('enabled_by_default').notNull().default(false),

    /** ISO country codes a regulated pack applies to. Empty = everywhere. */
    jurisdictions: text('jurisdictions').array().notNull().default([]),
    /** Where the standard comes from — FCA, ASA, WCAG, a platform spec sheet. */
    authority: varchar('authority', { length: 200 }),
    docsUrl: text('docs_url'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex('rule_packs_key_uq').on(t.key),
    byCategory: index('rule_packs_category_idx').on(t.category, t.isActive),
  }),
);

/**
 * A rule that belongs to a pack rather than to a brand.
 *
 * Deliberately the same shape as `rules` minus the tenant columns, so
 * compilation can treat a template and a brand rule as the same thing. The
 * duplication is the point: if a template had its own reduced shape, every
 * rule feature would need implementing twice and the two would drift.
 */
export const ruleTemplates = pgTable(
  'rule_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    packId: uuid('pack_id')
      .notNull()
      .references(() => rulePacks.id, { onDelete: 'cascade' }),

    key: varchar('key', { length: 160 }).notNull(),
    version: integer('version').notNull().default(1),
    statement: text('statement').notNull(),
    rationale: text('rationale'),

    dimension: ruleDimensionEnum('dimension').notNull(),
    tier: checkTierEnum('tier').notNull().default('deterministic'),
    severity: severityEnum('severity').notNull().default('major'),
    weight: real('weight').notNull().default(1),

    /** Usually empty — a template that applied only to one market would not be
     *  much of a baseline. Populated for channel- and market-specific packs. */
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    check: jsonb('check').$type<{ fn: string; params?: Record<string, unknown> }>().notNull(),
    rubric: jsonb('rubric').$type<Record<string, unknown>>(),

    /** The standard this came from, so a reviewer can go and read it. */
    citation: jsonb('citation').$type<Record<string, unknown>>(),

    /**
     * `active` for a standard nobody argues with; `proposed` where the
     * threshold is a judgement call the brand should make for itself.
     * Everything ships with a real value here rather than a shrug.
     */
    defaultStatus: varchar('default_status', { length: 20 }).notNull().default('active'),

    /** Plain-language note shown next to the rule in the console. */
    guidance: text('guidance'),

    /**
     * Ontology attributes this rule needs before it can produce a verdict.
     *
     * Stored rather than derived because it is a per-template CLAIM, not a
     * property of the analyzer: several checks fall back to the ontology only
     * when the rule is silent, so a template that passes its own list is not
     * waiting on anything. The seed asserts this against the AST-extracted
     * analyzer manifest before writing a row, so it cannot drift from what the
     * engine actually reads.
     *
     * This is what lets the console say "12 rules are waiting on your logo
     * files" rather than showing twelve silent passes — which is the whole
     * difference between an honest empty state and a green screen that means
     * nothing.
     */
    needs: text('needs').array().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packKeyUq: uniqueIndex('rule_templates_pack_key_uq').on(t.packId, t.key),
    byPack: index('rule_templates_pack_idx').on(t.packId, t.isActive),
  }),
);

/**
 * Per-brand pack enablement.
 *
 * ABSENCE OF A ROW MEANS "use the pack's default". That matters: it lets a new
 * brand inherit every baseline pack with zero rows written, while still
 * allowing a brand to explicitly turn a baseline pack OFF — which a row with
 * `enabled = false` records, along with who did it and why.
 */
export const brandRulePacks = pgTable(
  'brand_rule_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    packId: uuid('pack_id')
      .notNull()
      .references(() => rulePacks.id, { onDelete: 'cascade' }),

    enabled: boolean('enabled').notNull().default(true),
    /** Required when disabling a baseline pack — turning off accessibility
     *  checks is a decision somebody should have to write down. */
    reason: text('reason'),

    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('brand_rule_packs_uq').on(t.brandId, t.packId),
    byBrand: index('brand_rule_packs_brand_idx').on(t.orgId, t.brandId),
  }),
);

export const rulePacksRelations = relations(rulePacks, ({ many }) => ({
  templates: many(ruleTemplates),
  brandEnablements: many(brandRulePacks),
}));

export const ruleTemplatesRelations = relations(ruleTemplates, ({ one }) => ({
  pack: one(rulePacks, { fields: [ruleTemplates.packId], references: [rulePacks.id] }),
}));

export const brandRulePacksRelations = relations(brandRulePacks, ({ one }) => ({
  brand: one(brands, { fields: [brandRulePacks.brandId], references: [brands.id] }),
  pack: one(rulePacks, { fields: [brandRulePacks.packId], references: [rulePacks.id] }),
}));
