import type { Metadata } from 'next';
import { CheckRunViewer } from './check-run-viewer';

export const metadata: Metadata = { title: 'Decision trace' };

export default async function CheckRunPage({ params }: { params: Promise<{ checkRunId: string }> }) {
  const { checkRunId } = await params;
  return <CheckRunViewer checkRunId={checkRunId} />;
}
