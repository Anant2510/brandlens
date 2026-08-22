import { inheritedCompileRows } from '@brandlens/db/seed/rule-packs';
import { describe, expect, it } from 'vitest';
import { compileRows, type CompilableRuleRow } from './compile';

/* ==========================================================================
 * The seed and the API must compile the same rules to the same hash.
 *
 * The seed publishes a ruleset row at install time. The API recompiles from
 * the same rows the next time anybody edits a rule and republishes. The hash
 * is the cache key for every decision trace, so if the two implementations
 * disagree by so much as a field, republishing an unchanged ruleset mints a
 * new version and silently invalidates every cached verdict in the tenant.
 *
 * The seed used to mirror only a field list, and a comment said so. Rule packs
 * made it mirror the MERGE as well — which rows are inherited, what status and
 * provenance they carry, what specificity they compile to. A comment is not
 * enough to hold that in step, so this compares the two against real data.
 *
 * This test lives in the API rather than in the db package because the
 * dependency only runs one way: an app may import a package, a package must
 * not import an app.
 * ========================================================================== */

const COMPILED_AT = new Date('2026-03-01T00:00:00Z');

describe('seed / API compile parity', () => {
  it('produces rows the API compile accepts unchanged', () => {
    const rows = inheritedCompileRows(COMPILED_AT);
    expect(rows.length).toBeGreaterThan(0);

    // Structural: every field `CompilableRuleRow` requires is present and the
    // right shape. A missing `calibration` would compile to `autoRouteToHuman:
    // false` either way and hide the omission, so it is asserted explicitly.
    for (const row of rows) {
      const compilable: CompilableRuleRow = row;
      expect(compilable.check?.fn.length ?? 0).toBeGreaterThan(0);
      expect(compilable.origin).toBe('inherited');
      expect(compilable.packKey).toBeTruthy();
      expect(compilable.calibration).toBeNull();
    }
  });

  it('labels every inherited rule as transferred, never as the brand’s own work', () => {
    // Provenance is what the console shows beside a finding. An inherited
    // standard marked `inductive` would claim this brand's own assets taught
    // us the threshold, which is the opposite of true.
    for (const row of inheritedCompileRows(COMPILED_AT)) {
      expect({ key: row.key, provenance: row.provenance }).toMatchObject({ provenance: 'transfer' });
    }
  });

  it('compiles only rules that are meant to be enforced', () => {
    for (const row of inheritedCompileRows(COMPILED_AT)) {
      expect({ key: row.key, status: row.status }).toMatchObject({ status: 'active' });
    }
  });

  it('hashes identically whichever order the rows arrive in', () => {
    // Postgres makes no ordering promise without an ORDER BY, and the seed
    // builds its list in file order. If row order reached the hash, the same
    // ruleset would hash differently on two machines.
    const rows = inheritedCompileRows(COMPILED_AT);
    const forwards = compileRows('brand-1', rows);
    const backwards = compileRows('brand-1', [...rows].reverse());
    expect(backwards.hash).toBe(forwards.hash);
  });

  it('does not let a brand rule and the baseline it overrides collapse into one', () => {
    /*
     * A fork keeps the baseline's key. Both rows must survive into the
     * compiled snapshot — resolution picks the winner per asset, and the rule
     * that lost is exactly what an auditor asks to see. If compilation
     * deduplicated by key, the override would be invisible after the fact.
     */
    const inherited = inheritedCompileRows(COMPILED_AT)[0]!;
    const fork: CompilableRuleRow = {
      ...inherited,
      id: 'brand-owned-id',
      origin: 'brand',
      packKey: null,
      provenance: 'manual',
      weight: inherited.weight + 1,
    };

    const compiled = compileRows('brand-1', [inherited, fork]);
    expect(compiled.ruleCount).toBe(2);
    expect(compiled.rules.filter((r) => r.key === inherited.key)).toHaveLength(2);
    expect(new Set(compiled.rules.map((r) => r.origin))).toEqual(new Set(['brand', 'inherited']));
  });

  it('changes the hash when a fork is added, and again when the pack is disabled', () => {
    // `origin` is deliberately not hashed — see the note on CompiledRule. The
    // hash still moves in both directions, because forking ADDS a row and
    // disabling a pack REMOVES several.
    const rows = inheritedCompileRows(COMPILED_AT);
    const baseline = compileRows('brand-1', rows);

    const withFork = compileRows('brand-1', [
      ...rows,
      { ...rows[0]!, id: 'fork', origin: 'brand', packKey: null, weight: 9 },
    ]);
    expect(withFork.hash).not.toBe(baseline.hash);

    const packDisabled = compileRows(
      'brand-1',
      rows.filter((r: { packKey: string }) => r.packKey !== rows[0]!.packKey),
    );
    expect(packDisabled.hash).not.toBe(baseline.hash);
  });

  it('is unmoved by the timestamp the rows were compiled at', () => {
    // A re-seed on a different day must not mint a new ruleset version.
    const a = compileRows('brand-1', inheritedCompileRows(new Date('2026-03-01T00:00:00Z')));
    const b = compileRows('brand-1', inheritedCompileRows(new Date('2027-11-09T13:45:00Z')));
    expect(b.hash).toBe(a.hash);
  });
});
