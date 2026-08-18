/** Client-safe mirror of the session shape. `lib/auth.ts` is server-only. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: string;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  brand_manager: 'Brand manager',
  reviewer: 'Reviewer',
  creator: 'Creator',
  viewer: 'Viewer',
  service: 'Service',
};

/** Mirrors ROLE_ORDER in the API's roles decorator — higher index, more authority. */
const ROLE_ORDER = ['viewer', 'creator', 'service', 'reviewer', 'brand_manager', 'admin', 'owner'] as const;

export type MemberRole = (typeof ROLE_ORDER)[number];

/**
 * Mirrors the API's RolesGuard so the UI hides actions the server would refuse.
 * This is an affordance, not a security boundary: the API re-checks everything.
 */
export function hasRole(role: string, minimum: MemberRole): boolean {
  const actual = ROLE_ORDER.indexOf(role as MemberRole);
  const required = ROLE_ORDER.indexOf(minimum);
  return actual >= 0 && required >= 0 && actual >= required;
}
