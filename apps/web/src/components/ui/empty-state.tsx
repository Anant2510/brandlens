import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { buttonClasses } from './button-variants';

export interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  secondary?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

/** Every empty state names the next action; a dead end is a bug. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondary,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border bg-surface',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <div className="mb-3 rounded-full bg-surface-2 p-2.5">
        <Icon className="size-5 text-fg-subtle" aria-hidden="true" />
      </div>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-xs leading-5 text-fg-muted">{description}</p> : null}
      {actionLabel ? (
        <div className="mt-4 flex items-center gap-2">
          {actionHref ? (
            <Link href={actionHref} className={buttonClasses('primary', 'sm')}>
              {actionLabel}
            </Link>
          ) : (
            <Button variant="primary" size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          {secondary}
        </div>
      ) : (
        secondary
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  correlationId?: string;
  className?: string;
  compact?: boolean;
}

/**
 * An honest error, not a crash: the API being unreachable is a normal state on
 * a single-VM deployment and the console must say so plainly.
 */
export function ErrorState({
  title = 'Could not load this view',
  message,
  onRetry,
  correlationId,
  className,
  compact = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center rounded-lg border border-border bg-surface',
        compact ? 'px-4 py-8' : 'px-6 py-12',
        className,
      )}
    >
      <div className="mb-3 rounded-full bg-blocker-soft p-2.5">
        <AlertTriangle className="size-5 text-blocker-fg" aria-hidden="true" />
      </div>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-md text-xs leading-5 text-fg-muted">{message}</p>
      {correlationId ? (
        <p className="mt-2 font-mono text-[11px] text-fg-subtle">correlation: {correlationId}</p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
