/* ==========================================================================
 * BrandLens · demo seed
 *
 *     pnpm db:seed
 *
 * Creates the Northwind Coffee Co. demo tenant: a real brand ontology, real
 * generated image files, a published ruleset, ten registered creatives and one
 * completed check run with decision traces, findings, a human override and a
 * precedent. The point is that the console, the check viewer, the review queue
 * and the analytics pages all have something true to show on first boot.
 *
 * IDEMPOTENT. Every primary key is a deterministic UUIDv5 derived from a
 * stable name, so a second run rewrites the same rows rather than creating a
 * second copy of everything. Append-only tables (decision traces, audit log)
 * are inserted once and never rewritten.
 *
 * SAFE TO RUN ON A NON-EMPTY DATABASE. It only ever touches rows it owns.
 * ========================================================================== */

import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../../.env') });

import { closeDb, getDb, withTenant } from '../client.js';
import { seedTenant, DEMO_PASSWORD, USERS } from './steps/tenant.js';
import { seedOntology } from './steps/ontology.js';
import { seedAssets, seedChannelSpecs } from './steps/assets.js';
import { seedChecks } from './steps/checks.js';
import { SEED_CLAIMS, SEED_DISCLAIMERS, SEED_LEXICON, SEED_MARKETS, SEED_TYPE_STYLES, SEED_VOICE } from './data/brand.js';
import { SEED_TOKENS } from './data/tokens.js';
import { SEED_RULES } from './data/rules.js';
import { SEED_ASSETS_DIR, storageRoot } from './lib/io.js';

/* --------------------------------------------------------------------------
 * Output helpers. No dependencies — this runs before anything else exists.
 * ------------------------------------------------------------------------ */
const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  cyan: '[36m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
};
const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (color: string, text: string) => (supportsColor ? `${color}${text}${C.reset}` : text);

const out = (line = '') => process.stdout.write(`${line}\n`);
const step = (label: string, detail: string) => out(`  ${label.padEnd(24)} ${paint(C.dim, detail)}`);
const heading = (text: string) => {
  out();
  out(`  ${paint(C.cyan, text)}`);
  out(`  ${paint(C.dim, '-'.repeat(Math.max(24, text.length)))}`);
};

async function main(): Promise<void> {
  const started = Date.now();

  out();
  out(`  ${paint(C.bold, 'BrandLens · seed')}`);
  out(`  ${paint(C.dim, (process.env.DATABASE_URL ?? 'postgresql://brandlens:***@localhost:5432/brandlens').replace(/:[^:@/]+@/, ':****@'))}`);

  const db = getDb();

  /* ------------------------------------------------------------------ *
   * 1 — tenant
   *
   * `organizations`, `users` and `memberships` sit outside the RLS policy
   * set, but `api_keys` does not, so the whole step runs with the tenant
   * bound AND bypass on: creating the tenant necessarily happens before the
   * tenant exists, which is one of a handful of legitimately cross-tenant
   * writes (the API's own registration path does the same thing).
   * ------------------------------------------------------------------ */
  heading('tenant');
  const tenant = await withTenant(
    db,
    { orgId: '00000000-0000-0000-0000-000000000000', bypassRls: true },
    (tx) => seedTenant(tx),
  );
  step('organization', 'Northwind Coffee Co.');
  step('users', `${Object.keys(USERS).length} (owner, reviewer, creator)`);
  step('api key', tenant.apiKeyUsable ? `${tenant.apiKeyPrefix}… (usable)` : `${tenant.apiKeyPrefix}… (API_KEY_PEPPER not set)`);

  /* ------------------------------------------------------------------ *
   * 2 — global channel spec registry (org_id IS NULL ⇒ needs bypass)
   * ------------------------------------------------------------------ */
  heading('channel specs');
  const channelSpecCount = await withTenant(
    db,
    { orgId: tenant.orgId, bypassRls: true },
    (tx) => seedChannelSpecs(tx),
  );
  step('global registry', `${channelSpecCount} specs (meta, tiktok, google, linkedin, amazon, print)`);

  /* ------------------------------------------------------------------ *
   * 3 — ontology, assets and the check run, all under the tenant.
   *
   * One transaction: a half-seeded brand with rules but no ruleset would make
   * every check fail with NoActiveRuleset, which looks like a product bug.
   * ------------------------------------------------------------------ */
  const result = await withTenant(db, { orgId: tenant.orgId, userId: USERS.owner.id }, async (tx) => {
    const ontology = await seedOntology(tx, tenant.orgId);
    const assetResult = await seedAssets(tx, tenant.orgId, ontology.brandId);
    const checks = await seedChecks(
      tx,
      tenant.orgId,
      ontology.brandId,
      ontology.rulesetId,
      ontology.rulesetHash,
      ontology.ruleIdByKey,
      ontology.ruleVersionByKey,
      assetResult.assets,
    );
    return { ontology, assetResult, checks };
  });

  const { ontology, assetResult, checks } = result;

  heading('brand ontology');
  step('brands', 'Northwind + Northwind Reserve (sub-brand)');
  step('markets', SEED_MARKETS.map((m) => m.code).join(', '));
  step('design tokens', `${SEED_TOKENS.length} (DTCG, with CIELAB precomputed)`);
  step('logo variants', `${ontology.logos.length} PNGs generated`);
  step('type styles', `${SEED_TYPE_STYLES.length} + 6 forbidden fonts`);
  step('voice attributes', `${SEED_VOICE.length} axes, 3 exemplars per side`);
  step('lexicon', `${SEED_LEXICON.length} terms`);
  step('claims', `${SEED_CLAIMS.length} (1 expired, 1 wrong-jurisdiction — deliberately)`);
  step('disclaimers', `${SEED_DISCLAIMERS.length} with size / contrast / proximity rules`);
  step(
    'rules',
    `${SEED_RULES.length} total — ${SEED_RULES.filter((r) => r.status === 'active').length} active, ` +
      `${ontology.proposedRuleCount} awaiting review`,
  );
  step(
    'ruleset',
    `v1 · ${ontology.rulesetHash.slice(0, 16)}… · ${ontology.activeRuleCount} rules ` +
      `(Reserve-owned rules compile into the Reserve brand's own ruleset)`,
  );

  heading('assets');
  step('campaign', 'Autumn 2026 — Better Sorted');
  step('creatives', `${assetResult.assets.length} PNGs — ${assetResult.exemplarCount} approved exemplars, ${assetResult.violationCount} with planted defects`);
  step('written to', SEED_ASSETS_DIR);
  step('storage root', storageRoot());

  heading('check run');
  step('score', `${checks.score ?? '—'} (${checks.scoreBand ?? 'n/a'})`);
  step('criteria', `${checks.criteriaTotal} evaluated · ${checks.criteriaFailed} failed · ${checks.criteriaAbstained} abstained`);
  step('coverage rate', checks.coverageRate === null ? '—' : `${(checks.coverageRate * 100).toFixed(1)}% auto-decided`);
  step('findings', `${checks.findingCount}`);
  step('human decisions', `1 confirm, ${checks.overrideCount} override`);
  step('precedents', `${checks.precedentCount} indexed for retrieval`);

  /* ------------------------------------------------------------------ *
   * Summary
   * ------------------------------------------------------------------ */
  const apiUrl = (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const webUrl = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  out();
  out(`  ${paint(C.green, `Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s.`)}`);
  out();
  out(`  ${paint(C.cyan, 'Sign in')}`);
  out(`    ${webUrl}/login`);
  out();
  out(`    ${'owner@northwind.test'.padEnd(26)} ${DEMO_PASSWORD}   ${paint(C.dim, 'full access, publishes rulesets')}`);
  out(`    ${'reviewer@northwind.test'.padEnd(26)} ${DEMO_PASSWORD}   ${paint(C.dim, 'decides findings — their calls become gold labels')}`);
  out(`    ${'creator@northwind.test'.padEnd(26)} ${DEMO_PASSWORD}   ${paint(C.dim, 'submits assets, sees own results')}`);
  out();
  out(`  ${paint(C.cyan, 'Worth opening first')}`);
  out(`    ${webUrl}/checks/${checks.checkRunId}`);
  out(`      ${paint(C.dim, 'the completed run: 6 findings, one human override, full traces')}`);
  out(`    ${webUrl}/rules`);
  out(`      ${paint(C.dim, `${ontology.proposedRuleCount} proposed rules waiting — some cited to a brand-book page, some induced`)}`);
  out(`    ${webUrl}/claims`);
  out(`      ${paint(C.dim, 'one expired claim and one used outside its jurisdiction')}`);
  out();
  out(`  ${paint(C.cyan, 'API')}`);
  out(`    ${apiUrl}/docs`);
  out();
  if (tenant.apiKeyUsable) {
    out(`    curl -s ${apiUrl}/v1/brands \\`);
    out(`      -H "Authorization: Bearer ${tenant.apiKeyPlaintext}"`);
    out();
    out(`    ${paint(C.yellow, 'The seeded API key is a DEMO credential. Revoke it before this host')}`);
    out(`    ${paint(C.yellow, 'is reachable by anyone else:')}  DELETE ${apiUrl}/v1/api-keys/{id}`);
  } else {
    out(`    ${paint(C.yellow, 'No demo API key was created: API_KEY_PEPPER is unset or still the')}`);
    out(`    ${paint(C.yellow, 'placeholder. Set it in .env and re-run `pnpm db:seed`.')}`);
  }
  out();
  out(`  ${paint(C.dim, 'Re-running this seed is safe — every row is keyed deterministically.')}`);
  out();
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    process.stderr.write(
      `\n  ${paint(C.red, 'seed failed')}: ${err instanceof Error ? err.stack : String(err)}\n\n`,
    );
    process.stderr.write(
      `  ${paint(C.dim, 'Common causes:')}\n` +
        `    - the database has not been migrated yet  ->  pnpm db:migrate\n` +
        `    - DATABASE_URL in .env points somewhere unexpected\n` +
        `    - seed/assets is not writable\n\n`,
    );
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
