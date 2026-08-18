'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from '@/providers/theme-provider';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn('inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5', compact && 'flex-col')}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} theme`}
            onClick={() => setTheme(value)}
            className={cn(
              'grid size-6 place-items-center rounded transition-colors',
              active ? 'bg-accent-soft text-accent-soft-fg' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
