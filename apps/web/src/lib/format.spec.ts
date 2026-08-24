import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatNumber, formatPercent, formatScore, formatUsd } from './format';

/**
 * Regression guard for "e.toFixed is not a function".
 *
 * `organizations.daily_usd_limit` is a `text` column, so the API sent the
 * string "25" where the DTO promised a number. `Number.isNaN('25')` is false,
 * so the old guard waved it through to `.toFixed()` and the entire settings
 * screen rendered an error card instead.
 *
 * The same shape arrives from any Postgres `numeric` or `bigint` — node-postgres
 * returns those as strings because they do not fit an IEEE double. These tests
 * pin the coercion so the next such column is a formatting question rather
 * than a white screen.
 */

const FORMATTERS = [
  ['formatNumber', formatNumber],
  ['formatPercent', formatPercent],
  ['formatScore', formatScore],
  ['formatUsd', formatUsd],
  ['formatDuration', formatDuration],
  ['formatBytes', formatBytes],
] as const;

describe('numeric formatters — never throw on a non-number', () => {
  it.each(FORMATTERS)('%s survives every wrong-typed input', (_name, fn) => {
    const hostile: unknown[] = [null, undefined, '', '   ', 'abc', {}, [], true, NaN, Infinity, -Infinity];
    for (const value of hostile) {
      expect(() => fn(value as never)).not.toThrow();
      expect(fn(value as never)).toBe('—');
    }
  });

  it.each(FORMATTERS)('%s accepts a numeric string, as a text column supplies', (_name, fn) => {
    expect(() => fn('25' as never)).not.toThrow();
    expect(fn('25' as never)).not.toBe('—');
  });
});

describe('formatUsd', () => {
  it('formats the string a text column actually sends', () => {
    // The exact failing case: organizations.daily_usd_limit default is '25'.
    expect(formatUsd('25')).toBe('$25.00');
  });

  it('agrees whether the value arrived as a number or a string', () => {
    expect(formatUsd('25')).toBe(formatUsd(25));
    expect(formatUsd('0.004')).toBe(formatUsd(0.004));
  });

  it('keeps more precision on small amounts, where per-check cost lives', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.42)).toBe('$0.420');
    expect(formatUsd(4.2)).toBe('$4.20');
  });

  it('handles negatives without losing the sign', () => {
    expect(formatUsd(-12.5)).toBe('$-12.50');
  });
});

describe('formatPercent', () => {
  it('treats the API contract of 0..1 as a rate', () => {
    expect(formatPercent(0.873)).toBe('87.3%');
    expect(formatPercent('0.873')).toBe('87.3%');
  });

  it('honours the digits argument', () => {
    expect(formatPercent(0.1234, 2)).toBe('12.34%');
    expect(formatPercent(0.87, 0)).toBe('87%');
  });

  it('rounds by IEEE rules, not by decimal intuition', () => {
    // 0.87345 * 100 is 87.34499999999998 in binary floating point, so this
    // rounds DOWN. Pinned deliberately: a reviewer comparing a displayed rate
    // against a threshold needs to know the last digit is the float's, not a
    // rounding choice this code made.
    expect(formatPercent(0.87345, 2)).toBe('87.34%');
  });
});

describe('formatScore / formatNumber', () => {
  it('renders one decimal place', () => {
    expect(formatScore(8.25)).toBe('8.3');
    expect(formatScore('8.25')).toBe('8.3');
  });

  it('groups thousands', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber('1234567')).toBe('1,234,567');
  });
});

describe('formatDuration', () => {
  it('switches unit with magnitude', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('accepts a string, as a bigint column supplies', () => {
    expect(formatDuration('1500')).toBe('1.5s');
  });

  it('renders sub-millisecond latencies without claiming zero precision', () => {
    // Deterministic checks routinely complete in under 1ms; the schema uses
    // `real` for exactly this reason.
    expect(formatDuration(0.4)).toBe('0ms');
  });
});

describe('formatBytes', () => {
  it('steps through units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('accepts a string, as a bigint byte count supplies', () => {
    expect(formatBytes('2048')).toBe('2.0 KB');
  });
});
