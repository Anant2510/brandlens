import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ statusCode: 401, error: 'Unauthorized', message: 'No session' }, { status: 401 });
  }
  return NextResponse.json({ user });
}
