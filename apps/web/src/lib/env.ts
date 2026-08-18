/**
 * The single place that knows where the NestJS API lives.
 *
 * The browser never talks to it directly: it talks to the same-origin proxy
 * under /api/proxy, which attaches the access token from an httpOnly cookie.
 * Only server code (route handlers) reads this value.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

/** Same-origin prefix the browser uses for every API call. */
export const PROXY_PREFIX = '/api/proxy';
