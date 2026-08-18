'use client';

import * as React from 'react';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Auto-cleared rate: the share of criteria settled without a human. It is the
 * headline customer-facing number, so it gets an arc rather than a bar.
 */
export function CoverageGauge({
  value,
  label = 'Auto-cleared',
  sub,
  size = 132,
  className,
}: {
  value: number;
  label?: string;
  sub?: React.ReactNode;
  size?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const stroke = 10;
  const radius = (size - stroke) / 2;
  // 240-degree arc, opening at the bottom.
  const arc = (240 / 360) * 2 * Math.PI * radius;
  const circumference = 2 * Math.PI * radius;
  const color = clamped >= 0.8 ? 'var(--ok)' : clamped >= 0.5 ? 'var(--warn)' : 'var(--danger)';

  return (
    <div className={cn('flex flex-col items-center', className)}>
      <div className="relative" style={{ width: size, height: size * 0.78 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute left-0 top-0" aria-hidden="true">
          <g transform={`rotate(150 ${size / 2} ${size / 2})`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--surface-3)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${arc} ${circumference}`}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${arc * clamped} ${circumference}`}
              style={{ transition: 'stroke-dasharray 400ms ease-out' }}
            />
          </g>
        </svg>
        <div
          className="absolute inset-x-0 flex flex-col items-center"
          style={{ top: size * 0.3 }}
          role="meter"
          aria-valuenow={Math.round(clamped * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <span className="font-mono text-2xl font-semibold tabular leading-none" style={{ color }}>
            {formatPercent(clamped, 0)}
          </span>
          <span className="mt-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">{label}</span>
        </div>
      </div>
      {sub ? <div className="mt-1 text-center text-[11px] text-fg-muted">{sub}</div> : null}
    </div>
  );
}
