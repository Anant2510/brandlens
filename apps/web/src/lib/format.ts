/** Display formatting. Measured values are always monospace and never rounded
 *  more aggressively than the threshold they are compared against. */

/**
 * Coerces whatever actually arrived into a number, or null.
 *
 * A declared TypeScript type is a promise about a value the compiler never
 * sees. These formatters take their input from an HTTP response, and several
 * things routinely put a STRING where the DTO says number:
 *
 *   * Postgres `numeric` and `bigint` come back as strings from node-postgres,
 *     because they do not fit an IEEE double without loss.
 *   * `organizations.daily_usd_limit` is a `text` column — money is stored as
 *     text on purpose, to keep it away from float rounding.
 *
 * `Number.isNaN('25')` is false, so the old guard let the string straight
 * through to `.toFixed()`, and the whole settings screen died with
 * "e.toFixed is not a function". Coercing here fixes every formatter at once
 * rather than waiting to discover the next column with the same shape.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Anything a JSON payload might hold where a number was promised. */
type Numeric = number | string | null | undefined;

export function formatNumber(value: Numeric, digits = 0): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(value: Numeric, digits = 1): string {
  const n = toNumber(value);
  if (n === null) return '—';
  // The API returns rates as 0..1.
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatScore(value: Numeric): string {
  const n = toNumber(value);
  return n === null ? '—' : n.toFixed(1);
}

export function formatUsd(value: Numeric): string {
  const n = toNumber(value);
  if (n === null) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(ms: Numeric): string {
  const n = toNumber(ms);
  if (n === null) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: Numeric): string {
  let value = toNumber(bytes);
  if (value === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_FMT.format(date);
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';
  return DATETIME_FMT.format(date);
}

export function formatRelative(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return '—';
  const deltaMs = date.getTime() - Date.now();
  const abs = Math.abs(deltaMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(deltaMs / size), unit);
  }
  return 'just now';
}

/** Hashes are long and meaningless; show the ends, keep the whole in a title. */
export function shortHash(hash: string | null | undefined, head = 10): string {
  if (!hash) return '—';
  return hash.length <= head + 3 ? hash : `${hash.slice(0, head)}…`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Renders an evidence value the way a reviewer needs to read it: compact,
 * unit-preserving, and never scientific notation for ordinary magnitudes.
 */
export function formatMeasured(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    if (Math.abs(value) >= 100) return value.toFixed(1);
    if (Math.abs(value) >= 1) return value.toFixed(2);
    return value.toFixed(3);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatMeasured).join(', ');
  return JSON.stringify(value);
}

/** `ΔE00` reads better than `deltaE00`; keeps analyzer keys legible. */
export function humanizeKey(key: string): string {
  const map: Record<string, string> = {
    deltaE00: 'ΔE00',
    deltaE: 'ΔE',
    contrastRatio: 'contrast ratio',
    clearspaceRatio: 'clearspace ratio',
    minSizePx: 'min size (px)',
  };
  if (map[key]) return map[key];
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}
