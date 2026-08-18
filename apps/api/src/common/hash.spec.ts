import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  generateApiKey,
  hashApiKey,
  hashObject,
  jobKey,
  promptHash,
  rulesetHash,
  safeEqual,
  sha256,
  traceKey,
  transformHash,
} from './hash';

describe('canonicalJson', () => {
  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('is sensitive to array order, because arrays are ordered data', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats an absent key and an explicit undefined as identical', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe(canonicalJson({ x: { y: 2, z: 1 } }));
  });

  it('normalises null and non-finite numbers', () => {
    expect(canonicalJson({ a: Number.NaN })).toBe('{"a":null}');
    expect(canonicalJson({ a: Number.POSITIVE_INFINITY })).toBe('{"a":null}');
  });

  it('serialises dates stably', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(canonicalJson({ d })).toBe('{"d":"2026-01-02T03:04:05.000Z"}');
  });
});

describe('sha256 / contentHash', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is a pure function of the bytes', () => {
    const a = Buffer.from('brandlens');
    expect(contentHash(a)).toBe(contentHash(Buffer.from('brandlens')));
    expect(contentHash(a)).not.toBe(contentHash(Buffer.from('brandlen5')));
  });

  it('produces a 64-character hex digest that fits varchar(80)', () => {
    expect(contentHash(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('jobKey', () => {
  const base = {
    assetContentHash: 'a'.repeat(64),
    rulesetHash: 'b'.repeat(64),
    pipelineVersion: '1.0.0',
    modelVersion: 'anthropic:claude-sonnet-4-5',
    promptHash: 'c'.repeat(40),
  };

  it('is deterministic', () => {
    expect(jobKey(base)).toBe(jobKey({ ...base }));
  });

  it('changes when ANY of the five inputs changes', () => {
    const original = jobKey(base);
    expect(jobKey({ ...base, assetContentHash: 'z'.repeat(64) })).not.toBe(original);
    expect(jobKey({ ...base, rulesetHash: 'z'.repeat(64) })).not.toBe(original);
    expect(jobKey({ ...base, pipelineVersion: '1.0.1' })).not.toBe(original);
    expect(jobKey({ ...base, modelVersion: 'openai:gpt-5' })).not.toBe(original);
    expect(jobKey({ ...base, promptHash: 'z'.repeat(40) })).not.toBe(original);
  });

  it('separates variants so a dimension-filtered re-check never collides', () => {
    expect(jobKey({ ...base, variant: 'logo-only' })).not.toBe(jobKey(base));
  });

  it('does not confuse field boundaries', () => {
    // "ab" + "c" must not hash the same as "a" + "bc".
    const left = jobKey({ ...base, assetContentHash: 'ab', rulesetHash: 'c' });
    const right = jobKey({ ...base, assetContentHash: 'a', rulesetHash: 'bc' });
    expect(left).not.toBe(right);
  });
});

describe('traceKey', () => {
  const base = {
    assetContentHash: 'a'.repeat(64),
    rulesetHash: 'b'.repeat(64),
    ruleKey: 'logo.clearspace',
    ruleVersion: 3,
    modelVersion: 'anthropic:claude-sonnet-4-5',
    promptHash: 'default',
  };

  it('is stable per rule version', () => {
    expect(traceKey(base)).toBe(traceKey({ ...base }));
    expect(traceKey({ ...base, ruleVersion: 4 })).not.toBe(traceKey(base));
  });

  it('differs from the job key built from the same material', () => {
    expect(traceKey(base)).not.toBe(
      jobKey({
        assetContentHash: base.assetContentHash,
        rulesetHash: base.rulesetHash,
        pipelineVersion: '1.0.0',
        modelVersion: base.modelVersion,
        promptHash: base.promptHash,
      }),
    );
  });

  it('distinguishes rules within one ruleset', () => {
    expect(traceKey({ ...base, ruleKey: 'color.palette' })).not.toBe(traceKey(base));
  });
});

describe('rulesetHash', () => {
  const rule = {
    key: 'logo.clearspace',
    version: 1,
    statement: 'Maintain 1x clear space',
    dimension: 'logo',
    tier: 'deterministic',
    severity: 'major',
    weight: 1,
    scope: {},
    specificity: 0,
    check: { fn: 'logo.clearspace', params: { multiple: 1 } },
  };

  it('ignores rule ordering', () => {
    const a = rulesetHash({ rules: [rule, { ...rule, key: 'color.palette' }] });
    const b = rulesetHash({ rules: [{ ...rule, key: 'color.palette' }, rule] });
    expect(a).toBe(b);
  });

  it('ignores cosmetic fields that cannot change a verdict', () => {
    const withNoise = { ...rule, id: 'row-id', createdAt: new Date().toISOString(), label: 'v7' };
    expect(rulesetHash({ rules: [withNoise] })).toBe(rulesetHash({ rules: [rule] }));
  });

  it('changes when a threshold changes', () => {
    const tightened = { ...rule, check: { fn: 'logo.clearspace', params: { multiple: 1.5 } } };
    expect(rulesetHash({ rules: [tightened] })).not.toBe(rulesetHash({ rules: [rule] }));
  });

  it('changes when the scoring config changes', () => {
    expect(rulesetHash({ rules: [rule], scoringConfig: { passThreshold: 90 } })).not.toBe(
      rulesetHash({ rules: [rule], scoringConfig: { passThreshold: 85 } }),
    );
  });

  it('is stable across repeated calls', () => {
    expect(rulesetHash({ rules: [rule] })).toBe(rulesetHash({ rules: [rule] }));
  });
});

describe('helpers', () => {
  it('hashObject is order-insensitive', () => {
    expect(hashObject({ a: 1, b: 2 })).toBe(hashObject({ b: 2, a: 1 }));
  });

  it('transformHash is short enough for varchar(80) and stable', () => {
    const h = transformHash({ width: 512, format: 'webp' });
    expect(h).toHaveLength(40);
    expect(h).toBe(transformHash({ format: 'webp', width: 512 }));
  });

  it('promptHash binds template and variables together', () => {
    expect(promptHash('t', { a: 1 })).not.toBe(promptHash('t', { a: 2 }));
    expect(promptHash('t', { a: 1 })).toBe(promptHash('t', { a: 1 }));
  });

  it('peppered api key hashing depends on the pepper', () => {
    expect(hashApiKey('bl_live_x', 'pepper-a')).not.toBe(hashApiKey('bl_live_x', 'pepper-b'));
    expect(hashApiKey('bl_live_x', 'pepper-a')).toBe(hashApiKey('bl_live_x', 'pepper-a'));
  });

  it('generateApiKey emits a displayable prefix and a unique secret', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext.startsWith('bl_live_')).toBe(true);
    expect(a.prefix).toHaveLength(16);
    expect(a.plaintext.startsWith(a.prefix)).toBe(true);
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  it('safeEqual tolerates length mismatch without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
