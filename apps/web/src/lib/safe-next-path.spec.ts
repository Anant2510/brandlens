import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_PATH, safeNextPath } from './safe-next-path';

describe('safeNextPath', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeNextPath('/assets')).toBe('/assets');
    expect(safeNextPath('/brands/abc-123/rules')).toBe('/brands/abc-123/rules');
  });

  it('keeps a query string and fragment', () => {
    expect(safeNextPath('/checks?status=failed&page=2')).toBe('/checks?status=failed&page=2');
    expect(safeNextPath('/assets#top')).toBe('/assets#top');
  });

  it('accepts the percent-encoded form the query string actually delivers', () => {
    expect(safeNextPath(encodeURIComponent('/checks?status=failed'))).toBe('/checks?status=failed');
  });

  it('falls back when there is nothing to go back to', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('')).toBe(DEFAULT_NEXT_PATH);
  });

  /* ------------------------------------------------ open-redirect rejection */

  it('rejects an absolute URL', () => {
    expect(safeNextPath('https://evil.example/login')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('http://evil.example')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a protocol-relative URL', () => {
    // The browser resolves //host against the current scheme — this is an
    // absolute navigation wearing a relative path's clothes.
    expect(safeNextPath('//evil.example')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('//evil.example/login')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects the backslash variant some browsers normalise to //', () => {
    expect(safeNextPath('/\\evil.example')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/\\/evil.example')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a percent-encoded protocol-relative URL', () => {
    expect(safeNextPath('%2F%2Fevil.example')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a doubly-encoded protocol-relative URL', () => {
    expect(safeNextPath('%252F%252Fevil.example')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a scheme with no leading slash', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('data:text/html,<script>')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects control characters used for header injection', () => {
    expect(safeNextPath('/assets\r\nSet-Cookie: bl_at=stolen')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('/assets\n/evil')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a malformed escape sequence rather than throwing', () => {
    expect(safeNextPath('/assets%')).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath('%E0%A4%A')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects an absurdly long value', () => {
    expect(safeNextPath('/' + 'a'.repeat(600))).toBe(DEFAULT_NEXT_PATH);
  });

  it('honours an explicit fallback', () => {
    expect(safeNextPath('https://evil.example', '/login')).toBe('/login');
  });
});
