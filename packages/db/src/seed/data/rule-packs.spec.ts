import { customerOntology, describeCheckDrift, formatCheckDrift } from '@brandlens/contracts';
import { describe, expect, it } from 'vitest';
import { SEED_RULE_PACKS, type SeedRuleTemplate } from './rule-packs.js';
import { checkSignature } from './validate.js';

const templates: { pack: string; t: SeedRuleTemplate }[] = SEED_RULE_PACKS.flatMap((p) =>
  p.templates.map((t) => ({ pack: p.key, t })),
);

describe('the baseline catalogue', () => {
  it('names an analyzer that exists and passes it only keys it reads', () => {
    for (const { t } of templates) {
      const drift = describeCheckDrift(t.check.fn, t.check.params);
      expect(drift ? formatCheckDrift(drift, t.key) : null).toBeNull();
    }
  });

  it('declares exactly the ontology its analyzer reads', () => {
    /*
     * `needs` is what the console shows a customer — "12 rules are waiting on
     * your logo files". Hand-maintained it would drift the first time an
     * analyzer started reading something new, and a rule that silently needs
     * data nobody was asked for looks like a passing check.
     */
    for (const { t } of templates) {
      const actual = [...customerOntology(t.check.fn)].sort();
      const accounted = [...new Set([...(t.needs ?? []), ...(t.satisfiedByParams ?? [])])].sort();
      expect({ rule: t.key, ontology: accounted }).toEqual({ rule: t.key, ontology: actual });
    }
  });

  it('only claims params replace the ontology where the analyzer allows it', () => {
    // `satisfiedByParams` is a claim that a template's own parameters stand in
    // for brand data. Listing an attribute as both needed and supplied would
    // leave the console with two answers to "is this rule waiting on me?".
    for (const { t } of templates) {
      const both = (t.needs ?? []).filter((n) => (t.satisfiedByParams ?? []).includes(n));
      expect({ rule: t.key, contradictory: both }).toEqual({ rule: t.key, contradictory: [] });
    }
  });

  it('has a pack that produces verdicts on a brand with nothing configured', () => {
    // The onboarding promise. If every pack needed ontology, a new brand would
    // see a wall of `not_applicable` and conclude the product does nothing.
    const dayOne = SEED_RULE_PACKS.filter(
      (p) => p.enabledByDefault && p.templates.some((t) => (t.needs ?? []).length === 0),
    );
    expect(dayOne.map((p) => p.key)).toContain('accessibility-wcag-aa');
    expect(dayOne.map((p) => p.key)).toContain('craft-layout');
  });

  it('ships no regulated pack enabled by default', () => {
    // A coffee brand must not be failed against financial-promotion rules. A
    // tool that cries wolf gets switched off, and the rules it was right about
    // go with it.
    for (const pack of SEED_RULE_PACKS) {
      if (pack.category === 'regulated') expect({ pack: pack.key, on: pack.enabledByDefault }).toMatchObject({ on: false });
    }
  });

  it('gives every regulated pack an authority and a jurisdiction', () => {
    for (const pack of SEED_RULE_PACKS) {
      if (pack.category !== 'regulated') continue;
      expect({ pack: pack.key, authority: Boolean(pack.authority) }).toMatchObject({ authority: true });
      expect({ pack: pack.key, jurisdictions: (pack.jurisdictions ?? []).length }).not.toMatchObject({
        jurisdictions: 0,
      });
    }
  });

  it('gives every VLM-tier template a rubric', () => {
    // A judge with no rubric is being asked "is this good?" — which is how a
    // model verdict becomes unreviewable and uncalibratable.
    for (const { t } of templates) {
      if (t.tier !== 'vlm' && t.tier !== 'hybrid') continue;
      expect({ rule: t.key, hasRubric: Boolean(t.rubric) }).toMatchObject({ hasRubric: true });
    }
  });

  it('never activates a model call in a pack nobody asked for', () => {
    /*
     * A VLM rule active inside a pack that is ON BY DEFAULT spends the
     * customer's money on every asset before anybody agreed the rubric or saw
     * whether the judge agrees with their reviewers.
     *
     * A pack somebody explicitly enabled is different: enabling the gambling
     * pack IS the agreement, and a regulated pack whose rules all arrive
     * proposed does nothing until the customer clicks through twenty of them,
     * which is how a compliance feature ends up unused.
     */
    for (const { pack, t } of templates) {
      const parent = SEED_RULE_PACKS.find((p) => p.key === pack)!;
      if (t.tier !== 'vlm' || !parent.enabledByDefault) continue;
      expect({ rule: t.key, status: t.defaultStatus ?? 'active' }).toMatchObject({ status: 'proposed' });
    }
  });

  it('cites a rulebook on every regulated template', () => {
    // An uncited regulated rule is the most dangerous object in this file: it
    // looks authoritative, it blocks releases, and nobody can check it against
    // the source. Every one of these must name the rule it came from.
    for (const { pack, t } of templates) {
      const parent = SEED_RULE_PACKS.find((p) => p.key === pack)!;
      if (parent.category !== 'regulated') continue;
      expect({ rule: t.key, cited: Boolean(t.citation) }).toMatchObject({ cited: true });
    }
  });

  it('keeps mutually exclusive regulated rules proposed', () => {
    /*
     * The four FCA risk warnings are alternatives — a firm promotes one
     * instrument class. `copy.required_terms` requires EVERY term it is given,
     * so activating all four would fail every promotion ever written. Same
     * shape for the health-claim presence rules, which have to be scoped to
     * the assets that actually make a claim.
     */
    const mustStayProposed = templates.filter(
      ({ t }) => t.key.startsWith('fca.risk-warning.') || t.key === 'health-claims.balanced-diet-statement',
    );
    expect(mustStayProposed.length).toBeGreaterThan(0);
    for (const { t } of mustStayProposed) {
      expect({ rule: t.key, status: t.defaultStatus ?? 'active' }).toMatchObject({ status: 'proposed' });
    }
  });

  it('gives every template guidance a person can act on', () => {
    for (const { t } of templates) {
      expect({ rule: t.key, guidance: (t.guidance ?? '').length > 40 }).toMatchObject({ guidance: true });
    }
  });

  it('keeps an advisory rule out of the score', () => {
    for (const { t } of templates) {
      if (t.severity === 'advisory') expect(t.weight).toBeLessThanOrEqual(0.25);
    }
  });

  it('has unique keys across every pack', () => {
    const keys = templates.map(({ t }) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const packKeys = SEED_RULE_PACKS.map((p) => p.key);
    expect(new Set(packKeys).size).toBe(packKeys.length);
  });

  it('does not run the same analyzer twice with identical parameters in one pack', () => {
    // Two templates calling the same analyzer the same way produce one
    // measurement reported as two independent confirmations.
    for (const pack of SEED_RULE_PACKS) {
      const seen = new Map<string, string>();
      for (const t of pack.templates) {
        const signature = checkSignature(t.check, t.rubric as { question?: string } | undefined);
        const first = seen.get(signature);
        expect(first ? `${pack.key}: ${first} and ${t.key} are the same check twice` : null).toBeNull();
        seen.set(signature, t.key);
      }
    }
  });
});
