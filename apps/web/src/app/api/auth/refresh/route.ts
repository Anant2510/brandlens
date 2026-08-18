import { NextResponse } from 'next/server';
import { rotateSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rotates the refresh token and rewrites both httpOnly cookies. Returns only a
 * boolean: the browser must never see a token value.
 */
export async function POST(): Promise<NextResponse> {
  const token = await rotateSession();
  if (!token) {
    return NextResponse.json({ statusCode: 401, error: 'Unauthorized', message: 'Session expired' }, { status: 401 });
  }
  return NextResponse.json({ refreshed: true });
}
