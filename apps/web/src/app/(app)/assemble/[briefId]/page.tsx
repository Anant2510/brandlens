import type { Metadata } from 'next';
import { BriefDetailView } from './brief-detail-view';

export const metadata: Metadata = { title: 'Brief' };

export default async function BriefPage({ params }: { params: Promise<{ briefId: string }> }) {
  const { briefId } = await params;
  return <BriefDetailView briefId={briefId} />;
}
