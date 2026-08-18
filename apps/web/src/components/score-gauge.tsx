import * as React from 'react';
import { BAND_LABEL, bandOf, type ScoreBand } from '@/lib/domain';
import { cn } from '@/lib/utils';

const BAND_COLOR: Record<ScoreBand, string> = {
  pass: 'var(--ok)',
  conditional: 'var(--warn)',
  fail: 'var(--danger)',
};

export interface ScoreGaugeProps {
  score: number | null | undefined;
  band?: string | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Blockers override the score; the ring goes red no matter the number. */
  hasBlocker?: boolean;
  label?: string;
}

/**
 * The headline number. Deterministic aggregation over atomic criteria — never
 * a raw model score, which is why the caller is expected to render the
 * explanatory note next to it.
 */
export function ScoreGauge({
  score,
  band,
  size = 96,
  strokeWidth = 8,
  className,
  hasBlocker = false,
  label,
}: ScoreGaugeProps) {
  const resolvedBand = hasBlocker ? 'fail' : bandOf(score, band);
  const color = resolvedBand ? BAND_COLOR[resolvedBand] : 'var(--fg-subtle)';
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - pct / 100);

  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `Score ${score ?? 'unavailable'} of 100`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 400ms ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono font-semibold tabular leading-none" style={{ fontSize: size * 0.28, color }}>
          {score === null || score === undefined ? '—' : score.toFixed(0)}
        </span>
        {resolvedBand ? (
          <span className="mt-1 text-[10px] font-medium uppercase tracking-wide" style={{ color }}>
            {BAND_LABEL[resolvedBand]}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Compact inline score for tables. */
export function ScorePill({
  score,
  band,
  hasBlocker = false,
  className,
}: {
  score: number | null | undefined;
  band?: string | null;
  hasBlocker?: boolean;
  className?: string;
}) {
  const resolved = hasBlocker ? 'fail' : bandOf(score, band);
  const color = resolved ? BAND_COLOR[resolved] : 'var(--fg-subtle)';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="num font-semibold" style={{ color }}>
        {score === null || score === undefined ? '—' : score.toFixed(1)}
      </span>
    </span>
  );
}
