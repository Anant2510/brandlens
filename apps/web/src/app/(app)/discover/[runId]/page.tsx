import type { Metadata } from 'next';
import { DiscoveryReportView } from './report-view';

export const metadata: Metadata = { title: 'Discovery report' };

export default async function DiscoveryReportPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <DiscoveryReportView runId={runId} />;
}
