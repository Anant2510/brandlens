'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useBrandsQuery } from '@/hooks/use-brands';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Switching brands keeps the reviewer on the same sub-page whenever the route
 * is brand-scoped, because "look at the same screen for the other brand" is
 * the actual intent behind a brand switch.
 */
export function BrandSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: brands, isPending, isError } = useBrandsQuery();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const match = pathname.match(/^\/brands\/([0-9a-fA-F-]{36})(\/.*)?$/);
  const activeBrandId = match?.[1];
  const subPath = match?.[2] ?? '';
  const active = brands?.find((b) => b.id === activeBrandId);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = active?.name ?? (activeBrandId ? 'Brand' : 'All brands');

  if (collapsed) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Brand: ${label}`}
        onClick={() => router.push('/brands')}
        className="mx-auto"
      >
        <span className="grid size-5 place-items-center rounded bg-accent-soft text-[10px] font-semibold text-accent-soft-fg">
          {(active?.name ?? 'BL').slice(0, 2).toUpperCase()}
        </span>
      </Button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-left',
          'hover:bg-surface-2 transition-colors',
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded bg-accent-soft text-[10px] font-semibold text-accent-soft-fg">
          {(active?.name ?? 'BL').slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg">{label}</span>
          <span className="block truncate text-[10px] text-fg-subtle">
            {isError ? 'Brands unavailable' : isPending ? 'Loading…' : `${brands?.length ?? 0} brand(s)`}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Select a brand"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto scroll-thin rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {isError ? <p className="px-2 py-3 text-xs text-fg-muted">Could not load brands.</p> : null}
          {brands?.length === 0 ? <p className="px-2 py-3 text-xs text-fg-muted">No brands yet.</p> : null}
          {brands?.map((brand) => (
            <button
              key={brand.id}
              type="button"
              role="option"
              aria-selected={brand.id === activeBrandId}
              onClick={() => {
                setOpen(false);
                router.push(`/brands/${brand.id}${subPath}`);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                brand.id === activeBrandId ? 'bg-accent-soft text-accent-soft-fg' : 'text-fg hover:bg-surface-2',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{brand.name}</span>
              {brand.id === activeBrandId ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/brands');
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Manage brands
          </button>
        </div>
      ) : null}
    </div>
  );
}
