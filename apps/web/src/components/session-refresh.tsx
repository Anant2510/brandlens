'use client';

import { useEffect } from 'react';

/**
 * Bridges an expired access token back to a working session.
 *
 * `(app)/layout.tsx` knows the session needs rotating but cannot do it: a
 * render may not write cookies. It also cannot see the current pathname —
 * layouts receive no path, and reading one from headers means adding
 * middleware. So the layout renders this, and the browser supplies the path it
 * already knows, then navigates to the route handler that can rotate.
 *
 * `location.replace` rather than `assign` so the back button skips this step
 * instead of landing on a page that immediately redirects again.
 */
export function SessionRefresh() {
  useEffect(() => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/api/auth/refresh?next=${encodeURIComponent(next)}`);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="text-center" role="status" aria-live="polite">
        <div
          className="mx-auto size-5 animate-spin rounded-full border-2 border-border border-t-accent"
          aria-hidden="true"
        />
        <p className="mt-3 text-xs text-fg-muted">Restoring your session…</p>
        <noscript>
          <p className="mt-3 text-xs text-fg-muted">
            JavaScript is required to restore a session automatically.{' '}
            <a href="/api/auth/refresh" className="text-accent underline">
              Continue
            </a>
          </p>
        </noscript>
      </div>
    </div>
  );
}
