import { NextResponse, type NextRequest } from 'next/server';
import { rotateSession } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-next-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rotates the refresh token and rewrites both httpOnly cookies. Returns only a
 * boolean: the browser must never see a token value.
 *
 * Used by the client-side API wrapper when a fetch comes back 401.
 */
export async function POST(): Promise<NextResponse> {
  const token = await rotateSession();
  if (!token) {
    return NextResponse.json({ statusCode: 401, error: 'Unauthorized', message: 'Session expired' }, { status: 401 });
  }
  return NextResponse.json({ refreshed: true });
}

/**
 * The navigation counterpart of POST: rotate, then put the user back where
 * they were going.
 *
 * A Server Component render cannot write cookies (Next.js flushes headers
 * before components run), so `(app)/layout.tsx` cannot rotate an expired
 * session itself — it redirects the browser here instead. A route handler is
 * one of the two places a cookie write is legal, so the rotation lands, and
 * the user continues to `?next=` none the wiser.
 *
 * `next` is attacker-controllable, so it goes through `safeNextPath` before it
 * reaches a `Location` header. A failed rotation has already cleared the
 * cookies, so sending the user to `/login` cannot bounce back here.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));
  const token = await rotateSession();
  const destination = new URL(token ? next : '/login', request.nextUrl.origin);

  const response = NextResponse.redirect(destination, { status: 303 });
  // This response's only job is to hand over a new cookie pair. Letting any
  // cache keep it would serve a stale session to whoever asked next.
  response.headers.set('cache-control', 'no-store, max-age=0');
  return response;
}
