'use client';

import * as React from 'react';
import Link from 'next/link';
import { Download, ImageOff, ShieldCheck, TrendingUp } from 'lucide-react';
import type { CheckRunSummary } from '@brandlens/contracts';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { ScorePill } from '@/components/score-gauge';
import { useAssetDerivativesQuery, useAssetQuery } from '@/hooks/use-assets';
import { useChecksQuery, useCreateCheckMutation } from '@/hooks/use-checks';
import { useCreatePredictionMutation } from '@/hooks/use-predict';
import { errorMessage } from '@/lib/api-client';
import { formatBytes, formatDateTime, formatDuration, formatUsd } from '@/lib/format';
import { RUN_STATUS_LABEL } from '@/lib/domain';
import { cn } from '@/lib/utils';

export function AssetDetailView({ assetId }: { assetId: string }) {
  const { toast } = useToast();
  const { data: asset, isPending, isError, error, refetch } = useAssetQuery(assetId);
  const { data: derivatives } = useAssetDerivativesQuery(assetId);
  const { data: checks } = useChecksQuery({ assetId, pageSize: 50 });
  const createCheck = useCreateCheckMutation();
  const predict = useCreatePredictionMutation();

  if (isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-72 w-full" />
      </PageBody>
    );
  }

  if (isError || !asset) {
    return (
      <PageBody>
        <ErrorState title="Could not load this asset" message={errorMessage(error)} onRetry={() => void refetch()} />
      </PageBody>
    );
  }

  const columns: Array<Column<CheckRunSummary>> = [
    {
      id: 'score',
      header: 'Score',
      sortValue: (r) => r.score ?? -1,
      cell: (r) => <ScorePill score={r.score} band={r.scoreBand} hasBlocker={r.hasBlocker} />,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'degraded' ? 'major' : 'neutral'}>
          {RUN_STATUS_LABEL[r.status] ?? r.status}
        </Badge>
      ),
    },
    {
      id: 'criteria',
      header: 'Criteria',
      align: 'right',
      cell: (r) => (
        <span className="num text-fg-muted">
          {r.criteriaPassed}/{r.criteriaEvaluated}
        </span>
      ),
    },
    {
      id: 'blocker',
      header: 'Blocker',
      align: 'center',
      cell: (r) => (r.hasBlocker ? <Badge tone="blocker">Yes</Badge> : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (r) => r.costUsd,
      cell: (r) => <span className="num text-fg-muted">{formatUsd(r.costUsd)}</span>,
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'right',
      cell: (r) => <span className="num text-fg-muted">{formatDuration(r.durationMs)}</span>,
    },
    {
      id: 'created',
      header: 'Run at',
      align: 'right',
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="num text-fg-muted">{formatDateTime(r.createdAt)}</span>,
    },
    {
      id: 'open',
      header: 'Open',
      align: 'right',
      srOnlyHeader: true,
      cell: (r) => (
        <Link href={`/checks/${r.id}`} className="text-xs text-accent hover:underline">
          Trace
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: 'Assets', href: '/assets' }, { label: asset.name }]}
        title={asset.name}
        description={
          <span className="num">
            {asset.contentHash.slice(0, 20)}… · {asset.kind}
          </span>
        }
        actions={
          <>
            {asset.previewUrl ? (
              <a href={asset.previewUrl} download className={buttonClasses('outline', 'sm')}>
                <Download className="size-3.5" aria-hidden="true" />
                Download
              </a>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              loading={predict.isPending}
              onClick={() =>
                predict.mutate(
                  { assetId },
                  {
                    onSuccess: (prediction) =>
                      toast({
                        title: 'Prediction queued',
                        description: `Open it from Predict once it settles (${String(prediction.id).slice(0, 8)}…).`,
                        tone: 'info',
                      }),
                    onError: (mutationError) =>
                      toast({ title: 'Prediction failed', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <TrendingUp className="size-3.5" aria-hidden="true" />
              Predict response
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={createCheck.isPending}
              onClick={() =>
                createCheck.mutate(
                  { assetId, async: true },
                  {
                    onSuccess: () => toast({ title: 'Check queued', tone: 'success' }),
                    onError: (mutationError) =>
                      toast({ title: 'Could not start the check', description: errorMessage(mutationError), tone: 'error' }),
                  },
                )
              }
            >
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Run check
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card>
            <CardContent
              className={cn(
                'flex min-h-[18rem] items-center justify-center bg-surface-2',
                '[background-image:repeating-conic-gradient(var(--surface-3)_0_25%,transparent_0_50%)] [background-size:16px_16px]',
              )}
            >
              {asset.previewUrl ? (
                <img src={asset.previewUrl} alt={asset.name} className="max-h-[28rem] max-w-full object-contain" />
              ) : (
                <div className="text-center">
                  <ImageOff className="mx-auto size-5 text-fg-subtle" aria-hidden="true" />
                  <p className="mt-2 text-xs text-fg-muted">
                    {asset.kind === 'copy' ? 'Copy-only submission — no pixels to render.' : 'No preview available.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Properties</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <Pair label="Status" value={<Badge tone={asset.status === 'ready' ? 'ok' : 'neutral'}>{asset.status}</Badge>} />
                  <Pair label="Kind" value={asset.kind} />
                  <Pair label="Dimensions" value={asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'} />
                  <Pair label="Size" value={formatBytes(asset.byteSize)} />
                  <Pair label="MIME" value={asset.mimeType ?? '—'} />
                  <Pair label="DPI" value={asset.dpi ?? '—'} />
                  <Pair label="Color profile" value={asset.colorProfile ?? '—'} />
                  <Pair label="Fidelity" value={asset.sourceFidelity} />
                  <Pair label="Market" value={asset.market ?? '—'} />
                  <Pair label="Channel" value={asset.channel ?? '—'} />
                  <Pair label="Asset type" value={asset.assetType ?? '—'} />
                  <Pair label="Locale" value={asset.locale ?? '—'} />
                  <Pair label="Added" value={formatDateTime(asset.createdAt)} />
                  <Pair
                    label="Exemplar"
                    value={asset.isApprovedExemplar ? <Badge tone="ok">Approved</Badge> : 'No'}
                  />
                </dl>
                {asset.error ? (
                  <p role="alert" className="mt-3 rounded-md bg-blocker-soft px-2 py-1.5 text-[11px] text-blocker-fg">
                    Ingestion error: {asset.error}
                  </p>
                ) : null}
                {asset.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {asset.tags.map((tag) => (
                      <Badge key={tag} tone="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {Object.keys(asset.copyFields ?? {}).length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Copy fields</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-2 text-xs">
                    {Object.entries(asset.copyFields).map(([field, value]) => (
                      <div key={field}>
                        <dt className="num text-fg-subtle">{field}</dt>
                        <dd className="mt-0.5 leading-5 text-fg">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ) : null}

            {derivatives && derivatives.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Derivatives</CardTitle>
                  <span className="num text-fg-subtle">{derivatives.length}</span>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-[11px]">
                    {derivatives.slice(0, 8).map((derivative) => (
                      <li key={derivative.id} className="flex items-center gap-2">
                        <span className="num text-fg">{derivative.kind}</span>
                        <span className="num text-fg-subtle">
                          {derivative.width && derivative.height ? `${derivative.width}×${derivative.height}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-fg">Check history</h2>
          <DataTable
            columns={columns}
            rows={checks?.data ?? []}
            rowKey={(r) => r.id}
            caption="Check runs for this asset"
            pageSize={15}
            dense
            initialSort={{ columnId: 'created', direction: 'desc' }}
            empty={
              <EmptyState
                compact
                icon={ShieldCheck}
                title="Never checked"
                description="Run a verification to produce a score, findings and an immutable decision trace."
              />
            }
          />
        </section>
      </PageBody>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-fg">{value}</dd>
    </div>
  );
}
