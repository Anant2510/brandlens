import type { Metadata } from 'next';
import { DocumentsView } from './documents-view';

export const metadata: Metadata = { title: 'Brand documents' };

export default async function DocumentsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <DocumentsView brandId={brandId} />;
}
