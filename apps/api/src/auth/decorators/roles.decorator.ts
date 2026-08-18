import { SetMetadata } from '@nestjs/common';
import type { MemberRole } from '../../database/tenant-context.service';

export const ROLES_KEY = 'brandlens:roles';
export const SCOPES_KEY = 'brandlens:scopes';

/**
 * Role gate. The ladder is ordered, so `@Roles('reviewer')` admits reviewers
 * and everyone above them — activating a rule is a `brand_manager` act, and
 * an owner must not have to be granted it separately.
 */
export const Roles = (...roles: MemberRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** Scope gate for API-key callers. JWT sessions are governed by roles only. */
export const Scopes = (...scopes: string[]): MethodDecorator & ClassDecorator => SetMetadata(SCOPES_KEY, scopes);

/** Higher index ⇒ more authority. `service` sits with `creator`: an API key
 *  can submit and read, but never reconfigure the ontology. */
export const ROLE_ORDER: MemberRole[] = ['viewer', 'creator', 'service', 'reviewer', 'brand_manager', 'admin', 'owner'];

export function roleAtLeast(actual: MemberRole, required: MemberRole): boolean {
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(required);
}
