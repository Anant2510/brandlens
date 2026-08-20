import { describe, expect, it } from 'vitest';
import { previewKeyKind, toDto, type AssetRow } from './assets.service';

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
