'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Boxes, Grid2X2, ImageOff, List, ShieldCheck, Upload } from 'lucide-react';
import type { Asset } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { AssetUploader } from '@/components/asset-uploader';
import { useAssetsQuery } from '@/hooks/use-assets';
import { useBrandsQuery } from '@/hooks/use-brands';
import { useCreateCheckMutation } from '@/hooks/use-checks';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/hooks/query-keys';
import { errorMessage } from '@/lib/api-client';
import { formatBytes, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const KINDS = ['image', 'video', 'pdf', 'html', 'figma', 'pptx', 'psd', 'copy'];

const STATUS_TONE: Record<string, 'ok' | 'accent' | 'blocker' | 'neutral'> = {
  ready: 'ok',
  ingested: 'ok',
  queued: 'accent',
  processing: 'accent',
  failed: 'blocker',
};

export function AssetsView() {
  const params = useSearchParams();
  const { toast } = useToast();
  const client = useQueryClient();

  const [brandId, setBrandId] = React.useState(params.get('brandId') ?? '');
  const [kind, setKind] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [view, setView] = React.useState<'grid' | 'table'>('grid');
  const [uploadOpen, setUploadOpen] = React.useState(false);

  const { data: brands } = useBrandsQuery();
  const { data, isPending, isError, error, refetch } = useAssetsQuery({
    brandId: brandId || undefined,
    kind: kind || undefined,
    status: status || undefined,
    pageSize: 100,
  });
  const createCheck = useCreateCheckMutation();

  const rows = React.useMemo(() => {
    const list = data?.data ?? [];
    if (!search) return list;
    const needle = search.toLowerCase();
    return list.filter((a) => a.name.toLowerCase().includes(needle) || a.contentHash.includes(needle));
  }, [data, search]);

  const runCheck = (asset: Asset) =>
    createCheck.mutate(
      { assetId: asset.id, async: true },
      {
        onSuccess: (result) =>
          toast({
            title: 'Check queued',
            description: `Run ${String(result.id).slice(0, 8)}… — open it from the Checks screen once it settles.`,
            tone: 'success',
          }),
        onError: (mutationError) =>
          toast({ title: 'Could not start the check', description: errorMessage(mutationError), tone: 'error' }),
      },
    );

  const columns: Array<Column<Asset>> = [
    {
      id: 'name',
      header: 'Asset',
      sortValue: (a) => a.name,
      cell: (a) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-8 shrink-0 overflow-hidden rounded border border-border bg-surface-2">
            {a.previewUrl ? (
              <img src={a.previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center">
                <ImageOff className="size-3 text-fg-subtle" aria-hidden="true" />
              </span>
            )}
          </span>
          <div className="min-w-0">
            <Link href={`/assets/${a.id}`} className="block truncate font-medium text-fg hover:text-accent">
              {a.name}
            </Link>
            <p className="num text-fg-subtle">{a.contentHash.slice(0, 12)}…</p>
          </div>
        </div>
      ),
    },
    { id: 'kind', header: 'Kind', sortValue: (a) => a.kind, cell: (a) => <Badge tone="outline">{a.kind}</Badge> },
    {
      id: 'status',
      header: 'Status',
      sortValue: (a) => a.status,
      cell: (a) => <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>,
    },
    {
      id: 'dims',
      header: 'Dimensions',
      align: 'right',
      cell: (a) => (
        <span className="num text-fg-muted">{a.width && a.height ? `${a.width}×${a.height}` : '—'}</span>
      ),
    },
    {
      id: 'size',
      header: 'Size',
      align: 'right',
      sortValue: (a) => a.byteSize ?? 0,
      cell: (a) => <span className="num text-fg-muted">{formatBytes(a.byteSize)}</span>,
    },
    {
      id: 'context',
      header: 'Context',
      cell: (a) => (
        <span className="text-[11px] text-fg-muted">
          {[a.market, a.channel, a.assetType].filter(Boolean).join(' · ') || '—'}
        </span>
      ),
    },
    {
      id: 'exemplar',
      header: 'Exemplar',
      align: 'center',
      cell: (a) => (a.isApprovedExemplar ? <Badge tone="ok">Approved</Badge> : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'created',
      header: 'Added',
      align: 'right',
      sortValue: (a) => a.createdAt,
      cell: (a) => <span className="num text-fg-muted">{formatDateTime(a.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (a) => (
        <Button size="xs" variant="outline" onClick={() => runCheck(a)} loading={createCheck.isPending}>
          <ShieldCheck className="size-3" aria-hidden="true" />
          Check
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Assets"
        description="Everything registered for verification. Approved exemplars also seed rule induction and precedent."
        actions={
          <>
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              <Button
                size="icon-sm"
                variant={view === 'grid' ? 'subtle' : 'ghost'}
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <Grid2X2 className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                size="icon-sm"
                variant={view === 'table' ? 'subtle' : 'ghost'}
                aria-label="Table view"
                aria-pressed={view === 'table'}
                onClick={() => setView('table')}
              >
                <List className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="size-3.5" aria-hidden="true" />
              Upload
            </Button>
          </>
        }
      />

      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="Filter by name or content hash"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Filter assets"
          />
          <Select
            className="w-44"
            value={brandId}
            placeholder="All brands"
            onChange={(event) => setBrandId(event.target.value)}
            aria-label="Filter by brand"
            options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            className="w-32"
            value={kind}
            placeholder="All kinds"
            onChange={(event) => setKind(event.target.value)}
            aria-label="Filter by kind"
            options={KINDS.map((k) => ({ value: k, label: k }))}
          />
          <Select
            className="w-36"
            value={status}
            placeholder="All statuses"
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Filter by status"
            options={['queued', 'processing', 'ready', 'failed'].map((s) => ({ value: s, label: s }))}
          />
          <span className="num text-fg-subtle">{data ? `${rows.length} of ${data.total}` : ''}</span>
        </div>

        {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}

        {view === 'table' ? (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            caption="Registered assets"
            loading={isPending}
            pageSize={25}
            dense
            empty={<AssetsEmpty onUpload={() => setUploadOpen(true)} />}
          />
        ) : isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-44 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <AssetsEmpty onUpload={() => setUploadOpen(true)} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            {rows.map((asset) => (
              <li key={asset.id}>
                <Link
                  href={`/assets/${asset.id}`}
                  className="group block overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-accent"
                >
                  <div
                    className={cn(
                      'flex h-28 items-center justify-center bg-surface-2',
                      '[background-image:repeating-conic-gradient(var(--surface-3)_0_25%,transparent_0_50%)] [background-size:12px_12px]',
                    )}
                  >
                    {asset.previewUrl ? (
                      <img src={asset.previewUrl} alt={asset.name} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <ImageOff className="size-5 text-fg-subtle" aria-hidden="true" />
                    )}
                  </div>
                  <div className="border-t border-border p-2.5">
                    <p className="truncate text-xs font-medium text-fg">{asset.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge tone="outline">{asset.kind}</Badge>
                      <Badge tone={STATUS_TONE[asset.status] ?? 'neutral'}>{asset.status}</Badge>
                      {asset.isApprovedExemplar ? <Badge tone="ok">Exemplar</Badge> : null}
                    </div>
                    <p className="num mt-1 text-[10px] text-fg-subtle">
                      {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
                      {formatBytes(asset.byteSize)}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>

      <Dialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload assets"
        description="Files are content-addressed: re-uploading identical bytes reuses the existing asset rather than duplicating it."
        size="lg"
      >
        <div className="space-y-3">
          <Select
            value={brandId}
            placeholder="Select a brand"
            onChange={(event) => setBrandId(event.target.value)}
            aria-label="Brand for uploaded assets"
            options={(brands ?? []).map((b) => ({ value: b.id, label: b.name }))}
          />
          <AssetUploader
            fields={{ brandId, kind: 'image' }}
            accept="image/*,video/*,.pdf,.pptx,.psd"
            disabled={!brandId}
            disabledReason="Choose a brand first — every asset belongs to exactly one."
            onAllComplete={() => {
              void client.invalidateQueries({ queryKey: qk.assets.all });
              toast({ title: 'Upload complete', description: 'Ingestion runs in the background.', tone: 'success' });
            }}
          />
        </div>
      </Dialog>
    </div>
  );
}

function AssetsEmpty({ onUpload }: { onUpload: () => void }) {
  return (
    <EmptyState
      icon={Boxes}
      title="No assets"
      description="Upload creative to verify it, or mark approved work as an exemplar so rule induction and precedent have a corpus to learn from."
      actionLabel="Upload assets"
      onAction={onUpload}
    />
  );
}
