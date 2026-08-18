/* ==========================================================================
 * Deterministic identifiers.
 *
 * The seed must be idempotent — `pnpm db:seed` is run on every deploy and on
 * every developer's first checkout. Random uuids would make the second run
 * create a second copy of everything, so every row's primary key is derived
 * from a stable name instead.
 *
 * This is RFC 4122 §4.3 name-based UUIDv5 (SHA-1, namespace-prefixed), which
 * gives three properties that matter here:
 *
 *   1. the same name always produces the same uuid, on any machine;
 *   2. different names effectively never collide;
 *   3. the ids are real v5 uuids, so nothing downstream can tell they were
 *      generated rather than allocated — which matters because the API's zod
 *      contracts validate `z.string().uuid()`.
 * ========================================================================== */

import { createHash } from 'node:crypto';

/**
 * A private namespace uuid for BrandLens seed data. Any constant works; this
 * one is itself a v5 uuid derived from the DNS namespace and 'brandlens.seed',
 * so it is reproducible rather than arbitrary.
 */
export const SEED_NAMESPACE = '9a6e2b6c-1d5a-5c8f-9c9d-3a8e1f7b2c40';

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Not a uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

/** Name-based UUIDv5 under the BrandLens seed namespace. */
export function seedId(...parts: Array<string | number>): string {
  const name = parts.map(String).join(':');
  const hash = createHash('sha1').update(parseUuid(SEED_NAMESPACE)).update(Buffer.from(name, 'utf8')).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** sha256 hex — matches `contentHash` in apps/api/src/common/hash.ts. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` dropped, arrays
 * left in order. Mirrors apps/api/src/common/hash.ts so a hash computed here
 * equals one computed by the API for the same structure.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * `rulesetHash` — byte-for-byte the algorithm in apps/api/src/common/hash.ts.
 *
 * It has to be: the seeded ruleset row carries a hash that the API will
 * recompute the next time a rule is edited and republished. If the two
 * disagreed, republishing an unchanged ruleset would mint a new version and
 * silently invalidate every seeded decision trace's cache entry.
 */
export function rulesetHash(compiled: {
  rules: ReadonlyArray<Record<string, unknown>>;
  scoringConfig?: Record<string, unknown>;
}): string {
  const rules = [...compiled.rules]
    .map((r) => ({
      key: r.key,
      version: r.version,
      statement: r.statement,
      dimension: r.dimension,
      tier: r.tier,
      severity: r.severity,
      weight: r.weight,
      scope: r.scope,
      specificity: r.specificity,
      check: r.check,
      rubric: r.rubric ?? null,
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)) || Number(a.version) - Number(b.version));

  return sha256(canonicalJson({ v: 1, rules, scoringConfig: compiled.scoringConfig ?? {} }));
}

/** `jobKey` — mirrors apps/api/src/common/hash.ts. */
export function jobKey(input: {
  assetContentHash: string;
  rulesetHash: string;
  pipelineVersion: string;
  modelVersion: string;
  promptHash: string;
  variant?: string;
}): string {
  return sha256(
    canonicalJson([
      'bl.job.v1',
      input.assetContentHash,
      input.rulesetHash,
      input.pipelineVersion,
      input.modelVersion,
      input.promptHash,
      input.variant ?? '',
    ]),
  );
}

/** `traceKey` — mirrors apps/api/src/common/hash.ts. */
export function traceKey(input: {
  assetContentHash: string;
  rulesetHash: string;
  ruleKey: string;
  ruleVersion: number;
  modelVersion: string;
  promptHash: string;
}): string {
  return sha256(
    canonicalJson([
      'bl.trace.v1',
      input.assetContentHash,
      input.rulesetHash,
      input.ruleKey,
      input.ruleVersion,
      input.modelVersion,
      input.promptHash,
    ]),
  );
}

/**
 * Scope-lattice specificity. Powers of ten, exactly as in
 * apps/api/src/rulesets/specificity.ts — a rule's stored `specificity` column
 * has to agree with what the compiler recomputes, or resolution order (and
 * therefore the ruleset hash) changes the first time a ruleset is republished.
 */
const SPECIFICITY_WEIGHTS = {
  subBrands: 1,
  markets: 10,
  channels: 100,
  assetTypes: 1_000,
  campaigns: 10_000,
} as const;

export type ScopeSelector = {
  subBrands?: string[];
  markets?: string[];
  channels?: string[];
  assetTypes?: string[];
  campaigns?: string[];
};

function isWildcard(values: string[] | undefined): boolean {
  if (!values || values.length === 0) return true;
  return values.length === 1 && values[0] === '*';
}

export function computeSpecificity(scope: ScopeSelector | null | undefined): number {
  if (!scope) return 0;
  let total = 0;
  for (const axis of Object.keys(SPECIFICITY_WEIGHTS) as Array<keyof typeof SPECIFICITY_WEIGHTS>) {
    if (!isWildcard(scope[axis])) total += SPECIFICITY_WEIGHTS[axis];
  }
  return total;
}
