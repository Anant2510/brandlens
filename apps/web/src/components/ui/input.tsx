'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export const fieldClasses = (className?: string, invalid?: boolean) =>
  cn(
    'w-full rounded-md border bg-surface px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle',
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
    invalid ? 'border-[var(--danger)]' : 'border-border hover:border-border-strong',
    className,
  );

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, mono, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={fieldClasses(cn('h-8', mono && 'font-mono tabular', className), invalid)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export function Label({ className, children, required, ...props }: LabelProps) {
  return (
    <label className={cn('block text-xs font-medium text-fg-muted mb-1', className)} {...props}>
      {children}
      {required ? (
        <span className="text-[var(--danger)] ml-0.5" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1 text-[11px] text-[var(--danger)]">
      {children}
    </p>
  );
}

export function FieldHint({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-[11px] text-fg-subtle">{children}</p>;
}

/** Label + control + error, wired to a single id. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      <FieldError>{error}</FieldError>
      {!error ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
