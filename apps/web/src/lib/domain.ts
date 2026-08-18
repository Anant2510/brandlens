import type { CheckTier, RuleDimension, Severity, Verdict } from '@brandlens/contracts';

/* ==========================================================================
 * Vocabulary shared by every screen: ordering, labels and colors for the
 * enumerations that come out of @brandlens/contracts.
 * ========================================================================== */

export const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'advisory'];

export const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  advisory: 3,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  advisory: 'Advisory',
};

/** Solid colors for overlay strokes and chart marks. */
export const SEVERITY_VAR: Record<Severity, string> = {
  blocker: 'var(--sev-blocker)',
  major: 'var(--sev-major)',
  minor: 'var(--sev-minor)',
  advisory: 'var(--sev-advisory)',
};

export const DIMENSIONS: RuleDimension[] = [
  'logo',
  'color',
  'typography',
  'layout',
  'imagery',
  'copy',
  'accessibility',
  'channel_spec',
  'legal',
];

export const DIMENSION_LABEL: Record<RuleDimension, string> = {
  logo: 'Logo',
  color: 'Color',
  typography: 'Typography',
  layout: 'Layout',
  imagery: 'Imagery',
  copy: 'Copy',
  accessibility: 'Accessibility',
  channel_spec: 'Channel spec',
  legal: 'Legal',
};

export function dimensionLabel(dimension: string): string {
  return DIMENSION_LABEL[dimension as RuleDimension] ?? dimension.replace(/_/g, ' ');
}

export const TIERS: CheckTier[] = ['deterministic', 'cv', 'vlm', 'hybrid'];

/** T0/T1/T2 shorthand — the badge a reviewer scans for "can I trust this?". */
export const TIER_CODE: Record<CheckTier, string> = {
  deterministic: 'T0',
  cv: 'T1',
  vlm: 'T2',
  hybrid: 'T1+T2',
};

export const TIER_LABEL: Record<CheckTier, string> = {
  deterministic: 'Deterministic',
  cv: 'Computer vision',
  vlm: 'Vision judge',
  hybrid: 'Hybrid',
};

export const TIER_DESCRIPTION: Record<CheckTier, string> = {
  deterministic: 'Parse and arithmetic. No model involved, ~100% precision, no cost.',
  cv: 'Classical computer vision and embeddings. Measured, not judged.',
  vlm: 'Vision judge over an atomic rubric leaf. Measured by code, adjudicated by a model.',
  hybrid: 'Code measures, the vision judge adjudicates the measurement.',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  not_applicable: 'Not applicable',
  insufficient_evidence: 'Insufficient evidence',
  abstained: 'Abstained',
};

export type ScoreBand = 'pass' | 'conditional' | 'fail';

export const BAND_LABEL: Record<ScoreBand, string> = {
  pass: 'Pass',
  conditional: 'Conditional',
  fail: 'Fail',
};

export function bandOf(score: number | null | undefined, band?: string | null): ScoreBand | null {
  if (band === 'pass' || band === 'conditional' || band === 'fail') return band;
  if (score === null || score === undefined) return null;
  if (score >= 85) return 'pass';
  if (score >= 70) return 'conditional';
  return 'fail';
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  degraded: 'Degraded',
};

export const FINDING_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  overridden: 'Overridden',
  waived: 'Waived',
  fixed: 'Fixed',
};

export const RULE_STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  active: 'Active',
  deprecated: 'Deprecated',
  rejected: 'Rejected',
};

export const PROVENANCE_LABEL: Record<string, string> = {
  deductive: 'From brand book',
  inductive: 'Learned from assets',
  transfer: 'External standard',
  manual: 'Hand-authored',
};

export const PROVENANCE_DESCRIPTION: Record<string, string> = {
  deductive: 'Extracted from an uploaded guideline document, with a page citation.',
  inductive: 'Induced by measuring the approved corpus — what the team actually enforces.',
  transfer: 'Imported from an external standard such as WCAG or a platform spec.',
  manual: 'Written by a person in this organization.',
};

export const REVIEW_STATE_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const DECISION_ACTION_LABEL: Record<string, string> = {
  confirm: 'Confirmed',
  override_pass: 'Overridden to pass',
  override_fail: 'Overridden to fail',
  waive: 'Waived',
  escalate: 'Escalated',
  comment: 'Comment',
};

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
] as const;

export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** A normalized bbox is [x, y, w, h] in 0..1 against the rendered canvas. */
export function normalizeBBox(bbox: number[] | null | undefined): [number, number, number, number] | null {
  if (!bbox || bbox.length < 4) return null;
  const [x, y, w, h] = bbox as [number, number, number, number];
  if ([x, y, w, h].some((n) => typeof n !== 'number' || Number.isNaN(n))) return null;
  return [clamp01(x), clamp01(y), clamp01(w), clamp01(h)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
