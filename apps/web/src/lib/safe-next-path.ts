/**
 * Validates a caller-supplied "come back here afterwards" path.
 *
 * The session-refresh handler takes `?next=` straight off the query string and
 * redirects to it. Without a guard that is a textbook open redirect: an
 * attacker sends `/api/auth/refresh?next=https://evil.example/login`, the
 * victim lands on a convincing fake login page having just been bounced
 * through the real domain, and the address bar history shows the legitimate
 * host immediately before it.
 *
 * The rule is an allowlist, not a blocklist: a value must be a single-slash
 * relative path made of ordinary URL characters, or it is discarded and the
 * caller falls back to the dashboard. Cases this rejects on purpose:
 *
 *   https://evil.example  - absolute URL
 *   //evil.example        - protocol-relative; the browser treats it as absolute
 *   /\evil.example        - backslash; some browsers normalise this to //
 *   javascript:alert(1)   - scheme without a leading slash
 *   /path\r\nSet-Cookie:  - control characters, header injection
 *
 * `decodeURIComponent` runs first because the value arrives percent-encoded,
 * and `%2F%2Fevil.example` must be judged as the `//evil.example` it becomes.
 */
const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/?#[\]%]*$/;

export const DEFAULT_NEXT_PATH = '/dashboard';

export function safeNextPath(raw: string | null | undefined, fallback: string = DEFAULT_NEXT_PATH): string {
  if (!raw) return fallback;

  let value = raw;
  // A doubly-encoded value would otherwise slip a second decode past us later.
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      return fallback; // malformed escape sequence
    }
  }

  if (value.length > 512) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (!SAFE_PATH.test(value)) return fallback;

  return value;
}
