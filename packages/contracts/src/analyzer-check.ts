import { type CheckDrift, analyzerContract, describeCheckDrift, formatCheckDrift } from './analyzer-manifest.js';

/* ==========================================================================
 * Two ways to act on parameter drift, for two kinds of caller.
 *
 * A rule somebody typed should be REFUSED: they are present, they can be told
 * which key they meant, and a rule saved with a threshold nobody enforces is
 * one that gets signed off and cited later.
 *
 * A rule a machine proposed should be SANITISED: the extractor read a brand
 * book and got most of it right, and throwing the proposal away because it
 * invented one key wastes the part that was correct. The dead keys come off
 * the check and are written into the rationale instead, where the human
 * reviewing the proposal will see what was dropped and why.
 *
 * What neither does is keep an unreadable key on a check. That is the one
 * outcome with no honest reading — the console shows a number, the audit trail
 * records it, and the engine uses a different one.
 * ========================================================================== */

export interface CheckSpec {
  fn: string;
  params?: Record<string, unknown> | null;
}

/**
 * Analyzers whose params carry a nested check destined for another analyzer.
 * `vlm.rule_adjudication` runs `measuredBy` with `measureParams`, so a typo in
 * there is one level further from anywhere a person would look for it.
 */
const NESTED: Record<string, { fnKey: string; paramsKey: string }> = {
  'vlm.rule_adjudication': { fnKey: 'measuredBy', paramsKey: 'measureParams' },
};

/** Every drift on a check, including the nested check a hybrid rule runs. */
export function checkDrifts(check: CheckSpec): { label: string; drift: CheckDrift }[] {
  const out: { label: string; drift: CheckDrift }[] = [];

  const drift = describeCheckDrift(check.fn, check.params);
  if (drift) out.push({ label: check.fn, drift });

  const nested = NESTED[check.fn];
  if (nested) {
    const params = (check.params ?? {}) as Record<string, unknown>;
    const innerFn = params[nested.fnKey];
    if (typeof innerFn === 'string' && innerFn.length > 0) {
      const innerDrift = describeCheckDrift(innerFn, (params[nested.paramsKey] ?? {}) as Record<string, unknown>);
      if (innerDrift) out.push({ label: `${check.fn} → ${nested.paramsKey}`, drift: innerDrift });
    }
  }
  return out;
}

/**
 * A single message describing everything wrong with a check, or null.
 *
 * Written to be pasted straight into a 400: it names the key, the key that was
 * probably meant, and the value the engine would have used instead.
 */
export function explainCheck(
  check: CheckSpec,
  ruleKey?: string,
  rubric?: { question?: string | null } | null,
): string | null {
  const problems: string[] = [];

  const missing = missingRubricProblem(check, rubric, ruleKey);
  if (missing) problems.push(missing);

  for (const { label, drift } of checkDrifts(check)) {
    problems.push(formatCheckDrift(drift, ruleKey ?? label));
  }

  return problems.length > 0 ? problems.join('\n') : null;
}

/**
 * Analyzers whose criterion IS the rule's rubric rather than its parameters.
 *
 * `vlm.rubric` executes whatever question the rule carries. That is what makes
 * a semantic rule authorable without an engine deploy — and it means a rule
 * pointed there with no rubric has nothing to adjudicate. The engine reports
 * that as `insufficient_evidence` at check time, which is correct but late:
 * the rule would already be in somebody's ruleset, showing up in the console
 * as a criterion and never returning a verdict.
 */
export const RUBRIC_DRIVEN_ANALYZERS: readonly string[] = ['vlm.rubric'];

/** Null when the check is fine, or a sentence explaining what is missing. */
export function missingRubricProblem(
  check: CheckSpec,
  rubric: { question?: string | null } | null | undefined,
  ruleKey?: string,
): string | null {
  if (!RUBRIC_DRIVEN_ANALYZERS.includes(check.fn)) return null;
  if (rubric && typeof rubric.question === 'string' && rubric.question.trim().length > 0) return null;
  return (
    `${ruleKey ?? check.fn}: ${check.fn} adjudicates the rule's own rubric, so the rule needs a rubric with ` +
    'a question. Without one there is nothing to ask, and the criterion would report insufficient evidence ' +
    'on every asset forever.'
  );
}

export interface SanitisedCheck {
  check: CheckSpec;
  /** Keys removed, as `fn.key` so a nested one is distinguishable. */
  removed: string[];
  /** A sentence for the rule's rationale. Empty when nothing was removed. */
  note: string;
}

/**
 * Strips parameters no analyzer reads, and says what it stripped.
 *
 * Returns the check unchanged when it is clean, so a caller can compare by
 * reference. An unregistered `fn` is left alone: there is nothing to strip,
 * the whole rule is unrunnable, and quietly emptying its params would hide
 * that rather than surface it.
 */
export function sanitiseCheck(check: CheckSpec): SanitisedCheck {
  const drifts = checkDrifts(check);
  if (drifts.length === 0) return { check, removed: [], note: '' };
  if (!analyzerContract(check.fn)) {
    return {
      check,
      removed: [],
      note: `No analyzer is registered as “${check.fn}”, so this rule cannot be evaluated as written.`,
    };
  }

  const params = { ...(check.params ?? {}) } as Record<string, unknown>;
  const removed: string[] = [];

  for (const { drift } of drifts) {
    if (drift.unknownAnalyzer) continue;
    const isNested = drift.fn !== check.fn;
    const target = isNested ? ({ ...((params.measureParams ?? {}) as Record<string, unknown>) }) : params;

    for (const dead of drift.deadParams) {
      delete target[dead.key];
      removed.push(`${drift.fn}.${dead.key}`);
    }
    if (isNested) params.measureParams = target;
  }

  if (removed.length === 0) return { check, removed: [], note: '' };
  return {
    check: { fn: check.fn, params },
    removed,
    note:
      `The extraction also proposed ${removed.map((r) => `“${r.split('.').pop()}”`).join(', ')}, which ` +
      `${removed.length === 1 ? 'is not a setting' : 'are not settings'} the check reads. ` +
      `${removed.length === 1 ? 'It has' : 'They have'} been dropped rather than shown as a threshold ` +
      'nothing enforces.',
  };
}
