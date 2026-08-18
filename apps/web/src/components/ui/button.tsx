'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { buttonClasses, type ButtonSize, type ButtonVariant } from './button-variants';

export type { ButtonSize, ButtonVariant };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading = false, disabled, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
