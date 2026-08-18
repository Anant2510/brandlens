import type { Metadata } from 'next';
import { RulesTableView } from './rules-table-view';

export const metadata: Metadata = { title: 'Rules' };

export default async function RulesPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <RulesTableView brandId={brandId} />;
}
