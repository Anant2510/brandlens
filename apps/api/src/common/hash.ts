import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/* ==========================================================================
 * Content hashing — the idempotency, cache and audit anchor of the system.
 *
 * Everything here is a PURE FUNCTION of its inputs. That is not a style
 * preference: `jobKey` is a uniqueness constraint in Postgres and `traceKey`
 * is the cache key for paid model calls. If either of them picked up ambient
 * state (a timestamp, a uuid, map iteration order) the cache would silently
 * miss forever and the audit trail would stop being reproducible.
 * ========================================================================== */

/** Bumped whenever the orchestration contract changes shape. Part of jobKey. */
export const PIPELINE_VERSION = '1.0.0';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Short(input: string | Buffer, length = 32): string {
  return sha256(input).slice(0, length);
}

/**
 * Deterministic, canonical JSON.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * objects built by different code paths stringify differently and hash
 * differently. We sort object keys recursively, normalise `undefined` away and
 * keep array order (arrays are ordered data, objects are not).
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
      if (v === undefined) continue; // absent and explicit-undefined must hash alike
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/** sha256 over the canonical form of any structure. */
export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Content hash of raw bytes. Dedupe key, cache key and audit anchor. */
export function contentHash(bytes: Buffer): string {
  return sha256(bytes);
}

export interface JobKeyInput {
  /** sha256 of the asset bytes. Same pixels ⇒ same measurements. */
  assetContentHash: string;
  /** Hash of the frozen ruleset snapshot. Rule edit ⇒ precise invalidation. */
  rulesetHash: string;
  /** Orchestration contract version. */
  pipelineVersion: string;
  /** Judge model identity — a model swap must not reuse the old verdict. */
  modelVersion: string;
  /** Hash of the rendered prompt template (incl. per-tenant optimisation). */
  promptHash: string;
  /** Optional narrowing (dimension filter, deterministic-only) so a partial
   *  re-check never collides with the full run it is a subset of. */
  variant?: string;
}

/**
 * `jobKey = hash(assetContentHash, rulesetHash, pipelineVersion,
 *                modelVersion, promptHash)`
 *
 * Those five inputs are exactly the set of things that can change the answer.
 * Hashing them together buys four properties from one column:
 *   1. idempotency  — retries and duplicate POSTs collapse onto one run;
 *   2. caching      — an unchanged asset under an unchanged ruleset is free;
 *   3. invalidation — publishing a ruleset changes rulesetHash, so every
 *                     affected run re-executes, and only those;
 *   4. audit        — a regulator can be told precisely which bytes, rules,
 *                     code and model produced a verdict.
 */
export function jobKey(input: JobKeyInput): string {
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

export interface TraceKeyInput {
  assetContentHash: string;
  rulesetHash: string;
  ruleKey: string;
  ruleVersion: number;
  modelVersion: string;
  promptHash: string;
}

/**
 * Per-criterion cache key. Finer-grained than `jobKey` on purpose: editing one
 * rule changes the ruleset hash and therefore the job key, but every OTHER
 * rule's trace key is unchanged, so the expensive VLM verdicts for untouched
 * rules are replayed from cache instead of re-purchased.
 */
export function traceKey(input: TraceKeyInput): string {
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
 * Hash of a compiled ruleset. Only the semantically meaningful fields take
 * part — labels, publish timestamps and row ids must not change the hash, or
 * a cosmetic edit would invalidate every cached verdict in the tenant.
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

/** Derivative cache key: same bytes + same transform ⇒ same file, reused. */
export function transformHash(transform: Record<string, unknown>): string {
  return sha256Short(canonicalJson(transform), 40);
}

/** Stable hash of a prompt template + its bound variables. */
export function promptHash(template: string, variables: Record<string, unknown> = {}): string {
  return sha256Short(canonicalJson({ template, variables }), 40);
}

/* --------------------------------------------------------------------------
 * Keyed hashing — API keys, signed URLs, webhook signatures.
 * ------------------------------------------------------------------------ */

export function hmacSha256(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * API keys are hashed with a server-side pepper rather than a per-row salt:
 * lookup has to be O(1) on every request, and a peppered digest keeps the
 * database dump useless on its own while still being directly indexable.
 */
export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext).digest('hex');
}

export function generateApiKey(prefix = 'bl_live'): { plaintext: string; prefix: string } {
  const secret = randomBytes(24).toString('base64url');
  const plaintext = `${prefix}_${secret}`;
  // The stored prefix is what the UI shows and what the guard indexes on.
  return { plaintext, prefix: plaintext.slice(0, 16) };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time compare that tolerates length mismatch without leaking it. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still burn a comparison so the timing profile does not reveal length.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
