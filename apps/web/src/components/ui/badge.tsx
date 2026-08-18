import * as React from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'bg-surface-2 text-fg-muted border-border',
  accent: 'bg-accent-soft text-accent-soft-fg border-transparent',
  ok: 'bg-[var(--ok-soft)] text-[var(--ok-fg)] border-transparent',
  blocker: 'bg-blocker-soft text-blocker-fg border-transparent',
  major: 'bg-major-soft text-major-fg border-transparent',
  minor: 'bg-minor-soft text-minor-fg border-transparent',
  advisory: 'bg-advisory-soft text-advisory-fg border-transparent',
  outline: 'bg-transparent text-fg-muted border-border-strong',
} as const;

export type BadgeTone = keyof typeof TONES;

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  mono?: boolean;
}

export function Badge({ className, tone = 'neutral', mono = false, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
        mono && 'font-mono tabular',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A 6px status dot — used where a full badge would be visual noise. */
export function Dot({ tone = 'neutral', className }: { tone?: BadgeTone; className?: string }) {
  const color: Record<BadgeTone, string> = {
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent',
    ok: 'bg-[var(--ok)]',
    blocker: 'bg-blocker',
    major: 'bg-major',
    minor: 'bg-minor',
    advisory: 'bg-advisory',
    outline: 'bg-fg-subtle',
  };
  return <span aria-hidden="true" className={cn('inline-block size-1.5 rounded-full shrink-0', color[tone], className)} />;
}
