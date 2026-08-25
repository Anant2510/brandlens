'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import type { DiscoveryRunDTO, DiscoveryStage } from '@brandlens/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { useCancelDiscoveryMutation, useDiscoveryRunQuery } from '@/hooks/use-discovery';
import { cn } from '@/lib/utils';

/**
 * Live stage tracker for a discovery run.
 *
 * The stage names are the user-facing contract of a long operation. Three
 * minutes of a single spinner reads as "hung"; three minutes of "harvesting
 * 6 of 8 → extracting → inducing" reads as work. Each stage says what it is
 * doing to somebody else's website, which is also the honest thing to show.
 */
const STAGES: Array<{ id: DiscoveryStage; label: string; detail: string }> = [
  { id: 'harvesting', label: 'Harvesting', detail: 'Rendering pages in a headless browser' },
  { id: 'extracting', label: 'Extracting', detail: 'Measuring palette, type and logo from computed styles' },
  { id: 'inducing', label: 'Inducing', detail: 'Proposing rules and compiling a ruleset' },
  { id: 'checking', label: 'Checking', detail: 'Running the analyzers over the harvested pages' },
  { id: 'reporting', label: 'Reporting', detail: 'Aggregating the consolidated report' },
];

export function DiscoveryProgress({ runId, onDismiss }: { runId: string; onDismiss?: () => void }) {
  const { data: run } = useDiscoveryRunQuery(runId);
  const cancel = useCancelDiscoveryMutation();

  if (!run) return null;

  const currentIndex = STAGES.findIndex((s) => s.id === run.stage);
  const isDone = run.status === 'completed' || run.status === 'partial';
  const isDead = run.status === 'failed' || run.status === 'cancelled';

  // The worker prepends a `diagnosis:<kind>` marker to stageErrors when a run
  // harvested nothing. It steers the banner's tone and is not itself a page
  // failure, so it is read here and kept out of the list below.
  const diagnosisKind = run.stageErrors.find((e) => e.message.startsWith('diagnosis:'))?.message.slice('diagnosis:'.length);
  const harvestErrors = run.stageErrors.filter((e) => !e.message.startsWith('diagnosis:'));

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-fg">{hostOf(run.originUrl)}</h2>
            <p className="text-[11px] text-fg-muted">
              {run.pagesHarvested} page{run.pagesHarvested === 1 ? '' : 's'} harvested
              {run.pagesFailed > 0 ? ` · ${run.pagesFailed} failed` : ''}
              {run.rulesProposed > 0 ? ` · ${run.rulesProposed} rules proposed` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isDone ? (
              <Link href={`/discover/${run.id}`} className={buttonClasses('primary', 'sm')}>
                View report
              </Link>
            ) : isDead ? null : (
              <Button variant="outline" size="sm" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending}>
                Stop
              </Button>
            )}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss progress"
                className="rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <ol className="space-y-1.5">
          {STAGES.map((stage, index) => {
            const state =
              isDead && index === currentIndex
                ? 'failed'
                : run.stage === 'done' || index < currentIndex
                  ? 'done'
                  : index === currentIndex
                    ? 'active'
                    : 'pending';

            return (
              <li key={stage.id} className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full border',
                    state === 'done' && 'border-transparent bg-[var(--ok-soft)] text-[var(--ok-fg)]',
                    state === 'active' && 'border-accent text-accent',
                    state === 'failed' && 'border-transparent bg-blocker-soft text-blocker-fg',
                    state === 'pending' && 'border-border text-fg-subtle',
                  )}
                >
                  {state === 'done' ? (
                    <Check className="size-2.5" aria-hidden="true" />
                  ) : state === 'active' ? (
                    <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
                  ) : state === 'failed' ? (
                    <AlertTriangle className="size-2.5" aria-hidden="true" />
                  ) : (
                    <span className="num text-[9px]">{index + 1}</span>
                  )}
                </span>
                <span className={cn('text-xs', state === 'pending' ? 'text-fg-subtle' : 'text-fg')}>{stage.label}</span>
                <span className="hidden text-[11px] text-fg-subtle sm:inline">{stage.detail}</span>
                {state === 'active' ? (
                  <span className="ml-auto w-24">
                    <Progress value={run.stageProgress * 100} size="xs" />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>

        {run.error ? (
          // A site that refuses crawlers is an expected outcome, not a crash,
          // so it reads as advisory rather than blocker-red. The worker tags
          // the run with a `diagnosis:<kind>` marker for exactly this.
          <p
            role="alert"
            className={
              diagnosisKind === 'bot-refused'
                ? 'rounded-md bg-advisory-soft p-2 text-[11px] text-advisory-fg'
                : 'rounded-md bg-blocker-soft p-2 text-[11px] text-blocker-fg'
            }
          >
            {run.error}
          </p>
        ) : null}

        {harvestErrors.length > 0 ? (
          <details className="rounded-md bg-surface-2 p-2">
            <summary className="cursor-pointer text-[11px] text-fg-muted">
              {harvestErrors.length} page{harvestErrors.length === 1 ? '' : 's'} could not be harvested
            </summary>
            <ul className="mt-1.5 space-y-1">
              {harvestErrors.slice(0, 8).map((e, i) => (
                <li key={i} className="text-[11px] text-fg-subtle">
                  <span className="num">{e.url ? shortPath(e.url) : e.stage}</span> — {e.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function shortPath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

export type { DiscoveryRunDTO };
