import { ANALYZER_MANIFEST } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import { SEED_RULES } from './rules.js';
import { checkSignature, seedRuleProblems } from './validate.js';

/*
 * The seed is data, and data with an invariant deserves a test.
 *
 * `assertSeedRulesExecutable` already runs inside the seed itself, which means
 * CI catches a broken rule when it seeds a real Postgres. This runs in the
 * unit suite instead: seconds rather than minutes, on Windows as well as
 * Ubuntu, and it fails on the file rather than on a database job whose log
 * nobody opens.
 */
describe('the seeded rule set', () => {
  it('enforces what every rule states', () => {
    // Rendered, not counted: on failure the message names each dead key, the
    // key that was probably meant, and the value the engine used instead.
    expect(seedRuleProblems().join('\n\n')).toBe('');
  });

  it('names a registered analyzer for every rule', () => {
    for (const rule of SEED_RULES) {
      expect({ rule: rule.key, fn: rule.check.fn, registered: rule.check.fn in ANALYZER_MANIFEST }).toMatchObject({
        registered: true,
      });
    }
  });

  it('has unique keys', () => {
    const keys = SEED_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not run the same analyzer twice with identical parameters', () => {
    /*
     * Two rules that call the same analyzer with the same parameters produce
     * the same verdict from the same measurement, and the console shows them
     * as two independent confirmations — or, on a failure, as two findings
     * for one defect. It is how four channel-spec rules and three claim rules
     * came to exist here, each running a complete single-pass check.
     *
     * Same analyzer with DIFFERENT parameters is fine and common: two size
     * floors at two thresholds are two real rules.
     */
    const seen = new Map<string, string>();
    for (const rule of SEED_RULES) {
      const signature = `${rule.brand ?? 'northwind'}|${checkSignature(rule.check, rule.rubric as { question?: string } | undefined)}|${JSON.stringify(rule.scope ?? {})}`;
      const first = seen.get(signature);
      expect(first ? `${first} and ${rule.key} are the same check twice` : null).toBeNull();
      seen.set(signature, rule.key);
    }
  });

  it('proposes rather than activates anything a machine derived', () => {
    for (const rule of SEED_RULES) {
      if (rule.provenance === 'inductive' && rule.status === 'active') {
        // Induced rules may ship active only with support evidence attached —
        // otherwise the seed is asserting a convention nobody measured.
        expect({ rule: rule.key, hasSupport: Boolean(rule.support) }).toMatchObject({ hasSupport: true });
      }
    }
  });
});
