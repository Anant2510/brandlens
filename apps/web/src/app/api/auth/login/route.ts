import { NextResponse } from 'next/server';
import { LoginInput } from '@brandlens/contracts';
import { callApi, readTokens, setSessionCookies, type AuthResponse } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = LoginInput.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { statusCode: 400, error: 'BadRequest', message: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const result = await callApi<AuthResponse>('/v1/auth/login', { method: 'POST', body: parsed.data });
  if (!result.ok || !result.data) {
    return NextResponse.json(result.error ?? { statusCode: result.status, error: 'AuthFailed', message: 'Login failed' }, {
      status: result.status,
    });
  }

  const tokens = readTokens(result.data);
  if (!tokens) {
    return NextResponse.json(
      { statusCode: 502, error: 'BadUpstreamResponse', message: 'The API returned no tokens.' },
      { status: 502 },
    );
  }

  await setSessionCookies(tokens);
  return NextResponse.json({ user: result.data.user });
}
