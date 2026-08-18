import * as React from 'react';
import Link from 'next/link';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InfoHint } from '@/components/ui/tooltip';

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint?: string;
  /** Signed delta in percentage points; positive is not always good. */
  delta?: number | null;
  deltaGoodWhen?: 'up' | 'down';
  href?: string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
}

const TONE_COLOR = {
  default: 'text-fg',
  ok: 'text-[var(--ok-fg)]',
  warn: 'text-[var(--sev-major-fg)]',
  danger: 'text-blocker-fg',
} as const;

export function StatTile({
  label,
  value,
  sub,
  hint,
  delta,
  deltaGoodWhen = 'up',
  href,
  icon: Icon,
  className,
  tone = 'default',
}: StatTileProps) {
  const good = delta === null || delta === undefined ? null : deltaGoodWhen === 'up' ? delta >= 0 : delta <= 0;

  const body = (
    <div
      className={cn(
        'flex h-full flex-col rounded-lg border border-border bg-surface p-3 transition-colors',
        href && 'hover:border-border-strong hover:bg-surface-2',
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-3.5 text-fg-subtle" aria-hidden="true" /> : null}
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{label}</span>
        {hint ? <InfoHint content={hint} /> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={cn('font-mono text-xl font-semibold tabular leading-none', TONE_COLOR[tone])}>{value}</span>
        {delta !== null && delta !== undefined ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-medium tabular',
              good ? 'text-[var(--ok-fg)]' : 'text-blocker-fg',
            )}
          >
            {delta >= 0 ? (
              <TrendingUp className="size-3" aria-hidden="true" />
            ) : (
              <TrendingDown className="size-3" aria-hidden="true" />
            )}
            {Math.abs(delta).toFixed(1)}pp
          </span>
        ) : null}
      </div>
      {sub ? <div className="mt-1.5 text-[11px] leading-4 text-fg-muted">{sub}</div> : null}
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}
