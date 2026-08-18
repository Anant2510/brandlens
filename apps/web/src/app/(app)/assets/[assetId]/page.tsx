import type { Metadata } from 'next';
import { AssetDetailView } from './asset-detail-view';

export const metadata: Metadata = { title: 'Asset' };

export default async function AssetPage({ params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  return <AssetDetailView assetId={assetId} />;
}
