import { NextResponse } from 'next/server';
import { callApi, clearSessionCookies, getRefreshToken } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const refreshToken = await getRefreshToken();
  // Best effort: revoke upstream, but always clear locally.
  if (refreshToken) await callApi('/v1/auth/logout', { method: 'POST', body: { refreshToken } });
  await clearSessionCookies();
  return NextResponse.json({ ok: true });
}
