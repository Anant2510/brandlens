'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { BookMarked, Check, ImageOff, Pencil, Sparkles, X } from 'lucide-react';
import type { Rule } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { SeverityBadge } from '@/components/severity-badge';
import { TierBadge } from '@/components/tier-badge';
import { RuleEditor, type RuleEditorValues } from '@/components/rule-editor';
import { api } from '@/lib/api-client';
import { qk } from '@/hooks/query-keys';
import type { Asset } from '@/lib/types';
import { dimensionLabel } from '@/lib/domain';
import { formatMeasured, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface ProposedRuleCardProps {
  rule: Rule;
  brandId: string;
  selected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSave: (values: RuleEditorValues) => void | Promise<void>;
  pending?: boolean;
  saving?: boolean;
  documentName?: string;
}

export function ProposedRuleCard({
  rule,
  brandId,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onSave,
  pending = false,
  saving = false,
  documentName,
}: ProposedRuleCardProps) {
  const [editing, setEditing] = React.useState(false);
  const checkboxId = React.useId();
  const isInduced = rule.provenance === 'inductive';

  return (
    <article
      className={cn(
        'rounded-lg border bg-surface transition-colors',
        selected ? 'border-accent shadow-[0_0_0_1px_var(--accent)]' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex gap-3 p-3">
        <input
          id={checkboxId}
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-1 size-3.5 shrink-0 cursor-pointer accent-[var(--accent)]"
          aria-label={`Select rule ${rule.key}`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={rule.severity} />
            <Badge tone="outline">{dimensionLabel(rule.dimension)}</Badge>
            <TierBadge tier={rule.tier} />
            <span className="num text-fg-subtle">{rule.key}</span>
          </div>

          <p className="mt-1.5 text-[13px] font-medium leading-5 text-fg">{rule.statement}</p>
          {rule.rationale ? <p className="mt-0.5 text-xs leading-5 text-fg-muted">{rule.rationale}</p> : null}

          {isInduced ? (
            <InducedEvidence rule={rule} brandId={brandId} />
          ) : (
            <DeductiveEvidence rule={rule} brandId={brandId} documentName={documentName} />
          )}

          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            <div className="flex items-center gap-1">
              <dt className="text-fg-subtle">analyzer</dt>
              <dd className="num text-fg">{rule.check?.fn}</dd>
            </div>
            {Object.entries(rule.check?.params ?? {}).slice(0, 4).map(([key, value]) => (
              <div key={key} className="flex items-center gap-1">
                <dt className="text-fg-subtle">{key}</dt>
                <dd className="num text-fg">{formatMeasured(value)}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" loading={pending} onClick={onApprove}>
              <Check className="size-3.5" aria-hidden="true" />
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              <Pencil className="size-3.5" aria-hidden="true" />
              {editing ? 'Close editor' : 'Edit'}
            </Button>
            <Button size="sm" variant="ghost" loading={pending} onClick={onReject}>
              <X className="size-3.5" aria-hidden="true" />
              Reject
            </Button>
          </div>
        </div>
      </div>

      {editing ? (
        <div className="border-t border-border p-3">
          <RuleEditor
            rule={rule}
            saving={saving}
            onCancel={() => setEditing(false)}
            onSave={async (values) => {
              await onSave(values);
              setEditing(false);
            }}
          />
        </div>
      ) : null}
    </article>
  );
}

/* --------------------------------------------------------------------------
 * "From your brand book" — page citation plus a crop of the cited region.
 * ------------------------------------------------------------------------ */
function DeductiveEvidence({ rule, brandId, documentName }: { rule: Rule; brandId: string; documentName?: string }) {
  const citation = rule.citation;
  if (!citation) {
    return (
      <p className="mt-2 text-[11px] text-fg-subtle">
        {rule.provenance === 'transfer'
          ? 'Imported from an external standard.'
          : 'Hand-authored — no document citation.'}
      </p>
    );
  }

  return (
    <div className="mt-2 flex gap-2.5 rounded-md border border-border bg-surface-2 p-2">
      <PageCropThumbnail brandId={brandId} citation={citation} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[11px] font-medium text-fg-muted">
          <BookMarked className="size-3" aria-hidden="true" />
          From your brand book
        </p>
        <p className="mt-0.5 text-xs text-fg">
          {citation.doc ?? documentName ?? 'Brand guidelines'}
          {citation.page !== undefined ? <span className="text-fg-muted"> · p.{citation.page}</span> : null}
        </p>
        {citation.extractedBy ? (
          <p className="mt-0.5 num text-[11px] text-fg-subtle">extracted by {citation.extractedBy}</p>
        ) : null}
        {citation.documentId ? (
          <Link
            href={`/brands/${brandId}/documents?doc=${citation.documentId}`}
            className="mt-0.5 inline-block text-[11px] text-accent hover:underline"
          >
            Open the source document
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The page crop.
 *
 * The API exposes no page-raster endpoint yet, so this renders the citation
 * coordinates rather than fabricating an image — an honest placeholder beats a
 * broken <img> on the screen that closes the deal.
 */
function PageCropThumbnail({ brandId: _brandId, citation }: { brandId: string; citation: NonNullable<Rule['citation']> }) {
  const bbox = citation.bbox;
  return (
    <div className="relative size-16 shrink-0 overflow-hidden rounded border border-border bg-surface">
      <div className="absolute inset-1 rounded-[2px] border border-dashed border-border-strong" aria-hidden="true" />
      {bbox ? (
        <span
          aria-hidden="true"
          className="absolute rounded-[1px] border border-accent bg-accent/20"
          style={{
            left: `${Math.max(0, Math.min(1, bbox[0])) * 100}%`,
            top: `${Math.max(0, Math.min(1, bbox[1])) * 100}%`,
            width: `${Math.max(0.04, Math.min(1, bbox[2])) * 100}%`,
            height: `${Math.max(0.04, Math.min(1, bbox[3])) * 100}%`,
          }}
        />
      ) : (
        <ImageOff className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
      )}
      {citation.page !== undefined ? (
        <span className="absolute bottom-0 right-0 rounded-tl bg-surface-3 px-1 font-mono text-[9px] text-fg-muted">
          p{citation.page}
        </span>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * "Learned from your approved assets" — the insight, then the evidence.
 * ------------------------------------------------------------------------ */
function InducedEvidence({ rule, brandId: _brandId }: { rule: Rule; brandId: string }) {
  const support = rule.support;
  const exampleIds = React.useMemo(() => (support?.exampleAssetIds ?? []).slice(0, 5), [support?.exampleAssetIds]);

  const results = useQueries({
    queries: exampleIds.map((id) => ({
      queryKey: qk.assets.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<Asset>(`/v1/assets/${id}`, undefined, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  const written = writtenValue(rule);

  return (
    <div className="mt-2 rounded-md border border-accent/30 bg-accent-soft/40 p-2">
      <p className="flex items-center gap-1 text-[11px] font-medium text-accent-soft-fg">
        <Sparkles className="size-3" aria-hidden="true" />
        Learned from your approved assets
      </p>

      {/* The line that lands the pitch. */}
      <p className="mt-1 text-xs leading-5 text-fg">
        {written !== null ? (
          <>
            Your guidelines say <span className="num font-semibold">{formatMeasured(written)}</span>.{' '}
          </>
        ) : null}
        Your team has enforced{' '}
        <span className="num font-semibold">
          ≥{formatMeasured(support?.observedValue)}
        </span>{' '}
        in{' '}
        <span className="num font-semibold">{formatPercent(percentileAsRate(support?.percentile), 0)}</span> of{' '}
        <span className="num font-semibold">{support?.sampleSize ?? 0}</span> approved assets.
      </p>

      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <Support label="support" value={`n=${support?.sampleSize ?? 0}`} />
        <Support label="percentile" value={formatMeasured(support?.percentile)} />
        <Support label="observed" value={formatMeasured(support?.observedValue)} />
      </dl>

      {exampleIds.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {results.map((result, index) => {
            const id = exampleIds[index];
            if (result.isPending) return <Skeleton key={id} className="size-12 rounded" />;
            const asset = result.data;
            return (
              <li key={id}>
                <Tooltip content={asset?.name ?? id}>
                  <Link
                    href={`/assets/${id}`}
                    className="block size-12 overflow-hidden rounded border border-border bg-surface"
                  >
                    {asset?.previewUrl ? (
                      <img src={asset.previewUrl} alt={asset.name} className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center">
                        <ImageOff className="size-3 text-fg-subtle" aria-hidden="true" />
                      </span>
                    )}
                  </Link>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Support({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="num text-fg">{value}</dd>
    </div>
  );
}

/** The written-down value the induced rule contradicts, when the params carry it. */
function writtenValue(rule: Rule): number | string | null {
  const params = rule.check?.params ?? {};
  for (const key of ['documentedValue', 'guidelineValue', 'writtenValue', 'multiple', 'ratio', 'minimum']) {
    const value = params[key];
    if (typeof value === 'number' || typeof value === 'string') return value;
  }
  return null;
}

/** Support percentiles arrive as either 0..1 or 0..100 depending on analyzer. */
function percentileAsRate(percentile: number | undefined): number {
  if (percentile === undefined || Number.isNaN(percentile)) return 0;
  return percentile > 1 ? percentile / 100 : percentile;
}
