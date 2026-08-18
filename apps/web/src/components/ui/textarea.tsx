'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldClasses } from './input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, mono, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={fieldClasses(cn('resize-y leading-5', mono && 'font-mono text-xs', className), invalid)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});
