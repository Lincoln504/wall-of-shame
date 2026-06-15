import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/utils.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in results', async () => {
    const items = [10, 20, 30, 40, 5];
    const out = await mapWithConcurrency(items, 2, async (n) => {
      await new Promise(r => setTimeout(r, n));
      return n * 2;
    });
    expect(out.map(r => (r.ok ? r.value : null))).toEqual([20, 40, 60, 80, 10]);
  });

  it('isolates failures — one rejection does not abort the others', async () => {
    const items = [1, 2, 3, 4];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out[0]).toEqual({ ok: true, value: 1 });
    expect(out[1]!.ok).toBe(false);
    expect(out[2]).toEqual({ ok: true, value: 3 });
    expect(out[3]).toEqual({ ok: true, value: 4 });
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    const out = await mapWithConcurrency([], 4, async () => 1);
    expect(out).toEqual([]);
  });
});
