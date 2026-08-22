import {
  customerOntology,
  describeCheckDrift,
  formatCheckDrift,
  formatSpecDrift,
  missingRubricProblem,
} from '@brandlens/contracts';
import { SEED_CHANNEL_SPECS } from './channel-specs.js';
import { SEED_RULES } from './rules.js';
import { SEED_RULE_PACKS } from './rule-packs.js';

/* ==========================================================================
 * Does every seeded rule actually enforce what it says?
 *
 * A rule is authored here in TypeScript and executed by an analyzer written in
 * Python. The bridge is `check.params`, an untyped JSON blob, and a key the
 * analyzer does not read is not an error — it falls back to its default and
 * the rule quietly enforces something else. The console still shows the
 * threshold. The audit trail still records it. Somebody still signed it off.
 *
 * An audit against the generated analyzer manifest found this in 56 of 57
 * seeded rules: `minPx` where the engine reads `minSizePt`, percentages where
 * it wants fractions, width where it measures height, four channel-spec rules
 * running the identical single-pass validation. So the check runs at seed
 * time, before a single row is written, and it fails the seed rather than
 * warning: a demo database full of rules that display one number and enforce
 * another is worse than no demo database.
 * ========================================================================== */

/** Analyzers that take a nested params object destined for another analyzer. */
const NESTED_PARAMS: Record<string, { fnKey: string; paramsKey: string }> = {
  'vlm.rule_adjudication': { fnKey: 'measuredBy', paramsKey: 'measureParams' },
};

export function seedRuleProblems(): string[] {
  const problems: string[] = [];

  for (const rule of SEED_RULES) {
    const drift = describeCheckDrift(rule.check.fn, rule.check.params);
    if (drift) problems.push(formatCheckDrift(drift, rule.key));

    // The hybrid tier runs an inner analyzer with its own params, and those
    // are just as capable of naming a key nobody reads — more so, because they
    // are one level further from anywhere a person would look.
    const nested = NESTED_PARAMS[rule.check.fn];
    if (!nested) continue;
    const params = (rule.check.params ?? {}) as Record<string, unknown>;
    const innerFn = params[nested.fnKey];
    if (typeof innerFn !== 'string' || innerFn.length === 0) continue;

    const innerParams = params[nested.paramsKey];
    const innerDrift = describeCheckDrift(
      innerFn,
      (innerParams ?? {}) as Record<string, unknown>,
    );
    if (innerDrift) problems.push(formatCheckDrift(innerDrift, `${rule.key} → ${nested.paramsKey}`));
  }

  return problems;
}

/** Throws with every problem listed, rather than the first one found. */
export function assertSeedRulesExecutable(): void {
  raise(seedRuleProblems(), 'seeded rule');
}

/* --------------------------------------------------------------------------
 * The shipped packs get one extra check the tenant seed does not need.
 *
 * A template declares `needs` — the ontology it waits for — and that is what
 * the console shows a customer: "12 rules are waiting on your logo files".
 * Hand-maintained, it drifts the first time an analyzer starts reading
 * something new, and the failure mode is quiet: a rule that silently needs
 * data nobody was asked for is indistinguishable, on screen, from a rule that
 * is passing. So it is compared against what the engine actually reads.
 * ------------------------------------------------------------------------ */
export function rulePackProblems(): string[] {
  const problems: string[] = [];

  for (const pack of SEED_RULE_PACKS) {
    for (const template of pack.templates) {
      const where = `${pack.key} → ${template.key}`;

      const noRubric = missingRubricProblem(template.check, template.rubric ?? null, where);
      if (noRubric) problems.push(noRubric);

      const drift = describeCheckDrift(template.check.fn, template.check.params);
      if (drift) {
        problems.push(formatCheckDrift(drift, where));
        // Without a contract there is nothing to compare `needs` against, and
        // a second complaint about the same broken name helps nobody.
        continue;
      }

      const actual = [...customerOntology(template.check.fn)].sort();
      const needs = template.needs ?? [];
      const supplied = template.satisfiedByParams ?? [];
      const accounted = [...new Set([...needs, ...supplied])].sort();

      if (actual.join(',') !== accounted.join(',')) {
        problems.push(
          `${where}: accounts for ontology [${accounted.join(', ')}] but ${template.check.fn} reads ` +
            `[${actual.join(', ')}]. Every attribute the analyzer reads must appear in either \`needs\` ` +
            '(the brand must supply it) or `satisfiedByParams` (this template supplies it instead).',
        );
      }

      const overlap = needs.filter((n) => supplied.includes(n));
      if (overlap.length > 0) {
        // Both at once is a contradiction: either the params replace the
        // ontology or they do not, and the console has to say one thing.
        problems.push(`${where}: [${overlap.join(', ')}] is listed as both needed and supplied by params.`);
      }
    }
  }

  return problems;
}

export function assertRulePacksExecutable(): void {
  raise(rulePackProblems(), 'shipped rule template');
}

/* --------------------------------------------------------------------------
 * And the registry, which is the same bug wearing data's clothes.
 *
 * A channel spec is a published constraint: the placement says 3mm of bleed,
 * the console says 3mm of bleed, the audit trail says 3mm of bleed. If the
 * analyzer never reads the key, every asset passes and nobody finds out until
 * a print job comes back. The registry and the analyzer once shared three keys
 * out of forty, so this is not hypothetical — it is what was shipping.
 *
 * `channel_spec.conformance` cannot enforce all of them and does not pretend
 * to; what it must do is ACCOUNT for all of them, which is what `SPEC_KEYS`
 * records and this compares against.
 * ------------------------------------------------------------------------ */
export function channelSpecProblems(): string[] {
  const problems: string[] = [];
  for (const row of SEED_CHANNEL_SPECS) {
    const where = `${row.platform}/${row.placement} (${row.assetType})`;
    const drift = formatSpecDrift(row.spec, where);
    if (drift) problems.push(drift);
  }
  return problems;
}

export function assertChannelSpecsEnforceable(): void {
  raise(channelSpecProblems(), 'shipped channel spec');
}

/**
 * What makes two checks "the same check".
 *
 * Normally it is the analyzer plus its parameters: two rules calling
 * `channel_spec.conformance` with identical params produce one measurement
 * reported twice, which reads as two independent confirmations and, on a
 * failure, as two findings for one defect.
 *
 * `vlm.rubric` is the exception, and not a grudging one — it is the analyzer
 * whose entire job is to execute the rule's own rubric. Two rubric rules with
 * empty params and different questions are two completely different criteria;
 * treating them as duplicates would forbid the one thing the analyzer exists
 * to allow. So for rubric-driven checks the question is part of the identity.
 */
export function checkSignature(
  check: { fn: string; params?: Record<string, unknown> },
  rubric?: { question?: string } | null,
): string {
  const base = `${check.fn}|${JSON.stringify(check.params ?? {})}`;
  return check.fn === 'vlm.rubric' ? `${base}|${rubric?.question ?? ''}` : base;
}

function raise(problems: string[], noun: string): void {
  if (problems.length === 0) return;
  throw new Error(
    `${problems.length} ${noun}${problems.length === 1 ? '' : 's'} would not enforce what they state:\n\n` +
      `${problems.join('\n\n')}\n\n` +
      'Fix the rule, or run apps/engine/scripts/analyzer_params.py if an analyzer changed.',
  );
}
