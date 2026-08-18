import type { Metadata } from 'next';
import { OrganizationSettingsView } from './organization-view';

export const metadata: Metadata = { title: 'Organization settings' };

export default function OrganizationSettingsPage() {
  return <OrganizationSettingsView />;
}
