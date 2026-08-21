'use client';

import * as React from 'react';
import Link from 'next/link';
import { Globe, Loader2, Radar, ShieldAlert } from 'lucide-react';
import { checkDiscoveryUrl } from '@brandlens/contracts';
import type { DiscoveryRunDTO } from '@brandlens/contracts';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { DiscoveryProgress } from '@/components/discovery-progress';
import { useDiscoveryRunsQuery, useStartDiscoveryMutation } from '@/hooks/use-discovery';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'major' | 'blocker' | 'accent'> = {
  queued: 'neutral',
  running: 'accent',
  completed: 'ok',
  partial: 'major',
  failed: 'blocker',
  cancelled: 'neutral',
};

export function DiscoverView() {
  const { toast } = useToast();
  const [url, setUrl] = React.useState('');
  const [maxPages, setMaxPages] = React.useState('8');
  const [maxDepth, setMaxDepth] = React.useState('2');
  const [runSelfCheck, setRunSelfCheck] = React.useState(true);
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);

  const runs = useDiscoveryRunsQuery();
  const start = useStartDiscoveryMutation();

  // Validated with the SAME function the API and the crawler use, so the
  // message a user sees for a private address is the message the server would
  // have given — no second, more permissive opinion living in the browser.
  const guard = url.trim() ? checkDiscoveryUrl(url) : null;
  const canSubmit = Boolean(guard?.ok) && !start.isPending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!guard?.ok) return;

    start.mutate(
      {
        url,
        options: {
          maxPages: Number(maxPages),
          maxDepth: Number(maxDepth),
          runSelfCheck,
        },
      },
      {
        onSuccess: (run) => {
          setActiveRunId(run.id);
          toast({ title: 'Discovery started', description: `Crawling ${new URL(run.originUrl).hostname}` });
        },
        onError: (error) => toast({ tone: 'error', title: 'Could not start', description: errorMessage(error) }),
      },
    );
  };

  const columns: Array<Column<DiscoveryRunDTO>> = [
    {
      id: 'site',
      header: 'Site',
      sortValue: (r) => r.originUrl,
      cell: (r) => (
        <Link href={`/discover/${r.id}`} className="font-medium text-fg hover:text-accent">
          {hostOf(r.originUrl)}
        </Link>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
          {r.status === 'running' ? <span className="text-[11px] text-fg-subtle">{r.stage}</span> : null}
        </div>
      ),
    },
    {
      id: 'pages',
      header: 'Pages',
      align: 'right',
      sortValue: (r) => r.pagesHarvested,
      cell: (r) => <span className="num text-fg-muted">{r.pagesHarvested}</span>,
    },
    {
      id: 'rules',
      header: 'Rules proposed',
      align: 'right',
      sortValue: (r) => r.rulesProposed,
      cell: (r) => <span className="num text-fg-muted">{r.rulesProposed}</span>,
    },
    {
      id: 'score',
      header: 'Self-consistency',
      align: 'right',
      sortValue: (r) => r.consistencyScore ?? -1,
      cell: (r) =>
        typeof r.consistencyScore === 'number' ? (
          <span className="num font-medium text-fg">{r.consistencyScore.toFixed(1)}</span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: 'created',
      header: 'Started',
      align: 'right',
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="num text-fg-muted">{formatDateTime(r.createdAt)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Discover"
        description="Point BrandLens at a public website. It builds the brand ontology, proposes rules with citations, then checks the site against them."
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radar className="size-4 text-accent" aria-hidden="true" />
              Discover a brand from its website
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor="discover-url" className="mb-1 block text-xs font-medium text-fg">
                  Brand URL
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Globe
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
                      aria-hidden="true"
                    />
                    <Input
                      id="discover-url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="acme.com"
                      className="pl-8"
                      aria-invalid={Boolean(url.trim() && guard && !guard.ok)}
                      aria-describedby="discover-url-help"
                    />
                  </div>
                  <Button type="submit" disabled={!canSubmit}>
                    {start.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                    Discover
                  </Button>
                </div>
                <p id="discover-url-help" className="mt-1 text-[11px] text-fg-subtle">
                  {url.trim() && guard && !guard.ok ? (
                    <span className="flex items-center gap-1 text-blocker-fg">
                      <ShieldAlert className="size-3" aria-hidden="true" />
                      {guard.reason}
                    </span>
                  ) : (
                    'Public sites only. robots.txt is honoured and the crawl stays on one host.'
                  )}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="max-pages" className="mb-1 block text-xs font-medium text-fg">
                    Pages
                  </label>
                  <Select
                    id="max-pages"
                    value={maxPages}
                    onChange={(e) => setMaxPages(e.target.value)}
                    options={[
                      { value: '3', label: '3 — quick look (~1 min)' },
                      { value: '8', label: '8 — recommended (~3 min)' },
                      { value: '15', label: '15 — thorough (~6 min)' },
                      { value: '25', label: '25 — deep (~10 min)' },
                    ]}
                  />
                </div>
                <div>
                  <label htmlFor="max-depth" className="mb-1 block text-xs font-medium text-fg">
                    Crawl depth
                  </label>
                  <Select
                    id="max-depth"
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(e.target.value)}
                    options={[
                      { value: '0', label: '0 — this page only' },
                      { value: '1', label: '1 — nav links' },
                      { value: '2', label: '2 — recommended' },
                      { value: '3', label: '3 — deep' },
                    ]}
                  />
                </div>
                <div>
                  <span className="mb-1 block text-xs font-medium text-fg">Self-check</span>
                  <label className="flex h-8 items-center gap-2 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      checked={runSelfCheck}
                      onChange={(e) => setRunSelfCheck(e.target.checked)}
                      className="size-3.5 accent-[var(--accent)]"
                    />
                    Grade the site against its own rules
                  </label>
                </div>
              </div>

              <p className="rounded-md bg-surface-2 p-2.5 text-[11px] leading-4 text-fg-muted">
                Everything discovery finds is <strong className="font-medium text-fg">proposed</strong>, never
                activated. A convention a website follows is not automatically a standard the brand intends — a person
                decides that.
              </p>
            </form>
          </CardContent>
        </Card>

        {activeRunId ? <DiscoveryProgress runId={activeRunId} onDismiss={() => setActiveRunId(null)} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>Recent discovery runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {runs.isPending ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : runs.isError ? (
              <ErrorState message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
            ) : !runs.data?.length ? (
              <EmptyState
                title="No discovery runs yet"
                description="Enter a brand's URL above to build an ontology from their public site."
              />
            ) : (
              <DataTable rows={runs.data} columns={columns} rowKey={(r) => r.id} />
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
