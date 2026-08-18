import { cn } from '@/lib/utils';

/**
 * Button styling, isolated from the client component so a server component
 * (or a `<Link>` that only needs to look like a button) can use it without
 * pulling React state across the boundary.
 */
const VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent shadow-xs',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border-border',
  outline: 'bg-transparent text-fg hover:bg-surface-2 border-border',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg border-transparent',
  danger: 'bg-[var(--danger)] text-white hover:opacity-90 border-transparent',
  subtle: 'bg-accent-soft text-accent-soft-fg hover:brightness-95 border-transparent',
} as const;

const SIZES = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-sm',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-md',
  icon: 'h-8 w-8 p-0 rounded-md',
  'icon-sm': 'h-7 w-7 p-0 rounded-md',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export function buttonClasses(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(
    'inline-flex items-center justify-center border font-medium whitespace-nowrap select-none',
    'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
