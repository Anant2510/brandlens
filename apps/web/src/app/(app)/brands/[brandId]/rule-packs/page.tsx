import type { Metadata } from 'next';
import { RulePacksView } from './rule-packs-view';

export const metadata: Metadata = { title: 'Standards' };

export default async function RulePacksPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <RulePacksView brandId={brandId} />;
}
