import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { OntologyView } from './ontology-view';

export const metadata: Metadata = { title: 'Brand ontology' };

export default async function OntologyPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <OntologyView brandId={brandId} />
    </Suspense>
  );
}
