import { describe, expect, it } from 'vitest';
import { runBounded } from './runtime';

describe('runBounded — per-pool concurrency', () => {
  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await runBounded(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('completes the whole batch even when one job throws, then rethrows', async () => {
    // One poisoned job must not stop its siblings from being acknowledged;
    // rethrowing afterwards still lets pg-boss apply the retry policy.
    const completed: number[] = [];
    await expect(
      runBounded([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        completed.push(n);
      }),
    ).rejects.toThrow('boom');
    expect(completed.sort()).toEqual([1, 3, 4]);
  });

  it('handles an empty batch', async () => {
    await expect(runBounded([], 4, async () => undefined)).resolves.toBeUndefined();
  });

  it('does not spawn more workers than there are items', async () => {
    let started = 0;
    await runBounded([1], 16, async () => {
      started += 1;
    });
    expect(started).toBe(1);
  });
});
