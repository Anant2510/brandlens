'use client';

import * as React from 'react';
import { Info, TrendingUp, Users } from 'lucide-react';
import type { AudiencePanel } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { DimensionBars } from '@/components/dimension-bars';
import { usePanelsQuery, useCreatePredictionMutation, usePredictionQuery } from '@/hooks/use-predict';
import { useBrandsQuery } from '@/hooks/use-brands';
import { useAssetsQuery } from '@/hooks/use-assets';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatPercent, formatUsd } from '@/lib/format';

export function PredictView() {
  const { toast } = useToast();
  const [brandId, setBrandId] = React.useState('');
  const [assetId, setAssetId] = React.useState('');
  const [panelId, setPanelId] = React.useState('');
  const [predictionId, setPredictionId] = React.useState<string | null>(null);

  const { data: brands } = useBrandsQuery();
  const { data: panels, isPending, isError, error, refetch } = usePanelsQuery(brandId || undefined);
  const { data: assets } = useAssetsQuery({ brandId: brandId || undefined, pageSize: 100 });
  const create = useCreatePredictionMutation();
  const prediction = usePredictionQuery(predictionId ?? undefined);

  const columns: Array<Column<AudiencePanel>> = [
    { id: 'name', header: 'Panel', sortValue: (p) => p.name, cell: (p) => <span className="font-medium text-fg">{p.name}</span> },
    {
      id: 'personas',
      header: 'Personas',
      align: 'right',
      sortValue: (p) => p.personas?.length ?? 0,
      cell: (p) => <span className="num text-fg-muted">{p.personas?.length ?? 0}</span>,
    },
    {
      id: 'grounding',
      header: 'Grounding',
      cell: (p) => (
        <span className="text-[11px] text-fg-muted">
          {p.groundingStats ? Object.keys(p.groundingStats).length + ' signal(s)' : 'ungrounded'}
        </span>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      align: 'right',
      sortValue: (p) => p.createdAt,
      cell: (p) => <span className="num text-fg-muted">{formatDateTime(p.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Predict"
        description="Synthetic audience response, ranked against your own corpus. Absolute numbers from a panel are not evidence; relative ranking is."
        actions={
          <Select
            className="w-44"
            value={brandId}
            placeholder="All brands"
            onChange={(event) => {
              setBrandId(event.target.value);
              setAssetId('');
            }}
            aria-label="Filter by brand"
            options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
          />
        }
      />

      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3">
            <Info className="mt-px size-4 shrink-0 text-accent" aria-hidden="true" />
            <p className="text-xs leading-5 text-fg-muted">
              A synthetic panel does not measure real-world performance. It ranks a candidate against the tenant corpus and
              reports a percentile with a confidence interval — useful for choosing between variants, not for forecasting
              revenue.
            </p>
          </div>

          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-fg">Audience panels</h2>
            <DataTable
              columns={columns}
              rows={panels ?? []}
              rowKey={(p) => p.id}
              caption="Audience panels"
              loading={isPending}
              error={isError ? errorMessage(error) : null}
              onRetry={() => void refetch()}
              pageSize={15}
              dense
              empty={
                <EmptyState
                  icon={Users}
                  title="No panels defined"
                  description="A panel is a set of grounded personas. Create one through POST /v1/panels to run predictions against a consistent audience."
                />
              }
            />
          </section>

          {predictionId ? (
            <Card>
              <CardHeader>
                <CardTitle>Prediction</CardTitle>
                {prediction.data ? <Badge tone="outline">{prediction.data.status}</Badge> : null}
              </CardHeader>
              <CardContent>
                {prediction.isPending ? (
                  <Skeleton className="h-32 w-full" />
                ) : prediction.isError ? (
                  <ErrorState compact message={errorMessage(prediction.error)} onRetry={() => void prediction.refetch()} />
                ) : prediction.data ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-baseline gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-fg-subtle">Percentile vs corpus</p>
                        <p className="num text-2xl font-semibold text-fg">
                          {prediction.data.percentileVsCorpus === null
                            ? '—'
                            : formatPercent(
                                prediction.data.percentileVsCorpus > 1
                                  ? prediction.data.percentileVsCorpus / 100
                                  : prediction.data.percentileVsCorpus,
                                0,
                              )}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-fg-subtle">Interval</p>
                        <p className="num text-fg">
                          {prediction.data.intervalLow?.toFixed(1) ?? '—'} – {prediction.data.intervalHigh?.toFixed(1) ?? '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-fg-subtle">Cost</p>
                        <p className="num text-fg">{formatUsd(prediction.data.costUsd)}</p>
                      </div>
                    </div>

                    {prediction.data.dimensionScores ? (
                      <DimensionBars scores={prediction.data.dimensionScores} />
                    ) : null}

                    {prediction.data.recommendations?.length ? (
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-fg-muted">Recommendations</p>
                        <ul className="space-y-1 text-xs leading-5 text-fg">
                          {prediction.data.recommendations.map((item, index) => (
                            <li key={index} className="flex gap-1.5">
                              <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {prediction.data.error ? (
                      <p role="alert" className="rounded bg-blocker-soft px-2 py-1.5 text-[11px] text-blocker-fg">
                        {prediction.data.error}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Run a prediction</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <Select
              value={assetId}
              placeholder="Select an asset"
              aria-label="Asset to predict"
              onChange={(event) => setAssetId(event.target.value)}
              options={(assets?.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
            <Select
              value={panelId}
              placeholder="Default panel"
              aria-label="Audience panel"
              onChange={(event) => setPanelId(event.target.value)}
              options={(panels ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              disabled={!assetId}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { assetId, panelId: panelId || undefined },
                  {
                    onSuccess: (result) => {
                      setPredictionId(result.id);
                      toast({ title: 'Prediction queued', tone: 'success' });
                    },
                    onError: (mutationError) =>
                      toast({ title: 'Prediction failed', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <TrendingUp className="size-3.5" aria-hidden="true" />
              Predict response
            </Button>
            <p className="text-[11px] leading-4 text-fg-subtle">
              Predictions are queued; this panel polls until the result settles.
            </p>
          </CardContent>
        </Card>
      </PageBody>
    </div>
  );
}
