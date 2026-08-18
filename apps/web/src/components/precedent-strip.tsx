'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { History, ImageOff } from 'lucide-react';
import { api } from '@/lib/api-client';
import { qk } from '@/hooks/query-keys';
import type { Asset } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Assets previously decided the same way for this rule.
 *
 * Precedent is what turns "the model says so" into "your team has said so
 * before" — it is the single most persuasive thing on a finding.
 */
export function PrecedentStrip({
  assetIds,
  label = 'Precedent — decided the same way',
  max = 6,
  className,
}: {
  assetIds: string[] | null | undefined;
  label?: string;
  max?: number;
  className?: string;
}) {
  const ids = React.useMemo(() => (assetIds ?? []).slice(0, max), [assetIds, max]);

  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.assets.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<Asset>(`/v1/assets/${id}`, undefined, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  if (ids.length === 0) {
    return (
      <p className={cn('text-[11px] text-fg-subtle', className)}>
        No precedent yet — this is the first time this rule has been decided on a comparable asset.
      </p>
    );
  }

  return (
    <div className={className}>
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-fg-muted">
        <History className="size-3" aria-hidden="true" />
        {label}
        <span className="text-fg-subtle">({ids.length})</span>
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {results.map((result, index) => {
          const id = ids[index];
          if (result.isPending) return <Skeleton key={id} className="size-14 rounded-md" />;
          const asset = result.data;
          return (
            <li key={id}>
              <Link
                href={`/assets/${id}`}
                title={asset?.name ?? id}
                className="group block size-14 overflow-hidden rounded-md border border-border bg-surface-2 transition-colors hover:border-accent"
              >
                {asset?.previewUrl ? (
                  <img
                    src={asset.previewUrl}
                    alt={asset.name}
                    className="size-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <span className="flex size-full items-center justify-center">
                    <ImageOff className="size-3.5 text-fg-subtle" aria-hidden="true" />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
