import type { Metadata } from 'next';
import { AssembleView } from './assemble-view';

export const metadata: Metadata = { title: 'Assemble' };

export default function AssemblePage() {
  return <AssembleView />;
}
