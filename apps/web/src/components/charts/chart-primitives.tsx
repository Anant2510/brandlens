'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared chart chrome. Recharts is theme-blind, so every chart reads the same
 * CSS variables the rest of the console uses and re-reads them on theme change.
 */
export function useChartTheme() {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return React.useMemo(() => {
    if (typeof window === 'undefined') {
      return { grid: '#e2e8f0', axis: '#64748b', surface: '#ffffff', border: '#e2e8f0', fg: '#0f172a' };
    }
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    return {
      grid: read('--chart-grid', '#e2e8f0'),
      axis: read('--fg-subtle', '#64748b'),
      surface: read('--surface', '#ffffff'),
      border: read('--border', '#e2e8f0'),
      fg: read('--fg', '#0f172a'),
    };
    // `tick` is the dependency: it changes when the theme class flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
}

export interface TooltipRow {
  label: string;
  value: React.ReactNode;
  color?: string;
}

export function ChartTooltipCard({ title, rows }: { title?: React.ReactNode; rows: TooltipRow[] }) {
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2 shadow-lg">
      {title ? <p className="mb-1 text-[11px] font-medium text-fg">{title}</p> : null}
      <ul className="space-y-0.5">
        {rows.map((row, index) => (
          <li key={`${row.label}-${index}`} className="flex items-center gap-2 text-[11px]">
            {row.color ? (
              <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: row.color }} />
            ) : null}
            <span className="text-fg-muted">{row.label}</span>
            <span className="ml-auto num text-fg">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartFrame({
  title,
  description,
  actions,
  children,
  height = 240,
  className,
  /** A text summary that screen readers get instead of the SVG. */
  summary,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  height?: number;
  className?: string;
  summary?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-fg-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="p-3">
        <div style={{ height }} role="img" aria-label={summary ?? title}>
          {children}
        </div>
      </div>
    </section>
  );
}

export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 10, fontFamily: 'var(--font-mono)' },
} as const;
