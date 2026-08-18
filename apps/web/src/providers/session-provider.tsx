'use client';

import * as React from 'react';
import type { SessionUser } from '@/lib/auth-types';

const SessionContext = React.createContext<SessionUser | null>(null);

export function SessionProvider({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

/** The signed-in user. Guaranteed non-null inside the (app) layout. */
export function useSession(): SessionUser {
  const user = React.useContext(SessionContext);
  if (!user) throw new Error('useSession must be used inside the authenticated layout');
  return user;
}

export function useOptionalSession(): SessionUser | null {
  return React.useContext(SessionContext);
}
