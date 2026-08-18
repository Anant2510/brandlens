import { PROXY_PREFIX } from './env';

/* ==========================================================================
 * Typed fetch wrapper.
 *
 * Every browser request goes to the same-origin proxy, which attaches the
 * access token from an httpOnly cookie. Tokens never touch JS-readable
 * storage, so an XSS bug cannot exfiltrate a session.
 *
 * A 401 triggers exactly one refresh attempt, de-duplicated across concurrent
 * requests, then one retry. A second 401 is a real session expiry.
 * ========================================================================== */

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  correlationId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messages: string[];
  readonly correlationId?: string;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback = 'Request failed') {
    const parsed = parseErrorBody(body);
    super(parsed.messages[0] ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = parsed.code;
    this.messages = parsed.messages.length > 0 ? parsed.messages : [fallback];
    this.correlationId = parsed.correlationId;
    this.body = body;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** The API is down / unreachable rather than refusing the request. */
  get isNetwork(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

function parseErrorBody(body: unknown): { code: string; messages: string[]; correlationId?: string } {
  if (typeof body === 'string' && body.trim().length > 0) {
    return { code: 'Error', messages: [body] };
  }
  if (body && typeof body === 'object') {
    const record = body as Partial<ApiErrorBody>;
    const raw = record.message;
    const messages = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : raw ? [raw] : [];
    return {
      code: typeof record.error === 'string' ? record.error : 'Error',
      messages,
      correlationId: typeof record.correlationId === 'string' ? record.correlationId : undefined,
    };
  }
  return { code: 'Error', messages: [] };
}

export type QueryValue = string | number | boolean | undefined | null;

export function buildQuery(params?: Record<string, QueryValue | QueryValue[]>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        search.append(key, String(item));
      }
    } else {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue | QueryValue[]>;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry dance (used by the auth endpoints themselves). */
  noRefresh?: boolean;
  headers?: Record<string, string>;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        // Release the latch on the next tick so parallel callers all observe
        // the same result before a new attempt can start.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      });
  }
  return refreshInFlight;
}

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (res.status === 204) return null;
  try {
    if (type.includes('application/json')) return await res.json();
    const text = await res.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = `${PROXY_PREFIX}${path.startsWith('/') ? path : `/${path}`}${buildQuery(options.query)}`;
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;

  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (!isForm && options.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
    headers,
    body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
    cache: 'no-store',
  });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await send(path, options);
  } catch (cause) {
    throw new ApiError(0, { error: 'NetworkError', message: 'Cannot reach the BrandLens API.' }, String(cause));
  }

  if (res.status === 401 && !options.noRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      try {
        res = await send(path, { ...options, noRefresh: true });
      } catch (cause) {
        throw new ApiError(0, { error: 'NetworkError', message: 'Cannot reach the BrandLens API.' }, String(cause));
      }
    }
  }

  if (!res.ok) throw new ApiError(res.status, await readBody(res), res.statusText);
  if (res.status === 204) return undefined as T;
  return (await readBody(res)) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'POST', body, query }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, query?: RequestOptions['query']) => apiRequest<T>(path, { method: 'DELETE', query }),
};

/** Human-facing text for any thrown value. Never leaks `[object Object]`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.messages.join(' · ');
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
