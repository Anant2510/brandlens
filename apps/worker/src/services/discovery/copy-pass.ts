import type { AnalyzeCopyResponse, RuleDefinition } from '@brandlens/contracts';

/* ==========================================================================
 * The copy half of discovery.
 *
 * The engine measures and judges (see copy_intelligence.py); this module
 * decides what the results MEAN for the brand's rulebook. Keeping the two
 * apart matters: the engine's job is to describe the copy accurately, and
 * this file's job is to be conservative about turning a description into a
 * rule somebody may one day be held to.
 * ========================================================================== */

export interface CopyRuleInput {
  copy: AnalyzeCopyResponse;
  pageCount: number;
}

const COPY_NOTE =
  'Proposed from the brand’s own website copy. Review before activating: what a site currently says is ' +
  'not automatically what the brand wants said.';

/**
 * Turns the copy analysis into proposed rules.
 *
 * The conservative choices here are deliberate and each has a reason:
 *
 *   * Only terms the brand DEMONSTRABLY uses become lexicon rules. The engine
 *     already discards invented terms; this adds a usage floor on top, so a
 *     word written once does not become policy.
 *   * A claim rule is proposed only when claims were actually found. An empty
 *     claims register with an active substantiation rule fails every asset
 *     that mentions anything, which teaches people to switch rules off.
 *   * Readability is proposed at the site's OWN measured grade, rounded up a
 *     little, rather than at some external "good writing" target. The brand
 *     did not ask us to make them simpler; they asked what they sound like.
 */
export function synthesizeCopyRules(input: CopyRuleInput): RuleDefinition[] {
  const { copy, pageCount } = input;
  const rules: RuleDefinition[] = [];

  /* ------------------------------------------------------------- lexicon */
  const banned = copy.lexicon.filter((t) => t.kind === 'banned' || t.kind === 'avoid');
  const required = copy.lexicon.filter((t) => t.kind === 'required');

  if (banned.length > 0) {
    rules.push({
      key: 'copy.banned-terms',
      version: 1,
      statement: `Avoid ${formatList(banned.slice(0, 8).map((t) => `“${t.term}”`))}.`,
      rationale:
        'Identified from the brand’s own copy as terms it either avoids or uses in a way that reads as ' +
        'off-voice. Every term listed appears on the site — none was invented.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'major',
      weight: 1,
      scope: {},
      check: {
        fn: 'copy.banned_terms',
        params: { terms: banned.map((t) => t.term), matchWholeWord: true, allowFuzzy: true },
      },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: pageCount,
        agreement: round(mean(banned.map((t) => t.pageCount / Math.max(1, pageCount))), 3),
        note: COPY_NOTE,
        observed: banned.map((t) => ({ term: t.term, uses: t.uses, pages: t.pageCount, note: t.note ?? null })),
      } as RuleDefinition['support'],
    });
  }

  if (required.length > 0) {
    rules.push({
      key: 'copy.required-terms',
      version: 1,
      statement: `Brand-facing copy should include ${formatList(required.slice(0, 6).map((t) => `“${t.term}”`))}.`,
      rationale: 'These terms recur across the site and read as load-bearing to how the brand describes itself.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.6,
      scope: {},
      check: { fn: 'copy.required_terms', params: { terms: required.map((t) => t.term), minMatches: 1 } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: pageCount,
        agreement: round(mean(required.map((t) => t.pageCount / Math.max(1, pageCount))), 3),
        note: COPY_NOTE,
        observed: required.map((t) => ({ term: t.term, uses: t.uses, pages: t.pageCount })),
      } as RuleDefinition['support'],
    });
  }

  /* -------------------------------------------------------------- claims */
  const substantiable = copy.claims.filter((c) => c.needsSubstantiation);
  if (substantiable.length > 0) {
    const unjudged = substantiable.filter((c) => !c.judged).length;
    rules.push({
      key: 'copy.claim-substantiation',
      version: 1,
      statement: 'Every substantive claim must appear in the claims register, be in date, and cover the market.',
      rationale:
        `${substantiable.length} claim${substantiable.length === 1 ? '' : 's'} on the site would need ` +
        'substantiating. They have been added to the register as unapproved so a legal reviewer can ' +
        'triage them.' +
        (unjudged > 0
          ? ` ${unjudged} of them could not be judged automatically and default to needing evidence.`
          : ''),
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 1,
      scope: {},
      check: { fn: 'copy.claim_substantiation', params: { requireApproval: true, checkExpiry: true } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: pageCount,
        agreement: 1,
        note: COPY_NOTE,
        observed: substantiable.slice(0, 10).map((c) => ({ text: c.text, type: c.claimType, judged: c.judged })),
      } as RuleDefinition['support'],
    });
  }

  /* --------------------------------------------------------- disclaimers */
  if (copy.disclaimers.length > 0) {
    rules.push({
      key: 'copy.disclaimer-present',
      version: 1,
      statement: 'Required disclaimers must be present, legible and close to the claim they qualify.',
      rationale:
        `${copy.disclaimers.length} disclaimer${copy.disclaimers.length === 1 ? '' : 's'} appear on the site. ` +
        'Legibility thresholds are the shipped defaults, not measurements — confirm them against the brand’s ' +
        'legal guidance.',
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 1,
      scope: {},
      check: { fn: 'copy.disclaimer_present', params: { minFontSizePt: 8, minContrastRatio: 4.5 } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: pageCount,
        // Deliberately low. Presence was measured; the thresholds were not,
        // and a rule that mixes the two should not claim the confidence of
        // the measured half.
        agreement: 0.4,
        note: 'Disclaimer presence is measured; the size and contrast thresholds are defaults.',
        observed: copy.disclaimers.slice(0, 8).map((d) => ({ text: d.text, trigger: d.triggerCondition ?? null })),
      } as RuleDefinition['support'],
    });
  }

  /* --------------------------------------------------------- readability */
  const grade = copy.readability.metrics?.fleschKincaidGrade;
  const words = copy.readability.stats?.words ?? 0;
  // Below a few hundred words a readability formula is measuring noise, and
  // a grade-level rule built on it would be arbitrary.
  if (typeof grade === 'number' && Number.isFinite(grade) && words >= 300) {
    // One grade of headroom above what the site already achieves: the rule is
    // meant to catch copy that is markedly denser than the brand's norm, not
    // to fail every sentence that runs slightly long.
    const maxGrade = Math.max(6, Math.ceil(grade) + 1);
    rules.push({
      key: 'copy.readability',
      version: 1,
      statement: `Body copy should read at no harder than US grade ${maxGrade}.`,
      rationale:
        `The site’s own copy measures Flesch-Kincaid grade ${grade.toFixed(1)} across ` +
        `${Math.round(words)} words. The rule allows one grade of headroom above that.`,
      dimension: 'copy',
      tier: 'deterministic',
      severity: 'minor',
      weight: 0.5,
      scope: {},
      check: { fn: 'copy.readability', params: { maxGrade, minWords: 20, metric: 'fleschKincaidGrade' } },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: Math.round(words),
        agreement: 1,
        note: copy.readability.degraded
          ? 'Measured with the vendored Flesch fallback: textstat was unavailable, so treat the grade as approximate.'
          : COPY_NOTE,
        observed: [{ measuredGrade: round(grade, 2), proposedMaxGrade: maxGrade }],
      } as RuleDefinition['support'],
    });
  }

  /* --------------------------------------------------------------- voice */
  if (copy.voiceAxes.length > 0) {
    rules.push({
      key: 'copy.voice-tone',
      version: 1,
      statement: `Copy should sit on the brand’s voice axes: ${copy.voiceAxes.map((a) => a.name).join(', ')}.`,
      rationale:
        'Each axis was inferred from the site’s copy and is evidenced by sentences verified to appear in it. ' +
        'Tone is a judgement, so this rule is adjudicated by a model rather than measured.',
      dimension: 'copy',
      // The only VLM-tier rule discovery proposes. Everything else here is
      // countable; tone genuinely is not, and pretending otherwise would put
      // a fake number on a real opinion.
      tier: 'vlm',
      severity: 'minor',
      weight: 0.7,
      scope: {},
      check: {
        fn: 'vlm.voice_tone',
        params: {
          axes: copy.voiceAxes.map((a) => ({
            name: a.name,
            lowLabel: a.lowLabel,
            highLabel: a.highLabel,
            target: a.value,
            // Wide on purpose. A discovered voice is an inference from one
            // reading of a website; scoring copy against it to within a tenth
            // would be false precision dressed as rigour.
            tolerance: 0.25,
          })),
        },
      },
      rubric: {
        kind: 'ordinal',
        question:
          `Does this copy sound like ${describeVoice(copy.voiceAxes)}? ` +
          'Judge the writing as a whole, not sentence by sentence.',
        // Fully labelled, symmetric anchors: unlabelled or lopsided scales
        // bias a judge toward the middle or the top.
        levels: [
          { value: 0, label: 'Off-brand', anchor: 'Reads as a different brand entirely.' },
          { value: 1, label: 'Strained', anchor: 'Recognisable, but several passages fight the voice.' },
          { value: 2, label: 'Acceptable', anchor: 'Broadly consistent; nothing jars.' },
          { value: 3, label: 'On-brand', anchor: 'Sounds like the brand throughout.' },
          { value: 4, label: 'Exemplary', anchor: 'Could be lifted straight into the brand’s own pages.' },
        ],
        passWhen: 'The copy scores 2 or above on the scale.',
        failWhen: 'The copy scores 1 or below, or contradicts an axis the brand sits firmly on.',
        usePrecedents: true,
        cropTo: 'text',
      },
      provenance: 'inductive',
      status: 'proposed',
      support: {
        sampleSize: pageCount,
        agreement: round(mean(copy.voiceAxes.map((a) => Math.min(1, a.evidence.length / 2))), 3),
        note: COPY_NOTE,
        observed: copy.voiceAxes.map((a) => ({
          axis: a.name,
          value: a.value,
          evidenceCount: a.evidence.length,
        })),
      } as RuleDefinition['support'],
    });
  }

  return rules;
}

/**
 * Renders the axes as the sentence a person would say.
 *
 * "plain rather than ornate, warm rather than clinical" tells a judge what to
 * look for far better than a table of axis names and floats does — and the
 * judge is reading a prompt, not a spreadsheet.
 */
function describeVoice(axes: CopyRuleInput['copy']['voiceAxes']): string {
  const phrases = axes
    .map((a) => (a.value >= 0.5 ? `${a.highLabel} rather than ${a.lowLabel}` : `${a.lowLabel} rather than ${a.highLabel}`))
    .slice(0, 5);
  return formatList(phrases) || 'the brand';
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
