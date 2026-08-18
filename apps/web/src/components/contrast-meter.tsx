'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Relative luminance per WCAG 2.x. */
function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number | null {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a === null || b === null) return null;
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

export interface ContrastMeterProps {
  foreground: string;
  background: string;
  /** 4.5 for body copy, 3.0 for large text and UI components. */
  threshold?: number;
  label?: string;
  className?: string;
  compact?: boolean;
}

/**
 * Foreground/background contrast against a WCAG threshold.
 *
 * Shipping a compliance product that fails contrast in its own UI would be
 * embarrassing, and the same arithmetic backs the accessibility dimension.
 */
export function ContrastMeter({
  foreground,
  background,
  threshold = 4.5,
  label,
  className,
  compact = false,
}: ContrastMeterProps) {
  const ratio = contrastRatio(foreground, background);
  const passes = ratio !== null && ratio >= threshold;
  const passesAAA = ratio !== null && ratio >= 7;

  return (
    <div className={cn('rounded-md border border-border bg-surface p-2.5', className)}>
      {label ? <p className="mb-1.5 text-[11px] font-medium text-fg-muted">{label}</p> : null}
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-10 shrink-0 place-items-center rounded border border-border-strong font-semibold"
          style={{ backgroundColor: background, color: foreground }}
        >
          Aa
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-sm font-semibold" style={{ color: passes ? 'var(--ok)' : 'var(--danger)' }}>
            {ratio === null ? '—' : `${ratio.toFixed(2)}:1`}
          </p>
          <p className="num text-[10px] text-fg-subtle">
            {foreground} on {background}
          </p>
        </div>
        {!compact ? (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <Chip ok={passes} text={`AA ${threshold}:1`} />
            <Chip ok={passesAAA} text="AAA 7:1" />
          </div>
        ) : null}
      </div>
      {!compact ? (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${Math.min(100, ((ratio ?? 0) / 21) * 100)}%`,
              backgroundColor: passes ? 'var(--ok)' : 'var(--danger)',
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Chip({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={cn(
        'rounded px-1 py-px text-[10px] font-medium',
        ok ? 'bg-[var(--ok-soft)] text-[var(--ok-fg)]' : 'bg-blocker-soft text-blocker-fg',
      )}
    >
      {ok ? 'pass' : 'fail'} {text}
    </span>
  );
}
