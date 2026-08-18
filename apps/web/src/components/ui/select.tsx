'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fieldClasses } from './input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
  invalid?: boolean;
}

/**
 * A native <select> behind a styled shell. Native is deliberate: it is
 * keyboard- and screen-reader-correct on every platform without 400 lines of
 * listbox ARIA, and this is a compliance product.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, invalid, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={fieldClasses(cn('h-8 appearance-none pr-7 cursor-pointer', className), invalid)}
        aria-invalid={invalid || undefined}
        {...props}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle"
        aria-hidden="true"
      />
    </div>
  );
});
