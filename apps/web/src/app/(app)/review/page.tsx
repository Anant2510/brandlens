import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { ReviewQueueView } from './review-queue-view';

export const metadata: Metadata = { title: 'Review queue' };

export default function ReviewPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <ReviewQueueView />
    </Suspense>
  );
}
