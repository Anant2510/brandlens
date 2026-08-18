'use client';

import * as React from 'react';
import { ImageOff } from 'lucide-react';
import type { Severity } from '@brandlens/contracts';
import { SEVERITY_VAR, normalizeBBox } from '@/lib/domain';
import { cn } from '@/lib/utils';

export interface EvidenceCropProps {
  /** Full asset preview URL; the crop is produced by transform, not a fetch. */
  src: string | null | undefined;
  bbox: number[] | null | undefined;
  severity?: Severity;
  /** Extra context around the box, as a fraction of the box size. */
  padding?: number;
  height?: number;
  className?: string;
  alt?: string;
}

/**
 * The evidence crop: the pixels the verdict is actually about.
 *
 * Rendered by scaling and translating the full preview inside a clipping frame
 * rather than requesting a server-side crop — it is exact, needs no extra
 * round trip, and stays correct if the bbox is edited.
 */
export function EvidenceCrop({
  src,
  bbox,
  severity = 'major',
  padding = 0.45,
  height = 132,
  className,
  alt = 'Evidence crop',
}: EvidenceCropProps) {
  const [failed, setFailed] = React.useState(false);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = React.useState(0);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);

  React.useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setFrameWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setFrameWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const normalized = normalizeBBox(bbox);

  if (!src || failed) {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface-2 text-[11px] text-fg-subtle',
          className,
        )}
        style={{ height }}
      >
        <ImageOff className="size-3.5" aria-hidden="true" />
        {src ? 'Preview unavailable' : 'No renderable evidence'}
      </div>
    );
  }

  // Expand the box a little so the reviewer sees the surrounding context.
  const region = normalized
    ? (() => {
        const [x, y, w, h] = normalized;
        const padX = w * padding;
        const padY = h * padding;
        const left = Math.max(0, x - padX);
        const top = Math.max(0, y - padY);
        const right = Math.min(1, x + w + padX);
        const bottom = Math.min(1, y + h + padY);
        return { left, top, width: Math.max(right - left, 0.02), height: Math.max(bottom - top, 0.02) };
      })()
    : { left: 0, top: 0, width: 1, height: 1 };

  // Scale so the whole padded region fits inside the frame. Contain, not
  // cover: a crop that clips the very box it is evidence for is worse than a
  // slightly smaller one.
  const regionAspect = natural ? (natural.w * region.width) / (natural.h * region.height) : 1;
  const frameAspect = frameWidth > 0 ? frameWidth / height : 1;
  const scale =
    frameWidth > 0 && natural
      ? regionAspect > frameAspect
        ? frameWidth / (natural.w * region.width)
        : height / (natural.h * region.height)
      : 1;

  const imageWidth = natural ? natural.w * scale : 0;
  const imageHeight = natural ? natural.h * scale : 0;
  const offsetX = frameWidth / 2 - (region.left + region.width / 2) * imageWidth;
  const offsetY = height / 2 - (region.top + region.height / 2) * imageHeight;

  return (
    <div
      ref={frameRef}
      className={cn('relative overflow-hidden rounded-md border border-border bg-surface-2', className)}
      style={{ height }}
    >
      <img
        src={src}
        alt={alt}
        onLoad={(event) => {
          const target = event.currentTarget;
          setNatural({ w: target.naturalWidth, h: target.naturalHeight });
        }}
        onError={() => setFailed(true)}
        className="absolute max-w-none select-none"
        style={
          natural
            ? { width: imageWidth, height: imageHeight, left: offsetX, top: offsetY }
            : { width: '100%', height: '100%', objectFit: 'contain', left: 0, top: 0 }
        }
        draggable={false}
      />
      {normalized && natural ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[2px]"
          style={{
            left: offsetX + normalized[0] * imageWidth,
            top: offsetY + normalized[1] * imageHeight,
            width: Math.max(normalized[2] * imageWidth, 3),
            height: Math.max(normalized[3] * imageHeight, 3),
            border: `1.5px solid ${SEVERITY_VAR[severity]}`,
            boxShadow: `0 0 0 9999px color-mix(in oklab, var(--surface) 55%, transparent)`,
          }}
        />
      ) : null}
    </div>
  );
}
