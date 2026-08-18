import type { Metadata } from 'next';
import { RulesetsView } from './rulesets-view';

export const metadata: Metadata = { title: 'Rulesets' };

export default async function RulesetsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <RulesetsView brandId={brandId} />;
}
