import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-fg">Sign in</h1>
      <p className="mt-1 text-xs text-fg-muted">Use your BrandLens organization account.</p>
      <Suspense fallback={<Skeleton className="mt-6 h-40 w-full" />}>
        <LoginForm />
      </Suspense>
      <p className="mt-6 text-xs text-fg-muted">
        No organization yet?{' '}
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create one
        </Link>
      </p>
    </>
  );
}
