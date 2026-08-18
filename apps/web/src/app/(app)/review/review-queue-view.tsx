'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardCheck, Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Review } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/data-table';
import { useReviewsQuery } from '@/hooks/use-reviews';
import { useMembersQuery } from '@/hooks/use-platform';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/lib/format';
import { REVIEW_STATE_LABEL } from '@/lib/domain';

const STATE_TONE: Record<string, 'ok' | 'accent' | 'major' | 'blocker' | 'advisory' | 'neutral'> = {
  approved: 'ok',
  pending: 'accent',
  in_review: 'accent',
  changes_requested: 'major',
  rejected: 'blocker',
  withdrawn: 'advisory',
};

const STAGES = ['creative', 'brand', 'legal', 'marketing_ops'];

export function ReviewQueueView() {
  const router = useRouter();
  const params = useSearchParams();
  const [state, setState] = React.useState('');
  const [stage, setStage] = React.useState('');
  const [overdue, setOverdue] = React.useState(false);
  // Deep link from the trace viewer: "show me the reviews for this asset".
  const [assetId, setAssetId] = React.useState(params.get('assetId') ?? '');

  const { data: members } = useMembersQuery();
  const { data, isPending, isError, error, refetch } = useReviewsQuery({
    state: state || undefined,
    stage: stage || undefined,
    overdue: overdue || undefined,
    assetId: assetId || undefined,
    pageSize: 100,
  });

  const memberNames = React.useMemo(() => {
    const map = new Map<string, string>();
    members?.forEach((m) => map.set(m.userId, m.name ?? m.email));
    return map;
  }, [members]);

  const columns: Array<Column<Review>> = [
    {
      id: 'state',
      header: 'State',
      sortValue: (r) => r.state,
      cell: (r) => <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>{REVIEW_STATE_LABEL[r.state] ?? r.state}</Badge>,
    },
    { id: 'stage', header: 'Stage', sortValue: (r) => r.stage, cell: (r) => <Badge tone="outline">{r.stage}</Badge> },
    {
      id: 'asset',
      header: 'Asset',
      cell: (r) => (
        <Link href={`/assets/${r.assetId}`} className="num text-fg hover:text-accent">
          {r.assetId.slice(0, 16)}…
        </Link>
      ),
    },
    {
      id: 'run',
      header: 'Check run',
      cell: (r) =>
        r.checkRunId ? (
          <Link href={`/checks/${r.checkRunId}`} className="num text-accent hover:underline">
            {r.checkRunId.slice(0, 12)}…
          </Link>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: 'assignee',
      header: 'Assigned to',
      sortValue: (r) => r.assignedToUserId ?? '',
      cell: (r) => (
        <span className="text-fg-muted">
          {r.assignedToUserId ? (memberNames.get(r.assignedToUserId) ?? r.assignedToUserId.slice(0, 8)) : 'Unassigned'}
        </span>
      ),
    },
    {
      id: 'due',
      header: 'Due',
      align: 'right',
      sortValue: (r) => r.dueAt ?? '',
      cell: (r) => {
        if (!r.dueAt) return <span className="text-fg-subtle">—</span>;
        const late = new Date(r.dueAt).getTime() < Date.now() && !r.decidedAt;
        return (
          <span className={late ? 'num inline-flex items-center gap-1 text-blocker-fg' : 'num text-fg-muted'}>
            {late ? <Clock className="size-3" aria-hidden="true" /> : null}
            {formatRelative(r.dueAt)}
          </span>
        );
      },
    },
    {
      id: 'created',
      header: 'Opened',
      align: 'right',
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="num text-fg-muted">{formatDateTime(r.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Review queue"
        description="Multi-stage gates. Every decision recorded here becomes a gold label and feeds rule calibration."
      />

      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-44"
            value={state}
            placeholder="All states"
            onChange={(event) => setState(event.target.value)}
            aria-label="Filter by state"
            options={Object.entries(REVIEW_STATE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            className="w-40"
            value={stage}
            placeholder="All stages"
            onChange={(event) => setStage(event.target.value)}
            aria-label="Filter by stage"
            options={STAGES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
          />
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-fg-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--accent)]"
              checked={overdue}
              onChange={(event) => setOverdue(event.target.checked)}
            />
            Overdue only
          </label>
          {assetId ? (
            <Button size="xs" variant="outline" onClick={() => setAssetId('')}>
              <X className="size-3" aria-hidden="true" />
              Asset filter
              <span className="num">{assetId.slice(0, 8)}…</span>
            </Button>
          ) : null}
          <span className="num text-fg-subtle">{data?.total ?? 0} item(s)</span>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(r) => r.id}
          caption="Review queue"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          onRowClick={(review) => router.push(`/review/${review.id}`)}
          pageSize={25}
          dense
          initialSort={{ columnId: 'due', direction: 'asc' }}
          empty={
            <EmptyState
              icon={ClipboardCheck}
              title="Nothing waiting on a human"
              description="Reviews open automatically when a run has blockers or abstentions, and by hand for MLR-style gates."
              actionLabel="See recent checks"
              actionHref="/checks"
            />
          }
        />
      </PageBody>
    </div>
  );
}
