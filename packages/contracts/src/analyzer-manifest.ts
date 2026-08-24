import { GENERATED_ANALYZER_MANIFEST, GENERATED_SPEC_KEYS } from './analyzer-manifest.generated.js';

/* ==========================================================================
 * The contract between a rule and the analyzer that executes it.
 *
 * A rule is authored in TypeScript and executed in Python, and the bridge is
 * `check.params` — an untyped JSON blob. Nothing in either language checks
 * that the key a rule writes is the key an analyzer reads, and a mismatch is
 * not an error: the analyzer falls back to its default and the rule enforces
 * something other than what it says. A threshold that shows in the console,
 * shows in the audit trail, and does nothing is worse than a missing rule,
 * because somebody signed off on it.
 *
 * So the manifest is extracted from the Python source by AST
 * (apps/engine/scripts/analyzer_params.py) and the helpers below turn it into
 * assertions rule-authoring code can be held to.
 * ========================================================================== */

export type ParamDefault = string | number | boolean | null;

export interface AnalyzerContract {
  /** `module.function` in the engine — where to go and read the truth. */
  readonly fn: string;
  /** Accepted `check.params` keys, mapped to the default when omitted. */
  readonly params: Readonly<Record<string, ParamDefault>>;
  /**
   * `ctx.brand.*` attributes the analyzer reads.
   *
   * This is the field that decides whether a rule can ship as a baseline. An
   * analyzer with an ontology dependency returns `not_applicable` on a brand
   * that has not populated it — so a "baseline" rule built on one is present,
   * green, and inert on exactly the brands baselines exist to serve.
   */
  readonly ontology: readonly string[];
  /** `ctx.asset.*` fields the analyzer reads. */
  readonly asset: readonly string[];
}

export const ANALYZER_MANIFEST: Readonly<Record<string, AnalyzerContract>> =
  GENERATED_ANALYZER_MANIFEST;

export type AnalyzerName = keyof typeof GENERATED_ANALYZER_MANIFEST;

/** Every registered analyzer name, sorted. */
export const ANALYZER_NAMES: readonly string[] = Object.keys(ANALYZER_MANIFEST).sort();

/**
 * Ontology attributes the PLATFORM supplies, not the customer.
 *
 * `ctx.brand.channelSpec` is filled from the shipped channel-spec registry —
 * fifteen placements with the published sizes, safe zones and print geometry —
 * and a tenant row only ever overrides one. It arrives in the brand context
 * alongside logos and type styles and is indistinguishable from them in the
 * manifest, but it means the opposite thing: an analyzer that reads it is
 * ready on day one, and listing it as a dependency would put "waiting on your
 * channel spec" in front of every customer for something already in the box.
 *
 * What these rules do wait for is asset metadata — a platform and placement on
 * the asset — which is a property of the upload, not of the ontology.
 */
export const PLATFORM_SUPPLIED_ONTOLOGY: readonly string[] = ['channel_spec'];

/** The ontology a rule genuinely waits on the customer for. */
export function customerOntology(fn: string): readonly string[] {
  return (analyzerContract(fn)?.ontology ?? []).filter((o) => !PLATFORM_SUPPLIED_ONTOLOGY.includes(o));
}

/** Analyzers usable on day one: nothing needed that the customer has to supply. */
export const ONTOLOGY_FREE_ANALYZERS: readonly string[] = ANALYZER_NAMES.filter(
  (name) => customerOntology(name).length === 0,
);

export function analyzerContract(fn: string): AnalyzerContract | null {
  return ANALYZER_MANIFEST[fn] ?? null;
}

/* --------------------------------------------------------------------------
 * The same contract, one level down: a channel spec and the analyzer that
 * reads it.
 *
 * A registry row is a published constraint. A key in it that no analyzer looks
 * at is not a no-op, it is a promise: the placement's spec says 3mm of bleed,
 * the console shows 3mm of bleed, and every asset passes. That is the failure
 * the parameter manifest exists to prevent, moved down a layer, and it went
 * unnoticed longer because a spec looks like data rather than like code.
 * ------------------------------------------------------------------------ */
export type SpecKeyRole = 'enforced' | 'delegated' | 'authorable' | 'unmeasurable' | 'reference';

export interface SpecKeyContract {
  readonly role: string;
  readonly summary: string;
  /** The analyzer that enforces it, for `delegated` and `authorable`. */
  readonly by: string;
  /** Why it is not enforced by `channel_spec.conformance`. */
  readonly detail: string;
}

export const CHANNEL_SPEC_KEYS: Readonly<Record<string, SpecKeyContract>> = GENERATED_SPEC_KEYS;

export function specKeyContract(key: string): SpecKeyContract | null {
  return CHANNEL_SPEC_KEYS[key] ?? null;
}

/** Keys in a spec that no analyzer reads. Empty when the spec is fully wired. */
export function unrecognisedSpecKeys(spec: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(spec)
    .filter((key) => !(key in CHANNEL_SPEC_KEYS))
    .sort();
}

/** A message naming the dead keys and the nearest live one, or null. */
export function formatSpecDrift(spec: Readonly<Record<string, unknown>>, where: string): string | null {
  const dead = unrecognisedSpecKeys(spec);
  if (dead.length === 0) return null;
  const known = Object.keys(CHANNEL_SPEC_KEYS);
  const lines = dead.map((key) => {
    const near = nearest(key, known);
    return `    · “${key}” is read by nothing${near ? ` — did you mean “${near}”?` : ''}`;
  });
  return (
    `${where}: ${dead.length} spec key(s) constrain nothing.\n${lines.join('\n')}\n` +
    '    Add them to SPEC_KEYS in apps/engine/brandlens_engine/channel_spec.py — as `enforced` if the ' +
    'engine can measure them, or with the role and reason it cannot — then re-run analyzer_params.py.'
  );
}

export interface ParamDrift {
  /** The key the rule wrote. */
  readonly key: string;
  /** The closest accepted key, when one is close enough to be a likely typo. */
  readonly didYouMean: string | null;
  /**
   * What the analyzer uses instead. `undefined` means the key is accepted but
   * has no default — the analyzer treats it as unset and usually skips the
   * comparison entirely, which is a silent pass rather than a wrong threshold.
   */
  readonly fallsBackTo: ParamDefault | undefined;
}

export interface CheckDrift {
  readonly fn: string;
  /** True when `fn` is not registered at all — the whole rule never runs. */
  readonly unknownAnalyzer: boolean;
  readonly deadParams: readonly ParamDrift[];
}

/**
 * Reports the keys in `params` that the analyzer never reads.
 *
 * Returns `null` when the check is clean, so a caller can write
 * `expect(describeCheckDrift(...)).toBeNull()` and get the whole diagnosis in
 * the failure message rather than a bare `false`.
 */
export function describeCheckDrift(
  fn: string,
  params: Readonly<Record<string, unknown>> | undefined | null,
): CheckDrift | null {
  const contract = analyzerContract(fn);
  if (!contract) {
    return { fn, unknownAnalyzer: true, deadParams: [] };
  }

  const accepted = Object.keys(contract.params);
  const dead: ParamDrift[] = [];
  for (const key of Object.keys(params ?? {})) {
    if (key in contract.params) continue;
    const near = nearest(key, accepted);
    dead.push({
      key,
      didYouMean: near,
      fallsBackTo: near ? contract.params[near] : undefined,
    });
  }
  return dead.length > 0 ? { fn, unknownAnalyzer: false, deadParams: dead } : null;
}

/** A one-line-per-problem rendering, for test failures and CI logs. */
export function formatCheckDrift(drift: CheckDrift, ruleKey?: string): string {
  const where = ruleKey ? `${ruleKey} (${drift.fn})` : drift.fn;
  if (drift.unknownAnalyzer) {
    return `${where}: no analyzer registered under this name — the rule would never execute.`;
  }
  const lines = drift.deadParams.map((d) => {
    const hint = d.didYouMean
      ? ` — did you mean “${d.didYouMean}”? (the analyzer is using ${JSON.stringify(d.fallsBackTo)})`
      : ' — the analyzer reads no such key';
    return `    · “${d.key}” is never read${hint}`;
  });
  const accepted = Object.keys(ANALYZER_MANIFEST[drift.fn]!.params);
  lines.push(`    accepted: ${accepted.length > 0 ? accepted.join(', ') : '(none — this analyzer takes no parameters)'}`);
  return `${where}:\n${lines.join('\n')}`;
}

/**
 * Levenshtein, capped: a suggestion is only offered when the two names are
 * plausibly the same word misremembered. Suggesting `basis` for `minPx` would
 * send somebody off to change the wrong thing.
 */
function nearest(key: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const lower = key.toLowerCase();
  for (const candidate of candidates) {
    const score = distance(lower, candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === null) return null;
  const limit = Math.max(2, Math.floor(Math.max(key.length, best.length) / 3));
  return bestScore <= limit ? best : null;
}

function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
