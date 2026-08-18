'use client';

import * as React from 'react';
import Link from 'next/link';
import { FileText, Sparkles, Wand2 } from 'lucide-react';
import type { BrandDocument } from '@/lib/types';
import { PageBody, PageHeader } from '@/components/app-shell';
import { BrandNav } from '@/components/brand-nav';
import { Button } from '@/components/ui/button';
import { buttonClasses } from '@/components/ui/button-variants';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { DataTable, type Column } from '@/components/data-table';
import { AssetUploader } from '@/components/asset-uploader';
import { useBrandQuery } from '@/hooks/use-brands';
import { useDocumentsQuery, useExtractDocumentMutation, useInduceRulesMutation } from '@/hooks/use-ontology';
import { useRulesQuery } from '@/hooks/use-rules';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/hooks/query-keys';
import { errorMessage } from '@/lib/api-client';
import { formatDateTime, formatMeasured } from '@/lib/format';

const STATUS_TONE: Record<string, 'ok' | 'accent' | 'major' | 'blocker' | 'neutral'> = {
  ready: 'ok',
  parsed: 'ok',
  extracted: 'ok',
  queued: 'accent',
  processing: 'accent',
  parsing: 'accent',
  failed: 'blocker',
  pending: 'neutral',
};

export function DocumentsView({ brandId }: { brandId: string }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const { data: brand } = useBrandQuery(brandId);
  const { data, isPending, isError, error, refetch } = useDocumentsQuery(brandId);
  const { data: rules } = useRulesQuery(brandId, { status: 'proposed' });
  const extract = useExtractDocumentMutation(brandId);
  const induce = useInduceRulesMutation(brandId);

  const proposedCount = rules?.length ?? 0;

  const columns: Array<Column<BrandDocument>> = [
    {
      id: 'name',
      header: 'Document',
      sortValue: (d) => d.name,
      cell: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{d.name}</p>
          <p className="num text-fg-subtle">
            {d.kind} · {d.mimeType ?? 'unknown type'}
          </p>
        </div>
      ),
    },
    {
      id: 'pages',
      header: 'Pages',
      align: 'right',
      sortValue: (d) => d.pageCount ?? 0,
      cell: (d) => <span className="num text-fg-muted">{formatMeasured(d.pageCount)}</span>,
    },
    {
      id: 'status',
      header: 'Extraction',
      sortValue: (d) => d.status,
      cell: (d) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status}</Badge>
          {d.error ? <span className="text-[11px] text-blocker-fg">{d.error}</span> : null}
        </div>
      ),
    },
    {
      id: 'stats',
      header: 'Extracted',
      cell: (d) => {
        const stats = d.extractionStats ?? {};
        const entries = Object.entries(stats).slice(0, 3);
        if (entries.length === 0) return <span className="text-fg-subtle">—</span>;
        return (
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-center gap-1">
                <dt className="text-fg-subtle">{key}</dt>
                <dd className="num text-fg">{formatMeasured(value)}</dd>
              </div>
            ))}
          </dl>
        );
      },
    },
    {
      id: 'created',
      header: 'Uploaded',
      align: 'right',
      sortValue: (d) => d.createdAt,
      cell: (d) => <span className="num text-fg-muted">{formatDateTime(d.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      srOnlyHeader: true,
      cell: (d) => (
        <Button
          size="xs"
          variant="outline"
          loading={extract.isPending}
          onClick={() =>
            extract.mutate(d.id, {
              onSuccess: () =>
                toast({
                  title: 'Extraction queued',
                  description: 'Rules arrive as proposals — nothing is ever auto-activated.',
                  tone: 'info',
                }),
              onError: (mutationError) =>
                toast({ title: 'Extraction failed', description: errorMessage(mutationError), tone: 'error' }),
            })
          }
        >
          <Wand2 className="size-3" aria-hidden="true" />
          Extract rules
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Brands', href: '/brands' },
          { label: brand?.name ?? 'Brand', href: `/brands/${brandId}` },
          { label: 'Documents' },
        ]}
        title="Brand documents"
        description="Upload the brand book. Extraction is asynchronous and always produces proposed rules with a page citation."
        actions={
          proposedCount > 0 ? (
            <Link href={`/brands/${brandId}/rules/review`} className={buttonClasses('primary', 'sm')}>
              Confirm {proposedCount} proposal{proposedCount === 1 ? '' : 's'}
            </Link>
          ) : null
        }
      />
      <BrandNav brandId={brandId} />

      <PageBody className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-3">
            <DataTable
              columns={columns}
              rows={data ?? []}
              rowKey={(d) => d.id}
              caption="Uploaded brand documents"
              loading={isPending}
              error={isError ? errorMessage(error) : null}
              onRetry={() => void refetch()}
              pageSize={20}
              empty={
                <EmptyState
                  icon={FileText}
                  title="No documents uploaded"
                  description="A brand book is the fastest path to a working ruleset: extraction proposes rules with the page they came from, so every verdict can cite a source."
                />
              }
            />
          </div>

          <div className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Upload a guideline document</CardTitle>
              </CardHeader>
              <CardContent>
                <AssetUploader
                  endpoint={`/v1/brands/${brandId}/documents`}
                  fields={{ kind: 'brand_book' }}
                  accept=".pdf,.docx,.pptx,.md,.txt"
                  label="Drop the brand book"
                  description="PDF, DOCX, PPTX, Markdown or plain text. Up to 25 MB per file."
                  onAllComplete={() => {
                    void client.invalidateQueries({ queryKey: qk.ontology.resource(brandId, 'documents') });
                    toast({
                      title: 'Upload complete',
                      description: 'Run extraction to propose rules from the document.',
                      tone: 'success',
                    });
                  }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Or learn from approved assets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs leading-5 text-fg-muted">
                  Induction measures the approved corpus to find the rules your team actually enforces, as opposed to the
                  ones they wrote down. Output is always proposed.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={induce.isPending}
                  onClick={() =>
                    induce.mutate(
                      {},
                      {
                        onSuccess: () => toast({ title: 'Induction queued', tone: 'info' }),
                        onError: (mutationError) =>
                          toast({ title: 'Induction failed', description: errorMessage(mutationError), tone: 'error' }),
                      },
                    )
                  }
                >
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  Induce rules from assets
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
