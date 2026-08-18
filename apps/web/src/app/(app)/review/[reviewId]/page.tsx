import type { Metadata } from 'next';
import { ReviewDetailView } from './review-detail-view';

export const metadata: Metadata = { title: 'Review' };

export default async function ReviewDetailPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return <ReviewDetailView reviewId={reviewId} />;
}
