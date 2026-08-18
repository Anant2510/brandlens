import type { Metadata } from 'next';
import { BrandOverviewView } from './brand-overview-view';

export const metadata: Metadata = { title: 'Brand overview' };

export default async function BrandPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <BrandOverviewView brandId={brandId} />;
}
