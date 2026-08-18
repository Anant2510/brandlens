'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  value: string;
  label: React.ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  /** The id of the panel the tablist controls, for aria-controls. */
  panelId?: string;
  size?: 'sm' | 'md';
}

/**
 * WAI-ARIA tabs with roving tabindex: Arrow keys move, Home/End jump, and only
 * the active tab is in the tab order.
 */
export function Tabs({ items, value, onValueChange, className, panelId, size = 'md' }: TabsProps) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    const enabled = items.map((item, i) => ({ item, i })).filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const position = enabled.findIndex(({ i }) => i === from);
    const next = enabled[(position + delta + enabled.length) % enabled.length];
    onValueChange(next.item.value);
    refs.current[next.i]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        move(0, -1);
        break;
      default:
        break;
    }
  };

  return (
    <div role="tablist" className={cn('flex items-center gap-1 border-b border-border overflow-x-auto scroll-thin', className)}>
      {items.map((item, index) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            role="tab"
            type="button"
            id={`tab-${item.value}`}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 font-medium transition-colors disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-[13px]',
              active
                ? 'border-accent text-fg'
                : 'border-transparent text-fg-muted hover:text-fg hover:border-border-strong',
            )}
          >
            {item.label}
            {typeof item.count === 'number' ? (
              <span
                className={cn(
                  'rounded px-1 text-[10px] tabular leading-4',
                  active ? 'bg-accent-soft text-accent-soft-fg' : 'bg-surface-3 text-fg-subtle',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  value,
  children,
  className,
}: {
  id?: string;
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div id={id} role="tabpanel" aria-labelledby={`tab-${value}`} tabIndex={0} className={cn('outline-none', className)}>
      {children}
    </div>
  );
}
