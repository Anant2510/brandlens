import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetsView } from './assets-view';

export const metadata: Metadata = { title: 'Assets' };

export default function AssetsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <AssetsView />
    </Suspense>
  );
}
