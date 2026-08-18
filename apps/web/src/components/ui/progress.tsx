import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ProgressProps {
  value: number;
  max?: number;
  label?: string;
  className?: string;
  barClassName?: string;
  /** Inline CSS color for the fill — used for severity/dimension colors. */
  color?: string;
  size?: 'xs' | 'sm' | 'md';
}

export function Progress({
  value,
  max = 100,
  label,
  className,
  barClassName,
  color,
  size = 'sm',
}: ProgressProps) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const height = size === 'xs' ? 'h-1' : size === 'sm' ? 'h-1.5' : 'h-2';

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className={cn('w-full rounded-full bg-surface-3 overflow-hidden', height, className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', !color && 'bg-accent', barClassName)}
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}
