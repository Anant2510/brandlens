'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

/**
 * Hover/focus tooltip. The content is rendered into the DOM at all times and
 * linked via aria-describedby, so screen readers get it without hover.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  const position = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {React.cloneElement(children, { 'aria-describedby': id } as React.HTMLAttributes<HTMLElement>)}
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none absolute z-40 w-max max-w-[16rem] rounded-md border border-border bg-surface px-2 py-1.5',
          'text-[11px] leading-4 text-fg shadow-lg transition-opacity duration-100',
          open ? 'opacity-100' : 'opacity-0',
          position,
          className,
        )}
        // Hidden from the a11y tree only when it is also visually hidden would
        // break aria-describedby; keep it described but invisible instead.
        aria-hidden={!open}
      >
        {content}
      </span>
    </span>
  );
}

/** The small "what does this mean?" affordance next to a metric label. */
export function InfoHint({ content, className }: { content: React.ReactNode; className?: string }) {
  return (
    <Tooltip content={content}>
      <button
        type="button"
        className={cn('text-fg-subtle hover:text-fg-muted transition-colors', className)}
        aria-label="More information"
      >
        <Info className="size-3" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
