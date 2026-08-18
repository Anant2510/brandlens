import * as React from 'react';
import { dimensionLabel } from '@/lib/domain';
import { cn } from '@/lib/utils';

export interface DimensionBarsProps {
  scores: Record<string, number>;
  className?: string;
  /** Show every known dimension, including ones with no criteria (as "n/a"). */
  emptyLabel?: string;
  max?: number;
}

function colorFor(value: number): string {
  if (value >= 85) return 'var(--ok)';
  if (value >= 70) return 'var(--warn)';
  return 'var(--danger)';
}

/**
 * Per-dimension analytic scores. Small bars, not a radar: a reviewer needs to
 * compare magnitudes, and a radar chart makes that harder for no gain.
 */
export function DimensionBars({ scores, className, emptyLabel = 'No dimension scores yet.', max = 100 }: DimensionBarsProps) {
  const entries = Object.entries(scores ?? {}).sort(([, a], [, b]) => a - b);

  if (entries.length === 0) {
    return <p className="text-xs text-fg-subtle">{emptyLabel}</p>;
  }

  return (
    <ul className={cn('space-y-1.5', className)}>
      {entries.map(([dimension, value]) => {
        const pct = Math.max(0, Math.min(100, (value / max) * 100));
        return (
          <li key={dimension} className="grid grid-cols-[7.5rem_1fr_2.75rem] items-center gap-2">
            <span className="truncate text-[11px] text-fg-muted" title={dimensionLabel(dimension)}>
              {dimensionLabel(dimension)}
            </span>
            <span
              role="meter"
              aria-valuenow={Math.round(value)}
              aria-valuemin={0}
              aria-valuemax={max}
              aria-label={`${dimensionLabel(dimension)} score`}
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
            >
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{ width: `${pct}%`, backgroundColor: colorFor(value) }}
              />
            </span>
            <span className="num text-right text-fg" style={{ color: colorFor(value) }}>
              {value.toFixed(0)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
