import type { Metadata } from 'next';
import { ModelsView } from './models-view';

export const metadata: Metadata = { title: 'Models' };

export default function ModelsPage() {
  return <ModelsView />;
}
