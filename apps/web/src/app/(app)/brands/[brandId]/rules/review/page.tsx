import type { Metadata } from 'next';
import { RuleReviewBoard } from './rule-review-board';

export const metadata: Metadata = { title: 'Confirm proposed rules' };

export default async function RuleReviewPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  return <RuleReviewBoard brandId={brandId} />;
}
