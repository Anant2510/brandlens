'use client';

import * as React from 'react';
import { Check, MessageSquare, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { FINDING_STATUS_LABEL } from '@/lib/domain';
import { cn } from '@/lib/utils';
import type { DecisionAction } from '@/hooks/use-findings';

const OVERRIDE_ACTIONS = new Set<DecisionAction>(['override_pass', 'override_fail']);

const ACTIONS: Array<{ action: DecisionAction; label: string; icon: typeof Check; variant: 'primary' | 'outline' | 'ghost' }> = [
  { action: 'confirm', label: 'Confirm', icon: Check, variant: 'primary' },
  { action: 'override_pass', label: 'Override to pass', icon: ThumbsUp, variant: 'outline' },
  { action: 'override_fail', label: 'Override to fail', icon: ThumbsDown, variant: 'outline' },
  { action: 'waive', label: 'Waive', icon: MessageSquare, variant: 'outline' },
];

export interface DecisionControlsProps {
  status: string;
  pending?: boolean;
  onDecide: (action: DecisionAction, rationale?: string) => void | Promise<void>;
  className?: string;
  compact?: boolean;
}

/**
 * Confirm / Override / Waive.
 *
 * The rationale is mandatory on an override, and enforced here as well as in
 * the API: it is both the audit record and the natural-language signal that
 * prompt optimisation consumes. An override without one is a lost example.
 */
export function DecisionControls({ status, pending = false, onDecide, className, compact = false }: DecisionControlsProps) {
  const [openAction, setOpenAction] = React.useState<DecisionAction | null>(null);
  const [rationale, setRationale] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const rationaleId = React.useId();

  const decided = status !== 'open';

  const run = async (action: DecisionAction) => {
    if (OVERRIDE_ACTIONS.has(action) && openAction !== action) {
      setOpenAction(action);
      setRationale('');
      setError(null);
      return;
    }

    if (OVERRIDE_ACTIONS.has(action) && rationale.trim().length < 4) {
      setError('A rationale is required when overriding a machine verdict.');
      return;
    }

    await onDecide(action, rationale.trim() || undefined);
    setOpenAction(null);
    setRationale('');
    setError(null);
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {decided ? (
          <Badge tone={status === 'overridden' ? 'major' : status === 'waived' ? 'advisory' : 'ok'}>
            {FINDING_STATUS_LABEL[status] ?? status}
          </Badge>
        ) : null}

        {ACTIONS.map(({ action, label, icon: Icon, variant }) => (
          <Button
            key={action}
            size={compact ? 'xs' : 'sm'}
            variant={openAction === action ? 'primary' : variant}
            loading={pending && openAction === action}
            onClick={() => void run(action)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </Button>
        ))}
      </div>

      {openAction && OVERRIDE_ACTIONS.has(openAction) ? (
        <div className="rounded-md border border-border bg-surface-2 p-2.5">
          <Label htmlFor={rationaleId} required>
            Why is the machine verdict wrong?
          </Label>
          <Textarea
            id={rationaleId}
            autoFocus
            rows={2}
            value={rationale}
            invalid={Boolean(error)}
            placeholder="e.g. The clearspace measurement includes the drop shadow, which the guideline excludes."
            onChange={(event) => {
              setRationale(event.target.value);
              if (error) setError(null);
            }}
          />
          {error ? (
            <p role="alert" className="mt-1 text-[11px] text-[var(--danger)]">
              {error}
            </p>
          ) : (
            <p className="mt-1 flex items-start gap-1 text-[11px] text-fg-subtle">
              <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
              Recorded in the audit trail and used to recalibrate this rule.
            </p>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <Button size="sm" variant="primary" loading={pending} onClick={() => void run(openAction)}>
              Record override
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpenAction(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
