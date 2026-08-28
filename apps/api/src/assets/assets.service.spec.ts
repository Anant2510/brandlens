import { describe, expect, it } from 'vitest';
import { previewKeyKind, toDto, type AssetRow, isRenderableImageKey } from './assets.service';

/**
 * Regression guard for the defect where `/assets` rendered a placeholder for
 * every row: the list path built DTOs with `toDto` alone and never populated
 * `previewUrl`, while the detail path did. Nothing errored — the UI correctly
 * showed its "no preview" icon — which is why the API logs were silent and the
 * bug looked like broken image loading.
 *
 * These tests pin the two halves of that contract: `toDto` deliberately omits
 * the preview (it has no storage access), so any caller returning DTOs to a
 * client is responsible for attaching it.
 */
describe('previewKeyKind', () => {
  it('treats the copy-only sentinel as having no preview', () => {
    expect(previewKeyKind('inline:9f2a3b')).toBe('none');
  });

  it('treats a missing key as having no preview', () => {
    expect(previewKeyKind(null)).toBe('none');
    expect(previewKeyKind(undefined)).toBe('none');
    expect(previewKeyKind('')).toBe('none');
  });

  it('passes an absolute URL through without signing it', () => {
    expect(previewKeyKind('https://cdn.example.com/a.png')).toBe('external');
    expect(previewKeyKind('HTTP://cdn.example.com/a.png')).toBe('external');
  });

  it('signs an ordinary storage key', () => {
    expect(previewKeyKind('originals/org-1/17/17c98f24.png')).toBe('sign');
  });

  it('signs keys regardless of separator, so Windows paths are not misread', () => {
    expect(previewKeyKind('originals\\org-1\\17\\17c98f24.png')).toBe('sign');
  });
});

describe('toDto', () => {
  const row = {
    id: 'asset-1',
    brandId: 'brand-1',
    campaignId: null,
    variantFamilyId: null,
    name: 'hero.png',
    kind: 'image',
    status: 'ready',
    contentHash: 'abc123',
    mimeType: 'image/png',
    byteSize: 1024,
    width: 1200,
    height: 630,
    durationMs: null,
    colorProfile: null,
    dpi: null,
    sourceFidelity: 'original',
    market: null,
    channel: null,
    assetType: null,
    locale: null,
    copyFields: {},
    tags: [],
    isApprovedExemplar: false,
    error: null,
    storageKey: 'originals/org-1/17/17c98f24.png',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as unknown as AssetRow;

  it('does not invent a preview URL', () => {
    expect(toDto(row).previewUrl).toBeUndefined();
  });

  it('never leaks the raw storage key to the client', () => {
    // The key is only ever exposed via a signed, expiring URL. Shipping it in
    // the DTO would let a client address another tenant's object directly.
    expect(JSON.stringify(toDto(row))).not.toContain('originals/');
  });
});

describe('isRenderableImageKey', () => {
  /*
   * A discovery page harvested over plain HTTP has no screenshot. It is stored
   * as its structured source under `…/<hash>.json`, and that key has real bytes
   * behind it — so it walked past `previewKeyKind`'s "no bytes" check, got
   * signed, and was handed to the report as a preview URL. The grid rendered
   * broken-image icons pointing at JSON, and the report gave no hint that the
   * reason was "this site was read without a browser".
   *
   * A preview URL is for an <img>. If an <img> cannot paint it, the honest
   * answer is null and a placeholder that says so.
   */
  it('rejects the structured-source key a static harvest produces', () => {
    expect(isRenderableImageKey('originals/org/68/68912716802f8698.json')).toBe(false);
  });

  it('accepts the screenshot key a rendered harvest produces', () => {
    expect(isRenderableImageKey('originals/org/68/68912716802f8698.png')).toBe(true);
  });

  it('accepts the usual image extensions, whatever their case', () => {
    for (const key of ['a/b.JPG', 'a/b.jpeg', 'a/b.webp', 'a/b.gif', 'a/b.avif', 'a/b.svg']) {
      expect({ key, ok: isRenderableImageKey(key) }).toMatchObject({ ok: true });
    }
  });

  it('rejects documents, which have bytes but are not images', () => {
    // These must still be downloadable — that path uses previewUrl, not this.
    for (const key of ['a/b.pdf', 'a/b.docx', 'a/b.xlsx', 'a/b.bin', 'a/b']) {
      expect({ key, ok: isRenderableImageKey(key) }).toMatchObject({ ok: false });
    }
  });

  it('rejects the copy-only sentinel and empty input', () => {
    expect(isRenderableImageKey('inline:abc123')).toBe(false);
    expect(isRenderableImageKey(null)).toBe(false);
    expect(isRenderableImageKey(undefined)).toBe(false);
    expect(isRenderableImageKey('')).toBe(false);
  });

  it('trusts an absolute URL from a remote driver, as previewKeyKind does', () => {
    expect(isRenderableImageKey('https://cdn.example.com/thumb/abc')).toBe(true);
  });
});
