'use client';

import * as React from 'react';
import { FileText, ImageOff, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import type { CheckRunDetail, FindingDTO } from '@brandlens/contracts';
import { Button } from '@/components/ui/button';
import { FindingOverlay, useRenderedImageBox } from '@/components/finding-overlay';
import { cn } from '@/lib/utils';

/**
 * The asset preview with finding overlays.
 *
 * object-contain plus overlay math against the *rendered* box means an 8:1
 * banner and a 4:5 social post both land their boxes correctly without any
 * per-asset configuration.
 */
export function AssetCanvas({
  asset,
  findings,
  selectedId,
  onSelect,
  showAdvisories,
  onToggleAdvisories,
  advisoryCount,
}: {
  asset: CheckRunDetail['asset'];
  findings: FindingDTO[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showAdvisories: boolean;
  onToggleAdvisories: (value: boolean) => void;
  advisoryCount: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const { box, measure } = useRenderedImageBox(containerRef, imageRef);
  const [zoom, setZoom] = React.useState(1);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    measure();
  }, [zoom, measure]);

  const withBoxes = findings.filter((f) => Array.isArray(f.bbox) && f.bbox.length >= 4);
  const previewUrl = asset?.previewUrl ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[13px] font-medium text-fg">{asset?.name ?? 'Asset preview'}</h2>
          {asset?.width && asset.height ? (
            <span className="num shrink-0 text-fg-subtle">
              {asset.width}×{asset.height}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-fg-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--accent)]"
              checked={showAdvisories}
              onChange={(event) => onToggleAdvisories(event.target.checked)}
            />
            Show advisories
            {advisoryCount > 0 ? <span className="num text-fg-subtle">({advisoryCount})</span> : null}
          </label>

          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              disabled={zoom <= 1}
              onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </Button>
            <span className="num w-10 text-center text-fg-muted">{Math.round(zoom * 100)}%</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              disabled={zoom >= 4}
              onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Reset zoom" onClick={() => setZoom(1)}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </Button>
            {previewUrl ? (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open full size in a new tab"
                className="grid size-7 place-items-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <Maximize2 className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className={cn(
          'relative min-h-0 flex-1 overflow-auto scroll-thin bg-surface-2 p-4',
          '[background-image:repeating-conic-gradient(var(--surface-3)_0_25%,transparent_0_50%)] [background-size:16px_16px]',
        )}
        onClick={() => onSelect(null)}
      >
        {previewUrl && !failed ? (
          // The stage carries the zoom transform so the image and its overlays
          // scale together; overlay math stays in untransformed layout space.
          <div
            ref={containerRef}
            className="relative h-full w-full"
            style={{ minHeight: 240, transform: `scale(${zoom})`, transformOrigin: 'center center' }}
          >
            <img
              ref={imageRef}
              src={previewUrl}
              alt={asset?.name ?? 'Asset preview'}
              onLoad={measure}
              onError={() => setFailed(true)}
              className="block h-full w-full object-contain"
              style={{ minHeight: 240 }}
              draggable={false}
            />
            <FindingOverlay findings={withBoxes} selectedId={selectedId} onSelect={onSelect} box={box} />
          </div>
        ) : (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-center">
            {asset?.kind === 'copy' ? (
              <>
                <FileText className="size-5 text-fg-subtle" aria-hidden="true" />
                <p className="text-xs text-fg-muted">Copy-only submission — there are no pixels to render.</p>
                <p className="text-[11px] text-fg-subtle">Findings below reference the submitted copy fields.</p>
              </>
            ) : (
              <>
                <ImageOff className="size-5 text-fg-subtle" aria-hidden="true" />
                <p className="text-xs text-fg-muted">
                  {failed ? 'The preview could not be loaded.' : 'This asset has no renderable preview.'}
                </p>
                <p className="text-[11px] text-fg-subtle">
                  Signed preview URLs expire; reload the page to mint a fresh one.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {withBoxes.length > 0 ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-fg-subtle">
          {withBoxes.length} of {findings.length} finding(s) have a bounding box. Click a box to select the finding.
        </p>
      ) : null}
    </div>
  );
}
