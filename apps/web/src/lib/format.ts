/** Display formatting. Measured values are always monospace and never rounded
 *  more aggressively than the threshold they are compared against. */

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  // The API returns rates as 0..1.
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(1);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
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
