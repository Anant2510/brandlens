'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CheckRunSummary } from '@brandlens/contracts';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/data-table';
import { ScorePill } from '@/components/score-gauge';
import { useChecksQuery } from '@/hooks/use-checks';
import { useBrandsQuery } from '@/hooks/use-brands';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatDuration, formatPercent, formatUsd, shortHash } from '@/lib/format';
import { RUN_STATUS_LABEL } from '@/lib/domain';

const PAGE_SIZE = 25;

export function ChecksView() {
  const router = useRouter();
  const params = useSearchParams();

  const [brandId, setBrandId] = React.useState(params.get('brandId') ?? '');
  const [status, setStatus] = React.useState(params.get('status') ?? '');
  const [scoreBand, setScoreBand] = React.useState(params.get('scoreBand') ?? '');
  const [page, setPage] = React.useState(1);

  const { data: brands } = useBrandsQuery();
  const { data, isPending, isError, error, refetch, isFetching } = useChecksQuery({
    brandId: brandId || undefined,
    status: status || undefined,
    scoreBand: scoreBand || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  React.useEffect(() => {
    setPage(1);
  }, [brandId, status, scoreBand]);

  const columns: Array<Column<CheckRunSummary>> = [
    {
      id: 'score',
      header: 'Score',
      width: '5.5rem',
      sortValue: (r) => r.score ?? -1,
      cell: (r) => <ScorePill score={r.score} band={r.scoreBand} hasBlocker={r.hasBlocker} />,
    },
    {
      id: 'id',
      header: 'Run',
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/checks/${r.id}`} className="num block truncate text-fg hover:text-accent">
            {r.id.slice(0, 18)}…
          </Link>
          <p className="num text-fg-subtle" title={r.rulesetHash}>
            ruleset {shortHash(r.rulesetHash, 10)}
          </p>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'degraded' ? 'major' : r.status === 'failed' ? 'blocker' : 'neutral'}>
            {RUN_STATUS_LABEL[r.status] ?? r.status}
          </Badge>
          {r.degradedReason ? (
            <span className="max-w-[16rem] truncate text-[11px] text-major-fg" title={r.degradedReason}>
              {r.degradedReason}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'blocker',
      header: 'Blocker',
      align: 'center',
      sortValue: (r) => (r.hasBlocker ? 1 : 0),
      cell: (r) => (r.hasBlocker ? <Badge tone="blocker">Yes</Badge> : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'criteria',
      header: 'Passed / evaluated',
      align: 'right',
      sortValue: (r) => r.criteriaEvaluated,
      cell: (r) => (
        <span className="num text-fg-muted">
          {r.criteriaPassed}/{r.criteriaEvaluated}
          {r.criteriaAbstained > 0 ? <span className="text-fg-subtle"> · {r.criteriaAbstained} abst.</span> : null}
        </span>
      ),
    },
    {
      id: 'coverage',
      header: 'Coverage',
      align: 'right',
      sortValue: (r) => r.coverageRate ?? -1,
      cell: (r) => <span className="num text-fg-muted">{formatPercent(r.coverageRate, 0)}</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (r) => r.costUsd,
      cell: (r) => (
        <span className="num text-fg-muted">
          {formatUsd(r.costUsd)}
          {r.cacheHits > 0 ? <span className="text-fg-subtle"> · {r.cacheHits} cached</span> : null}
        </span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'right',
      sortValue: (r) => r.durationMs ?? -1,
      cell: (r) => <span className="num text-fg-muted">{formatDuration(r.durationMs)}</span>,
    },
    {
      id: 'created',
      header: 'Run at',
      align: 'right',
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="num text-fg-muted">{formatDateTime(r.createdAt)}</span>,
    },
  ];

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Check runs"
        description="Every verification, with the ruleset hash it was evaluated against. History is never rewritten by a rule change."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} loading={isFetching}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-44"
            value={brandId}
            placeholder="All brands"
            onChange={(event) => setBrandId(event.target.value)}
            aria-label="Filter by brand"
            options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            className="w-36"
            value={status}
            placeholder="All statuses"
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
            options={Object.entries(RUN_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            className="w-36"
            value={scoreBand}
            placeholder="All bands"
            onChange={(event) => setScoreBand(event.target.value)}
            aria-label="Filter by score band"
            options={[
              { value: 'pass', label: 'Pass' },
              { value: 'conditional', label: 'Conditional' },
              { value: 'fail', label: 'Fail' },
            ]}
          />
          <span className="num text-fg-subtle">{total} run(s)</span>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(r) => r.id}
          caption="Check runs"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          onRowClick={(run) => router.push(`/checks/${run.id}`)}
          dense
          empty={
            <EmptyState
              icon={ShieldCheck}
              title="No check runs"
              description="Upload an asset and run a verification. Each run produces a score, structured findings and an immutable decision trace."
              actionLabel="Go to assets"
              actionHref="/assets"
            />
          }
        />

        {totalPages > 1 ? (
          <nav className="flex items-center justify-between text-xs text-fg-muted" aria-label="Pagination">
            <p className="tabular">
              Page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage((p) => p + 1)}>
                Next
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </PageBody>
    </div>
  );
}
