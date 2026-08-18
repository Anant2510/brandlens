'use client';

import * as React from 'react';
import type { FindingDTO } from '@brandlens/contracts';
import { SEVERITY_LABEL, SEVERITY_VAR, normalizeBBox } from '@/lib/domain';
import { cn } from '@/lib/utils';

export interface FindingOverlayProps {
  findings: FindingDTO[];
  selectedId: string | null;
  onSelect: (findingId: string | null) => void;
  /** The rendered image box, in container-relative pixels. */
  box: { left: number; top: number; width: number; height: number } | null;
  className?: string;
}

/**
 * Absolutely-positioned severity boxes drawn from each finding's normalized
 * bbox.
 *
 * The math is relative to the *rendered* image box, not the natural size:
 * object-contain letterboxes an arbitrary aspect ratio inside a fixed frame,
 * and a normalized bbox must land on the pixels the reviewer is looking at.
 */
export function FindingOverlay({ findings, selectedId, onSelect, box, className }: FindingOverlayProps) {
  if (!box || box.width <= 0 || box.height <= 0) return null;

  return (
    <div
      className={cn('pointer-events-none absolute', className)}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {findings.map((finding) => {
        const bbox = normalizeBBox(finding.bbox);
        if (!bbox) return null;
        const [x, y, w, h] = bbox;
        const selected = finding.id === selectedId;
        const color = SEVERITY_VAR[finding.severity];

        return (
          <button
            key={finding.id}
            type="button"
            aria-label={`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`}
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(selected ? null : finding.id);
            }}
            onMouseEnter={() => onSelect(finding.id)}
            className={cn(
              'pointer-events-auto absolute rounded-[3px] transition-[box-shadow,opacity] duration-100',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
              selected ? 'opacity-100' : 'opacity-80 hover:opacity-100',
            )}
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${Math.max(w, 0.004) * 100}%`,
              height: `${Math.max(h, 0.004) * 100}%`,
              border: `${selected ? 2 : 1.5}px solid ${color}`,
              backgroundColor: selected ? `color-mix(in oklab, ${color} 18%, transparent)` : 'transparent',
              boxShadow: selected ? `0 0 0 3px color-mix(in oklab, ${color} 28%, transparent)` : 'none',
              outlineColor: color,
            }}
          >
            <span
              className="pointer-events-none absolute -top-[1.05rem] left-[-1.5px] max-w-[16rem] truncate rounded-t-[3px] px-1 text-[10px] font-medium leading-4 text-white"
              style={{ backgroundColor: color, opacity: selected ? 1 : 0.9 }}
            >
              {finding.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tracks the rendered box of an `object-contain` image inside its container.
 *
 * Measured from untransformed layout offsets, never getBoundingClientRect: the
 * stage carries a CSS zoom transform, and mixing transformed rects with
 * untransformed client sizes puts every box in the wrong place the moment a
 * reviewer zooms in. Because the overlay lives inside the same transformed
 * stage, layout coordinates stay correct at any zoom level.
 */
export function useRenderedImageBox(
  containerRef: React.RefObject<HTMLElement | null>,
  imageRef: React.RefObject<HTMLImageElement | null>,
) {
  const [box, setBox] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const measure = React.useCallback(() => {
    const container = containerRef.current;
    const image = imageRef.current;
    if (!container || !image || !image.naturalWidth || !image.naturalHeight) {
      setBox(null);
      return;
    }

    const cw = image.clientWidth;
    const ch = image.clientHeight;
    if (cw <= 0 || ch <= 0) {
      setBox(null);
      return;
    }

    // object-contain letterboxes: the drawn box is the natural size scaled to
    // fit, then centred in whatever space the element occupies.
    const fit = Math.min(cw / image.naturalWidth, ch / image.naturalHeight);
    const width = image.naturalWidth * fit;
    const height = image.naturalHeight * fit;

    setBox({
      left: image.offsetLeft - container.offsetLeft + (cw - width) / 2,
      top: image.offsetTop - container.offsetTop + (ch - height) / 2,
      width,
      height,
    });
  }, [containerRef, imageRef]);

  React.useEffect(() => {
    measure();
    const observer = new ResizeObserver(() => measure());
    if (containerRef.current) observer.observe(containerRef.current);
    if (imageRef.current) observer.observe(imageRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, containerRef, imageRef]);

  return { box, measure };
}
