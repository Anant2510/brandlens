import { describe, expect, it } from 'vitest';
import {
  driftOf,
  forkCitation,
  forkStatus,
  overrideOf,
  packEnablement,
  type ShadowRow,
} from './rule-packs.service';

const shadow = (over: Partial<ShadowRow> = {}): ShadowRow => ({
  id: 'rule-1',
  version: 1,
  status: 'active',
  forkedFromTemplateId: 'template-1',
  forkedFromVersion: 1,
  ...over,
});

describe('packEnablement — absence of a row means "take the default"', () => {
  it('inherits an on-by-default pack with nothing written for the brand', () => {
    // The onboarding promise: a brand created ten seconds ago is checkable
    // without a single row being written for it.
    expect(packEnablement(null, true)).toEqual({ enabled: true, decided: false });
  });

  it('leaves an opt-in pack off until somebody asks for it', () => {
    expect(packEnablement(null, false)).toEqual({ enabled: false, decided: false });
  });

  it('lets a brand switch a default off, and records that it was a decision', () => {
    // `decided` is how the console distinguishes "off because nobody enabled
    // it" from "off because somebody turned it off" — which matters, because
    // only the second one has a reason and an author attached.
    expect(packEnablement({ enabled: false }, true)).toEqual({ enabled: false, decided: true });
  });

  it('lets a brand switch an opt-in pack on', () => {
    expect(packEnablement({ enabled: true }, false)).toEqual({ enabled: true, decided: true });
  });
});

describe('forkStatus — forking never changes what is enforced', () => {
  it('keeps an active standard active', () => {
    /*
     * The load-bearing case. A `proposed` rule is not compiled, so a fork of
     * an ACTIVE template that landed proposed would leave the inherited
     * template applying underneath it: the console would show the brand's
     * rule while a different one did the work.
     */
    expect(forkStatus('active')).toBe('active');
  });

  it('keeps a proposed template proposed', () => {
    // Taking ownership of a suggestion is not the same as agreeing to it.
    expect(forkStatus('proposed')).toBe('proposed');
  });

  it('treats any unrecognised status as proposed rather than enforcing it', () => {
    // Fail closed: an unknown status must never start enforcing something.
    expect(forkStatus('draft')).toBe('proposed');
    expect(forkStatus('')).toBe('proposed');
  });
});

describe('overrideOf', () => {
  it('reports nothing when the brand has no rule with that key', () => {
    expect(overrideOf(null, 'template-1')).toBeNull();
  });

  it('marks a rule forked from this template as a deliberate override', () => {
    expect(overrideOf(shadow(), 'template-1')).toEqual({
      ruleId: 'rule-1',
      version: 1,
      status: 'active',
      forked: true,
    });
  });

  it('still reports a rule that merely collides on key, but not as a fork', () => {
    // Somebody writing their own `logo.clearspace` shadows the baseline just
    // as effectively as forking it. The console needs to show that the
    // baseline is not what runs — while not claiming they forked anything.
    expect(overrideOf(shadow({ forkedFromTemplateId: null, forkedFromVersion: null }), 'template-1')).toMatchObject({
      forked: false,
    });
  });

  it('does not call a fork of a DIFFERENT template a fork of this one', () => {
    expect(overrideOf(shadow({ forkedFromTemplateId: 'template-9' }), 'template-1')).toMatchObject({
      forked: false,
    });
  });
});

describe('driftOf — has the standard moved since the brand copied it?', () => {
  it('reports nothing while the fork is still on the version it copied', () => {
    expect(driftOf(shadow({ forkedFromVersion: 3 }), 'template-1', 3)).toBeNull();
  });

  it('reports both versions once the template has moved on', () => {
    // This is the entire reason lineage is recorded. Without it a fork rots
    // quietly while the standard it copied gets corrected underneath it.
    expect(driftOf(shadow({ forkedFromVersion: 2 }), 'template-1', 5)).toEqual({
      forkedFromVersion: 2,
      currentVersion: 5,
    });
  });

  it('says nothing about a brand rule that was never forked from anything', () => {
    // A rule that merely collides on key was not a copy and cannot have
    // drifted from something it never came from.
    const collision = shadow({ forkedFromTemplateId: null, forkedFromVersion: null });
    expect(driftOf(collision, 'template-1', 5)).toBeNull();
  });

  it('says nothing about a fork of a different template', () => {
    expect(driftOf(shadow({ forkedFromTemplateId: 'template-9', forkedFromVersion: 1 }), 'template-1', 5)).toBeNull();
  });

  it('tolerates a fork recorded before lineage existed', () => {
    // Rules forked by an older build carry a template id and a null version.
    // Reporting drift from `null` would show every one of them as stale.
    expect(driftOf(shadow({ forkedFromVersion: null }), 'template-1', 5)).toBeNull();
  });
});

describe('forkCitation — a copy must not claim to be the standard', () => {
  const wcag = { doc: 'WCAG 2.2', criterion: '1.4.3 Contrast (Minimum)' };

  it('keeps the original citation so a reviewer can still go and read it', () => {
    expect(forkCitation(wcag, 'accessibility-wcag-aa', 'Accessibility', false)).toMatchObject(wcag);
  });

  it('records which pack it came from', () => {
    expect(forkCitation(wcag, 'accessibility-wcag-aa', 'Accessibility', false).forkedFrom).toEqual({
      packKey: 'accessibility-wcag-aa',
      packName: 'Accessibility',
    });
  });

  it('says the thresholds are the brand’s once it has been edited', () => {
    /*
     * Without this the rule would cite WCAG beside a threshold WCAG does not
     * specify — a citation that looks like provenance and is actually a
     * misattribution. The unedited case says the opposite, and equally
     * plainly.
     */
    const edited = forkCitation(wcag, 'accessibility-wcag-aa', 'Accessibility', true).note as string;
    expect(edited).toContain('the brand’s');
    expect(edited).not.toContain('Identical');

    const untouched = forkCitation(wcag, 'accessibility-wcag-aa', 'Accessibility', false).note as string;
    expect(untouched).toContain('Identical to the shipped standard');
  });

  it('works on a template that carried no citation at all', () => {
    const result = forkCitation(null, 'craft-layout', 'Layout craft', false);
    expect(result.forkedFrom).toBeTruthy();
    expect(result.note).toBeTruthy();
  });
});
