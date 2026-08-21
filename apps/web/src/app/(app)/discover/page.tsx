import type { Metadata } from 'next';
import { DiscoverView } from './discover-view';

export const metadata: Metadata = { title: 'Discover' };

export default function DiscoverPage() {
  return <DiscoverView />;
}
