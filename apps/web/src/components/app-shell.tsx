'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileStack,
  Gauge,
  Layers,
  LogOut,
  Menu,
  Radar,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BrandSwitcher } from '@/components/brand-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { useSession } from '@/providers/session-provider';
import { ROLE_LABEL } from '@/lib/auth-types';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Gauge;
  /** Treat any deeper path as active too. */
  prefix?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/checks', label: 'Checks', icon: ShieldCheck, prefix: true },
  { href: '/review', label: 'Review queue', icon: ClipboardCheck, prefix: true },
  { href: '/assets', label: 'Assets', icon: Boxes, prefix: true },
  { href: '/brands', label: 'Brands', icon: Layers, prefix: true },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
];

const SECONDARY_NAV: NavItem[] = [
  { href: '/discover', label: 'Discover', icon: Radar, prefix: true },
  { href: '/assemble', label: 'Assemble', icon: FileStack, prefix: true },
  { href: '/predict', label: 'Predict', icon: TrendingUp, prefix: true },
];

const SETTINGS_NAV: NavItem[] = [
  { href: '/settings/organization', label: 'Organization', icon: Settings },
  { href: '/settings/members', label: 'Members', icon: Settings },
  { href: '/settings/api-keys', label: 'API keys', icon: Settings },
  { href: '/settings/webhooks', label: 'Webhooks', icon: Settings },
  { href: '/settings/models', label: 'Models', icon: Settings },
  { href: '/settings/audit-log', label: 'Audit log', icon: Settings },
];

const COLLAPSE_KEY = 'brandlens.sidebar.collapsed';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useSession();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      window.localStorage.setItem(COLLAPSE_KEY, current ? '0' : '1');
      return !current;
    });
  };

  const signOut = async () => {
    setSigningOut(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  const isActive = (item: NavItem) =>
    item.prefix ? pathname === item.href || pathname.startsWith(`${item.href}/`) : pathname === item.href;

  const sidebar = (
    <div className="flex h-full flex-col gap-3 p-2">
      <div className={cn('flex items-center gap-2 px-1 pt-1', collapsed && 'justify-center')}>
        <Link href="/dashboard" className="flex items-center gap-2 min-w-0" aria-label="BrandLens home">
          <span className="grid size-6 shrink-0 place-items-center rounded bg-accent text-accent-fg">
            <Activity className="size-3.5" aria-hidden="true" />
          </span>
          {!collapsed ? <span className="truncate text-[13px] font-semibold tracking-tight">BrandLens</span> : null}
        </Link>
      </div>

      <div className={cn(collapsed && 'px-0')}>
        <BrandSwitcher collapsed={collapsed} />
      </div>

      <nav className="flex-1 overflow-y-auto scroll-thin" aria-label="Primary">
        <NavGroup items={PRIMARY_NAV} collapsed={collapsed} isActive={isActive} />
        <NavDivider collapsed={collapsed} label="Workflows" />
        <NavGroup items={SECONDARY_NAV} collapsed={collapsed} isActive={isActive} />
        <NavDivider collapsed={collapsed} label="Settings" />
        <NavGroup items={SETTINGS_NAV} collapsed={collapsed} isActive={isActive} hideIcons />
      </nav>

      <div className="space-y-2 border-t border-border pt-2">
        <div className={cn('flex items-center gap-2 px-1', collapsed && 'justify-center')}>
          <span
            className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-fg-muted"
            aria-hidden="true"
          >
            {(user.name ?? user.email).slice(0, 2).toUpperCase()}
          </span>
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium text-fg">{user.name ?? user.email}</p>
              <p className="truncate text-[10px] text-fg-subtle">
                {user.orgName} · {ROLE_LABEL[user.role] ?? user.role}
              </p>
            </div>
          ) : null}
        </div>

        <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between px-1')}>
          <ThemeToggle compact={collapsed} />
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => void signOut()} loading={signingOut} aria-label="Sign out">
              <LogOut className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden lg:inline-flex"
            >
              {collapsed ? (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronLeft className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1.5 focus:text-xs focus:text-accent-fg"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface transition-[width] duration-150 lg:block',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        {sidebar}
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <aside className="absolute left-0 top-0 h-full w-60 border-r border-border bg-surface" aria-label="Navigation">
            <div className="flex justify-end p-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-border bg-surface/90 px-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="size-4" aria-hidden="true" />
          </Button>
          <Link href="/dashboard" className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Sparkles className="size-3.5 text-accent" aria-hidden="true" />
            BrandLens
          </Link>
        </header>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  collapsed,
  isActive,
  hideIcons = false,
}: {
  items: NavItem[];
  collapsed: boolean;
  isActive: (item: NavItem) => boolean;
  hideIcons?: boolean;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = isActive(item);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                collapsed && 'justify-center px-0',
                active ? 'bg-accent-soft text-accent-soft-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {!hideIcons || collapsed ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
              {!collapsed ? <span className="truncate">{item.label}</span> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function NavDivider({ collapsed, label }: { collapsed: boolean; label: string }) {
  if (collapsed) return <div className="my-2 border-t border-border" />;
  return (
    <p className="mb-1 mt-4 px-2 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">{label}</p>
  );
}

/* --------------------------------------------------------------------------
 * Page chrome shared by every route.
 * ------------------------------------------------------------------------ */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        {breadcrumbs?.length ? (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex flex-wrap items-center gap-1 text-[11px] text-fg-subtle">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-fg transition-colors">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-fg-muted">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1 className="truncate text-base font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <div className="mt-0.5 text-xs text-fg-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
