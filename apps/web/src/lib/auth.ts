import 'server-only';

import { cookies, headers } from 'next/headers';
import { API_URL } from './env';

/* ==========================================================================
 * Server-side session handling.
 *
 * Access and refresh tokens live in httpOnly cookies written by the route
 * handlers under app/api/auth/*. No token is ever handed to client JavaScript,
 * so `localStorage` never holds a credential and XSS cannot lift a session.
 * ========================================================================== */

export const ACCESS_COOKIE = 'bl_at';
export const REFRESH_COOKIE = 'bl_rt';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: string;
}

/**
 * The wire shape of `POST /v1/auth/{login,register,refresh}`.
 *
 * The API returns tokens FLAT alongside the user — `{accessToken,
 * refreshToken, expiresIn, user}` — not nested under a `tokens` key. That is
 * the published contract (see docs/api.md), so the console adapts to it rather
 * than the other way round: external API consumers already depend on it.
 * `readTokens` is the single adapter, so if the envelope ever changes there is
 * exactly one place to edit.
 */
export interface AuthResponse extends AuthTokens {
  user: SessionUser;
}

export function readTokens(data: AuthResponse | null | undefined): AuthTokens | null {
  if (!data?.accessToken || !data?.refreshToken) return null;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn ?? 900,
  };
}

/**
 * `secure` follows the actual request protocol, not NODE_ENV.
 *
 * A production build served over plain HTTP — which is exactly how PM2 runs it
 * on a Windows VM behind Caddy, and how an operator will first smoke-test it —
 * would otherwise set a cookie the browser refuses to send back, and login
 * would appear to succeed and then silently fail.
 */
async function isSecureRequest(): Promise<boolean> {
  try {
    const store = await headers();
    const proto = store.get('x-forwarded-proto');
    if (proto) return proto.split(',')[0].trim() === 'https';
    return (store.get('referer') ?? '').startsWith('https://');
  } catch {
    return false;
  }
}

function cookieOptions(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge,
  };
}

export async function setSessionCookies(tokens: AuthTokens): Promise<void> {
  const [jar, secure] = await Promise.all([cookies(), isSecureRequest()]);
  // A little headroom under the access TTL so the cookie never outlives the JWT.
  jar.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(Math.max(60, tokens.expiresIn), secure));
  jar.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(60 * 60 * 24 * 30, secure));
}

export async function clearSessionCookies(): Promise<void> {
  const [jar, secure] = await Promise.all([cookies(), isSecureRequest()]);
  jar.set(ACCESS_COOKIE, '', { ...cookieOptions(0, secure), maxAge: 0 });
  jar.set(REFRESH_COOKIE, '', { ...cookieOptions(0, secure), maxAge: 0 });
}

export async function getAccessToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(ACCESS_COOKIE)?.value || undefined;
}

export async function getRefreshToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(REFRESH_COOKIE)?.value || undefined;
}

export interface UpstreamResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: unknown;
}

/** One place that talks to the NestJS API from the server. */
export async function callApi<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<UpstreamResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    return { ok: res.ok, status: res.status, data: res.ok ? (parsed as T) : null, error: res.ok ? null : parsed };
  } catch {
    return {
      ok: false,
      status: 503,
      data: null,
      error: { statusCode: 503, error: 'UpstreamUnavailable', message: 'The BrandLens API is unreachable.' },
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Rotates the refresh token upstream and rewrites both cookies.
 * Returns the fresh access token, or null when the session is truly gone.
 */
export async function rotateSession(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  const result = await callApi<AuthResponse>('/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
  const tokens = readTokens(result.ok ? result.data : null);
  if (!tokens) {
    await clearSessionCookies();
    return null;
  }

  await setSessionCookies(tokens);
  return tokens.accessToken;
}

export type SessionResult =
  | { status: 'authenticated'; user: SessionUser }
  | { status: 'unauthenticated' }
  /** The access token is spent but a refresh token survives. The caller must
   *  hand the browser to `/api/auth/refresh`, because rotating the session
   *  means writing cookies and this function may be running inside a render.
   *  See the comment on `getSession` below. */
  | { status: 'needs-refresh' }
  /** The API is down or refusing. Distinct from "signed out" on purpose:
   *  bouncing a signed-in user to the login screen because the API restarted
   *  tells them the wrong thing, and they will retype a password that was
   *  never the problem. */
  | { status: 'unreachable'; statusCode: number; message: string };

/**
 * Reads the session. **Never writes cookies** — and that constraint is the
 * whole point of this function's shape.
 *
 * Next.js 15 forbids `cookies().set()` during a Server Component render:
 * headers are already flushed by the time a component runs, so the call throws
 * `Cookies can only be modified in a Server Action or Route Handler`. This
 * function is called from `(app)/layout.tsx`, which is a render. An earlier
 * version rotated the session inline, which meant every session died with a
 * blank "failed to start this page" screen the moment the access token
 * expired — roughly fifteen minutes into any sitting.
 *
 * Rotation is also not merely a write: the API invalidates the old refresh
 * token when it issues a new one. Refreshing somewhere the result cannot be
 * persisted would consume the user's only valid refresh token and destroy the
 * session outright. So the expired case returns `needs-refresh` and the
 * caller redirects to the route handler, where a cookie write is legal.
 */
export async function getSession(): Promise<SessionResult> {
  const token = await getAccessToken();

  if (token) {
    const me = await callApi<SessionUser>('/v1/auth/me', { token });
    if (me.ok && me.data) return { status: 'authenticated', user: me.data };
    if (me.status !== 401) return unreachable(me);
  }

  const refreshToken = await getRefreshToken();
  if (!refreshToken) return { status: 'unauthenticated' };

  return { status: 'needs-refresh' };
}

function unreachable(result: UpstreamResult<unknown>): SessionResult {
  const body = result.error as { message?: string | string[] } | null;
  const raw = Array.isArray(body?.message) ? body.message.join(' · ') : body?.message;
  return {
    status: 'unreachable',
    statusCode: result.status,
    message: raw ?? `The BrandLens API responded with ${result.status}.`,
  };
}

/** The current session user, or null. Safe to call from a server component. */
/**
 * "Is someone signed in right now?" for the entry points that only branch two
 * ways — the root page and the login/register layout.
 *
 * `needs-refresh` deliberately reads as "no". Those routes send an unknown
 * visitor to the login screen, which is a safe landing spot for a stale
 * session; the alternative, bouncing them through the refresh handler, risks a
 * redirect loop on the very screen the loop would strand them on. The signed-in
 * area (`(app)/layout.tsx`) is where a stale session is worth rescuing, and it
 * calls `getSession` directly.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session.status === 'authenticated' ? session.user : null;
}
