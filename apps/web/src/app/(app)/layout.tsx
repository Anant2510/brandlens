import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PlugZap } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { API_URL } from '@/lib/env';
import { AppShell } from '@/components/app-shell';
import { SessionRefresh } from '@/components/session-refresh';
import { SessionProvider } from '@/providers/session-provider';
import { buttonClasses } from '@/components/ui/button-variants';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (session.status === 'unauthenticated') redirect('/login');

  // The access token expired but the refresh token is still good. Rotation
  // writes cookies, which a render may not do, so hand off to the route
  // handler and come straight back. See getSession's comment.
  if (session.status === 'needs-refresh') return <SessionRefresh />;

  // An API restart is not an expired session. Say what actually happened.
  if (session.status === 'unreachable') return <ApiUnreachable statusCode={session.statusCode} message={session.message} />;

  return (
    <SessionProvider user={session.user}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}

function ApiUnreachable({ statusCode, message }: { statusCode: number; message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div role="alert" className="w-full max-w-md rounded-lg border border-border bg-surface p-6 text-center">
        <div className="mx-auto mb-3 w-fit rounded-full bg-major-soft p-2.5">
          <PlugZap className="size-5 text-major-fg" aria-hidden="true" />
        </div>
        <h1 className="text-sm font-semibold text-fg">The BrandLens API is not answering</h1>
        <p className="mt-1.5 text-xs leading-5 text-fg-muted">{message}</p>
        <dl className="mt-4 space-y-1.5 rounded-md bg-surface-2 p-3 text-left text-[11px]">
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Status</dt>
            <dd className="num text-fg">{statusCode}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-fg-subtle">Endpoint</dt>
            <dd className="num truncate text-fg">{API_URL}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] leading-4 text-fg-subtle">
          Your session is intact. Check that the API process is running and that <span className="num">NEXT_PUBLIC_API_URL</span>{' '}
          points at it.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Link href="/dashboard" className={buttonClasses('primary', 'sm')}>
            Try again
          </Link>
          <Link href="/login" className={buttonClasses('outline', 'sm')}>
            Sign in again
          </Link>
        </div>
      </div>
    </div>
  );
}
