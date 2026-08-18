import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonClasses } from '@/components/ui/button-variants';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 rounded-full bg-surface-2 p-3">
        <FileQuestion className="size-5 text-fg-subtle" aria-hidden="true" />
      </div>
      <h1 className="text-base font-semibold text-fg">Page not found</h1>
      <p className="mt-1 max-w-sm text-xs text-fg-muted">
        This route does not exist in the BrandLens console.
      </p>
      <Link href="/dashboard" className={buttonClasses('primary', 'sm', 'mt-4')}>
        Back to dashboard
      </Link>
    </div>
  );
}
