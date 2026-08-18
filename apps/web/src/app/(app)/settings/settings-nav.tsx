'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/settings/organization', label: 'Organization' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/api-keys', label: 'API keys' },
  { href: '/settings/webhooks', label: 'Webhooks' },
  { href: '/settings/models', label: 'Models' },
  { href: '/settings/audit-log', label: 'Audit log' },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="border-b border-border bg-surface px-4">
      <ul className="flex flex-wrap items-center gap-1">
        {ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-block border-b-2 px-2.5 py-2.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-accent text-fg'
                    : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
