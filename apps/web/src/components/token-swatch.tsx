'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import type { DesignToken } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatMeasured } from '@/lib/format';

/**
 * A design token, shown as the thing it is.
 *
 * Color tokens carry their Lab coordinates because ΔE00 — not hex equality —
 * is what the color analyzer actually measures against.
 */
export function TokenSwatch({ token, className }: { token: DesignToken; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const isColor = token.type === 'color' && Boolean(token.hex);

  const copy = async () => {
    const value = token.hex ?? (typeof token.value === 'string' ? token.value : JSON.stringify(token.value));
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable; the value is visible on screen regardless */
    }
  };

  return (
    <div className={cn('flex items-start gap-2.5 rounded-md border border-border bg-surface p-2.5', className)}>
      {isColor ? (
        <span
          className="size-9 shrink-0 rounded border border-border-strong"
          style={{ backgroundColor: token.hex ?? undefined }}
          aria-hidden="true"
        />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded border border-border bg-surface-2 font-mono text-[10px] text-fg-subtle">
          {token.type.slice(0, 3)}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="num truncate text-fg" title={token.path}>
          {token.path}
        </p>
        <p className="mt-0.5 num text-[11px] text-fg-muted">
          {token.hex ?? formatMeasured(token.value)}
          {token.role ? <span className="ml-1.5 font-sans text-fg-subtle">· {token.role}</span> : null}
        </p>
        {isColor && token.labL !== null ? (
          <p className="mt-0.5 num text-[10px] text-fg-subtle">
            L*{token.labL?.toFixed(1)} a*{token.labA?.toFixed(1)} b*{token.labB?.toFixed(1)}
          </p>
        ) : null}
        {token.description ? <p className="mt-0.5 text-[11px] leading-4 text-fg-muted">{token.description}</p> : null}
      </div>

      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy value of ${token.path}`}
        className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}
