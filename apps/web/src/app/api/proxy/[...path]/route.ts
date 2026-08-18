import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/env';
import { getAccessToken } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ==========================================================================
 * Same-origin API proxy.
 *
 * The browser calls /api/proxy/v1/... with no credentials of its own. This
 * handler reads the httpOnly access-token cookie and attaches the bearer
 * header server-side. A 401 is passed straight back so the client can run its
 * single refresh-and-retry through /api/auth/refresh.
 * ========================================================================== */

/** Headers that must not be forwarded upstream or back downstream. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'set-cookie',
]);

async function handle(request: Request, path: string[]): Promise<Response> {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ statusCode: 401, error: 'Unauthorized', message: 'No session' }, { status: 401 });
  }

  const search = new URL(request.url).search;
  const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('authorization', `Bearer ${token}`);

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // Buffered rather than streamed: uploads are capped at 25 MB upstream and a
  // buffered body keeps this handler compatible with every Node adapter.
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { statusCode: 503, error: 'UpstreamUnavailable', message: 'The BrandLens API is unreachable.' },
      { status: 503 },
    );
  }

  // Signed-URL redirects (asset previews) are surfaced as JSON so an <img>
  // consumer can decide, rather than being silently followed by fetch().
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    if (location) return NextResponse.json({ url: location }, { status: 200 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  responseHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
