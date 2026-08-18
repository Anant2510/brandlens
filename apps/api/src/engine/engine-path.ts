/**
 * The engine's URL contract, in exactly one place.
 *
 * There are two HTTP clients for the analysis engine — the API's injectable
 * one and the worker's standalone one — because the worker has no Nest
 * container. They must agree on where the engine's routes live, and when they
 * did not, queued checks 404'd while synchronous checks succeeded: the same
 * asset returned a result or an error depending on whether the caller passed
 * `async: true`. Both clients now import this function.
 *
 * The engine versions its analysis surface under `/v1`, but deliberately keeps
 * liveness and build info at the root so a load balancer or an operator can
 * probe them without knowing which API version is deployed.
 */
export const ENGINE_API_PREFIX = '/v1';

const UNVERSIONED = new Set(['/health', '/health/deep', '/version']);

export function resolveEnginePath(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (UNVERSIONED.has(clean)) return clean;
  if (clean.startsWith(`${ENGINE_API_PREFIX}/`)) return clean;
  return `${ENGINE_API_PREFIX}${clean}`;
}
