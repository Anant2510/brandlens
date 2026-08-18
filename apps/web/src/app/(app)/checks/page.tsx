import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { ChecksView } from './checks-view';

export const metadata: Metadata = { title: 'Checks' };

export default function ChecksPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <ChecksView />
    </Suspense>
  );
}
