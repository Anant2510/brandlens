'use client';

import * as React from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAssembleBriefMutation, useBriefQuery } from '@/hooks/use-assemble';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatMeasured, formatUsd, shortHash } from '@/lib/format';

export function BriefDetailView({ briefId }: { briefId: string }) {
  const { toast } = useToast();
  const { data, isPending, isError, error, refetch } = useBriefQuery(briefId);
  const assemble = useAssembleBriefMutation(briefId);

  if (isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-64 w-full" />
      </PageBody>
    );
  }

  if (isError || !data) {
    return (
      <PageBody>
        <ErrorState title="Could not load this brief" message={errorMessage(error)} onRetry={() => void refetch()} />
      </PageBody>
    );
  }

  const { brief, plans } = data;
  const latest = plans?.[0];

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: 'Assemble', href: '/assemble' }, { label: brief.title }]}
        title={brief.title}
        description={brief.objective ?? 'No objective recorded.'}
        actions={
          <Button
            variant="primary"
            size="sm"
            loading={assemble.isPending}
            onClick={() =>
              assemble.mutate(undefined, {
                onSuccess: () => toast({ title: 'Assembly plan built', tone: 'success' }),
                onError: (mutationError) =>
                  toast({ title: 'Assembly failed', description: errorMessage(mutationError), tone: 'error' }),
              })
            }
          >
            <Play className="size-3.5" aria-hidden="true" />
            {plans?.length ? 'Re-assemble' : 'Build plan'}
          </Button>
        }
      />

      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {!latest ? (
            <EmptyState
              icon={ShieldCheck}
              title="No plan yet"
              description="Assembly resolves the brief against the brand's active ruleset and the channel-spec registry, so the plan is constraint-satisfying before anything is produced."
              actionLabel="Build the plan"
              onAction={() => assemble.mutate()}
            />
          ) : (
            plans.map((plan) => (
              <Card key={plan.id}>
                <CardHeader>
                  <div>
                    <CardTitle>Assembly plan</CardTitle>
                    <p className="mt-0.5 num text-[11px] text-fg-muted" title={plan.rulesetHash}>
                      ruleset {shortHash(plan.rulesetHash, 14)} · {formatDateTime(plan.createdAt)}
                    </p>
                  </div>
                  <Badge tone="outline" mono>
                    {formatUsd(plan.costUsd)}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  {plan.rationale ? (
                    <p className="rounded-md bg-surface-2 p-2 text-xs leading-5 text-fg-muted">{plan.rationale}</p>
                  ) : null}

                  {plan.items.length === 0 ? (
                    <p className="text-xs text-fg-subtle">The plan produced no items.</p>
                  ) : (
                    <ul className="space-y-2">
                      {plan.items.map((item, index) => (
                        <li key={index} className="rounded-md border border-border p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {['platform', 'placement', 'assetType', 'market'].map((key) =>
                              item[key] ? (
                                <Badge key={key} tone="outline">
                                  {String(item[key])}
                                </Badge>
                              ) : null,
                            )}
                          </div>
                          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
                            {Object.entries(item)
                              .filter(([key]) => !['platform', 'placement', 'assetType', 'market'].includes(key))
                              .slice(0, 9)
                              .map(([key, value]) => (
                                <div key={key} className="min-w-0">
                                  <dt className="truncate text-fg-subtle">{key}</dt>
                                  <dd className="num truncate text-fg" title={formatMeasured(value)}>
                                    {formatMeasured(value)}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        </li>
                      ))}
                    </ul>
                  )}

                  {plan.constraintsApplied ? (
                    <details className="rounded-md border border-border">
                      <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-medium text-fg-muted">
                        Constraints applied
                      </summary>
                      <pre className="max-h-64 overflow-auto scroll-thin border-t border-border p-2.5 font-mono text-[11px] text-fg">
                        {JSON.stringify(plan.constraintsApplied, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Brief</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {brief.keyMessage ? (
                <div>
                  <p className="text-fg-subtle">Key message</p>
                  <p className="mt-0.5 leading-5 text-fg">{brief.keyMessage}</p>
                </div>
              ) : null}
              <div>
                <p className="text-fg-subtle">Status</p>
                <Badge tone="outline" className="mt-0.5">
                  {brief.status}
                </Badge>
              </div>
              <div>
                <p className="text-fg-subtle">Created</p>
                <p className="num mt-0.5 text-fg">{formatDateTime(brief.createdAt)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Targets ({brief.targets?.length ?? 0})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {(brief.targets ?? []).map((target, index) => (
                  <li key={index} className="flex items-center gap-2 px-4 py-2 text-[11px]">
                    <span className="num min-w-0 flex-1 truncate text-fg">
                      {target.platform} / {target.placement}
                    </span>
                    <span className="num text-fg-subtle">{target.assetType}</span>
                    <span className="num font-semibold text-fg">×{target.count}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {brief.mandatories?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Mandatories</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-xs leading-5 text-fg">
                  {brief.mandatories.map((item, index) => (
                    <li key={index} className="flex gap-1.5">
                      <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </PageBody>
    </div>
  );
}
