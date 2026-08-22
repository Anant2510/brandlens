'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { segment: '', label: 'Overview' },
  { segment: '/ontology', label: 'Ontology' },
  { segment: '/rules', label: 'Rules' },
  { segment: '/rule-packs', label: 'Standards' },
  { segment: '/rules/review', label: 'Confirm proposals' },
  { segment: '/documents', label: 'Documents' },
  { segment: '/rulesets', label: 'Rulesets' },
];

/** Sub-navigation shared by every brand-scoped screen. */
export function BrandNav({ brandId }: { brandId: string }) {
  const pathname = usePathname();
  const base = `/brands/${brandId}`;

  return (
    <nav aria-label="Brand sections" className="border-b border-border px-4">
      <ul className="flex flex-wrap items-center gap-1">
        {SECTIONS.map((section) => {
          const href = `${base}${section.segment}`;
          const active = section.segment === '' ? pathname === base : pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-block border-b-2 px-2.5 py-2 text-xs font-medium transition-colors',
                  active
                    ? 'border-accent text-fg'
                    : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
