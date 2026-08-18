import type { Metadata } from 'next';
import { BrandsView } from './brands-view';

export const metadata: Metadata = { title: 'Brands' };

export default function BrandsPage() {
  return <BrandsView />;
}
