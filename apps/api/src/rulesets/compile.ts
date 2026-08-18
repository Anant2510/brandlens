import type { RuleDefinition } from '@brandlens/contracts';
import { rulesetHash as hashRuleset } from '../common/hash';
import { computeSpecificity, resolveByKey, type ScopeContext } from './specificity';

/* ==========================================================================
 * Brand compile — pure, dependency-free.
 *
 * Shared verbatim with the worker: a ruleset compiled in the queue must hash
 * identically to one compiled in the API, because the hash IS the cache key.
 * Two implementations would drift and silently halve the cache hit rate.
 * ========================================================================== */

export interface ScoringConfig {
  dimensionWeights: Record<string, number>;
  passThreshold: number;
  conditionalThreshold: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  dimensionWeights: {},
  passThreshold: 85,
  conditionalThreshold: 70,
};

export interface CompiledRule {
  id: string;
  key: string;
  version: number;
  statement: string;
  rationale: string | null;
  dimension: string;
  tier: string;
  severity: string;
  weight: number;
  scope: Record<string, unknown>;
  specificity: number;
  check: { fn: string; params?: Record<string, unknown> };
  rubric: Record<string, unknown> | null;
  provenance: string;
  citation: Record<string, unknown> | null;
  status: string;
  optimizedPromptHash: string | null;
  /** beta < 0.3 ⇒ the judge does not track this tenant's reviewers. */
  autoRouteToHuman: boolean;
  createdAt?: Date | string | null;
}

/** The frozen artefact a check run is executed against. */
export interface CompiledRuleset {
  brandId: string;
  rules: CompiledRule[];
  scoringConfig: ScoringConfig;
  ruleCount: number;
  /** Deterministic — computed from rules + scoring only, never timestamps. */
  hash: string;
}

/** Shape of a `rules` row, narrowed to what compilation actually reads. */
export interface CompilableRuleRow {
  id: string;
  key: string;
  version: number;
  statement: string;
  rationale: string | null;
  dimension: string;
  tier: string;
  severity: string;
  weight: number;
  scope: Record<string, unknown> | null;
  check: { fn: string; params?: Record<string, unknown> } | null;
  rubric: Record<string, unknown> | null;
  provenance: string;
  citation: Record<string, unknown> | null;
  status: string;
  optimizedPromptHash: string | null;
  calibration: { autoRouteToHuman?: boolean } | null;
  createdAt: Date;
}

export function compileRows(
  brandId: string,
  rows: ReadonlyArray<CompilableRuleRow>,
  scoring?: Partial<ScoringConfig>,
): CompiledRuleset {
  const scoringConfig: ScoringConfig = {
    dimensionWeights: scoring?.dimensionWeights ?? DEFAULT_SCORING.dimensionWeights,
    passThreshold: scoring?.passThreshold ?? DEFAULT_SCORING.passThreshold,
    conditionalThreshold: scoring?.conditionalThreshold ?? DEFAULT_SCORING.conditionalThreshold,
  };

  const compiled: CompiledRule[] = rows
    .map((r) => ({
      id: r.id,
      key: r.key,
      version: r.version,
      statement: r.statement,
      rationale: r.rationale,
      dimension: r.dimension,
      tier: r.tier,
      severity: r.severity,
      weight: r.weight,
      scope: r.scope ?? {},
      // Recomputed rather than trusted: the stored column can drift if a rule
      // was written by an older client, and the hash must reflect the truth.
      specificity: computeSpecificity(r.scope ?? {}),
      check: r.check ?? { fn: 'noop', params: {} },
      rubric: r.rubric ?? null,
      provenance: r.provenance,
      citation: r.citation ?? null,
      status: r.status,
      optimizedPromptHash: r.optimizedPromptHash,
      autoRouteToHuman: Boolean(r.calibration?.autoRouteToHuman),
      createdAt: r.createdAt,
    }))
    // Sorted before hashing so row order from Postgres cannot change the hash.
    .sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version);

  const hash = hashRuleset({
    rules: compiled as unknown as ReadonlyArray<Record<string, unknown>>,
    scoringConfig: scoringConfig as unknown as Record<string, unknown>,
  });

  return { brandId, rules: compiled, scoringConfig, ruleCount: compiled.length, hash };
}

/** Most-specific-wins resolution for one concrete asset context. */
export function resolveForContext(compiled: CompiledRuleset, ctx: ScopeContext): CompiledRule[] {
  return resolveByKey(compiled.rules, ctx);
}

/** Compiled rules translated to the engine's `RuleDefinition` contract. */
export function toRuleDefinitions(compiled: readonly CompiledRule[]): RuleDefinition[] {
  return compiled.map((r) => ({
    id: r.id,
    key: r.key,
    version: r.version,
    statement: r.statement,
    rationale: r.rationale ?? undefined,
    dimension: r.dimension as RuleDefinition['dimension'],
    tier: r.tier as RuleDefinition['tier'],
    severity: r.severity as RuleDefinition['severity'],
    weight: r.weight,
    scope: r.scope as RuleDefinition['scope'],
    check: { fn: r.check.fn, params: r.check.params ?? {} },
    rubric: (r.rubric ?? undefined) as RuleDefinition['rubric'],
    provenance: r.provenance as RuleDefinition['provenance'],
    citation: (r.citation ?? undefined) as RuleDefinition['citation'],
    status: 'active',
  }));
}
