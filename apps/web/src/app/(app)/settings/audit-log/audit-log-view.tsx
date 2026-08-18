'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import type { AuditEntry } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Drawer } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/data-table';
import { useAuditLogQuery, useMembersQuery } from '@/hooks/use-platform';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const PAGE_SIZE = 50;

export function AuditLogView() {
  const [action, setAction] = React.useState('');
  const [entityType, setEntityType] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<AuditEntry | null>(null);

  const { data: members } = useMembersQuery();
  const { data, isPending, isError, error, refetch } = useAuditLogQuery({
    action: action || undefined,
    entityType: entityType || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const actorNames = React.useMemo(() => {
    const map = new Map<string, string>();
    members?.forEach((m) => map.set(m.userId, m.name ?? m.email));
    return map;
  }, [members]);

  React.useEffect(() => {
    setPage(1);
  }, [action, entityType]);

  const columns: Array<Column<AuditEntry>> = [
    {
      id: 'action',
      header: 'Action',
      sortValue: (e) => e.action,
      cell: (e) => (
        <Badge tone="outline" mono>
          {e.action}
        </Badge>
      ),
    },
    {
      id: 'entity',
      header: 'Entity',
      cell: (e) => (
        <span className="num text-fg-muted">
          {e.entityType}
          {e.entityId ? <span className="text-fg-subtle"> · {e.entityId.slice(0, 8)}…</span> : null}
        </span>
      ),
    },
    {
      id: 'actor',
      header: 'Actor',
      cell: (e) => (
        <span className="text-fg">
          {e.actorUserId
            ? (actorNames.get(e.actorUserId) ?? e.actorUserId.slice(0, 8))
            : e.actorApiKeyId
              ? 'API key'
              : 'system'}
        </span>
      ),
    },
    { id: 'ip', header: 'IP', cell: (e) => <span className="num text-fg-subtle">{e.ip ?? '—'}</span> },
    {
      id: 'created',
      header: 'When',
      align: 'right',
      sortValue: (e) => e.createdAt,
      cell: (e) => <span className="num text-fg-muted">{formatDateTime(e.createdAt)}</span>,
    },
  ];

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Append-only. Every activation, override, key mint and configuration change, with the actor who made it."
      />

      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-52"
            placeholder="Action, e.g. rule.activate"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            aria-label="Filter by action"
          />
          <Input
            className="w-44"
            placeholder="Entity type"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
            aria-label="Filter by entity type"
          />
          <span className="num text-fg-subtle">{data?.total ?? 0} entries</span>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(e) => e.id}
          caption="Audit trail"
          loading={isPending}
          error={isError ? errorMessage(error) : null}
          onRetry={() => void refetch()}
          onRowClick={(entry) => setDetail(entry)}
          dense
          empty={
            <EmptyState
              icon={ScrollText}
              title="No audit entries"
              description="Entries appear as soon as anyone changes configuration or decides a finding."
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

      {detail ? (
        <Drawer open onClose={() => setDetail(null)} title={detail.action} description={formatDateTime(detail.createdAt)}>
          <dl className="space-y-2 text-xs">
            <div>
              <dt className="text-fg-subtle">Entity</dt>
              <dd className="num mt-0.5 break-all text-fg">
                {detail.entityType} {detail.entityId ?? ''}
              </dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Actor</dt>
              <dd className="num mt-0.5 break-all text-fg">
                {detail.actorUserId ?? detail.actorApiKeyId ?? 'system'}
              </dd>
            </div>
            <div>
              <dt className="text-fg-subtle">User agent</dt>
              <dd className="mt-0.5 break-all text-fg-muted">{detail.userAgent ?? '—'}</dd>
            </div>
          </dl>
          {detail.payload ? (
            <pre className="mt-3 max-h-[60vh] overflow-auto scroll-thin rounded-md bg-surface-2 p-2.5 font-mono text-[11px] text-fg">
              {JSON.stringify(detail.payload, null, 2)}
            </pre>
          ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}
