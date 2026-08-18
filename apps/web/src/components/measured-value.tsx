import * as React from 'react';
import type { Evidence } from '@brandlens/contracts';
import { formatMeasured, humanizeKey } from '@/lib/format';
import { cn } from '@/lib/utils';

/** `<=` reads as noise next to a number; the real operator does not. */
const OPERATOR: Record<string, string> = {
  max: '≤',
  maximum: '≤',
  lte: '≤',
  min: '≥',
  minimum: '≥',
  gte: '≥',
  eq: '=',
  equals: '=',
  exact: '=',
};

function operatorFor(key: string): string {
  const lower = key.toLowerCase();
  for (const [needle, symbol] of Object.entries(OPERATOR)) {
    if (lower.startsWith(needle) || lower.endsWith(needle)) return symbol;
  }
  if (lower.includes('min')) return '≥';
  if (lower.includes('max')) return '≤';
  return '=';
}

export interface MeasurementRow {
  key: string;
  measured: unknown;
  threshold: unknown;
  operator: string;
}

/** Pairs each measured key with its threshold; unmatched keys still show. */
export function measurementRows(evidence: Evidence | null | undefined): MeasurementRow[] {
  const measured = (evidence?.measured ?? {}) as Record<string, unknown>;
  const threshold = (evidence?.threshold ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(measured), ...Object.keys(threshold)]));

  return keys.map((key) => {
    // Threshold keys are often `maxDeltaE00` for a measured `deltaE00`.
    const direct = threshold[key];
    const prefixed = Object.entries(threshold).find(([tk]) =>
      tk.toLowerCase().replace(/^(max|min|minimum|maximum)/, '') === key.toLowerCase(),
    );
    const thresholdKey = direct !== undefined ? key : (prefixed?.[0] ?? key);
    return {
      key,
      measured: measured[key],
      threshold: direct !== undefined ? direct : prefixed?.[1],
      operator: operatorFor(thresholdKey),
    };
  });
}

/**
 * Measured value vs threshold, in monospace.
 *
 * This line is the whole argument of a finding: `ΔE00 4.7 vs ≤ 2.0` settles a
 * dispute that three paragraphs of prose would not.
 */
export function MeasuredVsThreshold({
  evidence,
  className,
  dense = false,
}: {
  evidence: Evidence | null | undefined;
  className?: string;
  dense?: boolean;
}) {
  const rows = measurementRows(evidence).filter((row) => row.measured !== undefined || row.threshold !== undefined);

  if (rows.length === 0) {
    return evidence?.observation ? (
      <p className={cn('text-xs leading-5 text-fg-muted', className)}>{evidence.observation}</p>
    ) : null;
  }

  return (
    <dl className={cn('space-y-1', className)}>
      {rows.map((row) => (
        <div
          key={row.key}
          className={cn(
            'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded bg-surface-2 px-2 py-1',
            dense && 'px-1.5 py-0.5',
          )}
        >
          <dt className="text-[11px] text-fg-muted">{humanizeKey(row.key)}</dt>
          <dd className="flex items-baseline gap-1.5 font-mono text-xs tabular">
            <span className="font-semibold text-fg">{formatMeasured(row.measured)}</span>
            {row.threshold !== undefined ? (
              <>
                <span className="text-fg-subtle">vs</span>
                <span className="text-fg-muted">
                  {row.operator} {formatMeasured(row.threshold)}
                </span>
              </>
            ) : null}
          </dd>
        </div>
      ))}
      {evidence?.quotedText ? (
        <div className="rounded bg-surface-2 px-2 py-1">
          <span className="text-[11px] text-fg-muted">quoted text</span>
          <p className="mt-0.5 font-mono text-xs text-fg">“{evidence.quotedText}”</p>
        </div>
      ) : null}
    </dl>
  );
}
