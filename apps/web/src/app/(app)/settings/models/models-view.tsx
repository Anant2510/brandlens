'use client';

import * as React from 'react';
import { Cpu, Info, ShieldQuestion } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/data-table';
import { StatTile } from '@/components/stat-tile';
import { useCostReportQuery } from '@/hooks/use-analytics';
import { useOrganizationQuery } from '@/hooks/use-platform';
import { errorMessage } from '@/lib/api-client';
import { formatPercent, formatUsd } from '@/lib/format';

interface ProviderRow {
  provider: string;
  model: string;
  costUsd: number;
  calls: number;
}

const ROLES = [
  {
    role: 'Judge',
    envKeys: 'LLM_JUDGE_PROVIDER / LLM_JUDGE_MODEL',
    detail:
      'The T2 vision judge. Deliberately configured to a different model family than your generator — a model asked to grade its own output shows measurable self-preference bias.',
  },
  {
    role: 'Extract',
    envKeys: 'LLM_EXTRACT_PROVIDER / LLM_EXTRACT_MODEL',
    detail: 'Brand-book ingestion and rule extraction. Needs vision plus long context to cite a page and a bounding box.',
  },
  {
    role: 'Text',
    envKeys: 'LLM_TEXT_PROVIDER / LLM_TEXT_MODEL',
    detail: 'Copy analysis, embedding orchestration, assemble and predict.',
  },
];

export function ModelsView() {
  const cost = useCostReportQuery({ from: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  const org = useOrganizationQuery();

  const columns: Array<Column<ProviderRow>> = [
    {
      id: 'provider',
      header: 'Provider',
      sortValue: (r) => r.provider,
      cell: (r) => <span className="num text-fg">{r.provider}</span>,
    },
    { id: 'model', header: 'Model', sortValue: (r) => r.model, cell: (r) => <span className="num text-fg-muted">{r.model}</span> },
    {
      id: 'calls',
      header: 'Calls',
      align: 'right',
      sortValue: (r) => r.calls,
      cell: (r) => <span className="num text-fg-muted">{r.calls}</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (r) => r.costUsd,
      cell: (r) => <span className="num font-semibold text-fg">{formatUsd(r.costUsd)}</span>,
    },
    {
      id: 'perCall',
      header: 'Cost / call',
      align: 'right',
      sortValue: (r) => (r.calls > 0 ? r.costUsd / r.calls : 0),
      cell: (r) => <span className="num text-fg-muted">{formatUsd(r.calls > 0 ? r.costUsd / r.calls : 0)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Models"
        description="BrandLens is model-agnostic by design. Providers are configured per role in the server environment, not per tenant in the UI."
      />

      <PageBody className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <Info className="mt-px size-4 shrink-0 text-accent" aria-hidden="true" />
          <p className="text-xs leading-5 text-fg-muted">
            Model selection lives in the API process environment so a deployment can be reproduced exactly and a model swap
            is a config change with an audit trail — not a click that silently alters every future verdict. This screen
            reports what the platform actually called, which is the number that matters.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="30-day spend"
            value={cost.data ? formatUsd(cost.data.totalUsd) : '—'}
            icon={Cpu}
            sub={org.data ? `Daily limit ${formatUsd(org.data.dailyUsdLimit)}` : undefined}
          />
          <StatTile
            label="Cache hit rate"
            value={cost.data ? formatPercent(cost.data.cacheHitRate, 0) : '—'}
            hint="A cache hit costs nothing and returns the identical verdict, because the cache key includes the ruleset hash."
            sub={cost.data ? `${formatUsd(cost.data.cacheSavingsUsd)} saved` : undefined}
          />
          <StatTile
            label="Cost per check"
            value={cost.data ? formatUsd(cost.data.costPerCheck) : '—'}
            sub={cost.data ? `${cost.data.assetsAnalyzed} asset(s) analyzed` : undefined}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Model roles</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {ROLES.map((entry) => (
                <li key={entry.role} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-fg">{entry.role}</h3>
                    <Badge tone="outline" mono>
                      {entry.envKeys}
                    </Badge>
                  </div>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">{entry.detail}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-fg">Observed usage (last 30 days)</h2>
          {cost.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : cost.isError ? (
            <ErrorState message={errorMessage(cost.error)} onRetry={() => void cost.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              rows={cost.data?.byProvider ?? []}
              rowKey={(r) => `${r.provider}-${r.model}`}
              caption="Model usage by provider"
              pageSize={20}
              dense
              initialSort={{ columnId: 'cost', direction: 'desc' }}
              empty={
                <EmptyState
                  icon={ShieldQuestion}
                  title="No model calls recorded"
                  description="Deterministic (T0) rules need no model at all, so a brand whose ruleset is fully deterministic will show nothing here — and cost nothing."
                />
              }
            />
          )}
        </section>
      </PageBody>
    </div>
  );
}
