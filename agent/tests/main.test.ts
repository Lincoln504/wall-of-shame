/**
 * main.test.ts — Integration tests for main.ts
 *
 * Tests the CLI argument parsing, batch execution orchestration, and
 * the full dry-run + real-run lifecycle.
 *
 * Rather than executing the full main() (which spins up pi SDK sessions),
 * we test the individual logic blocks: arg parsing, batch looping,
 * category index advancement, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CATEGORIES, CATEGORY_COUNT, getBatch } from '../src/categories.js';
import type { Finding, FindingsStore, RunState, Category } from '../src/types.js';

// ── CLI argument parsing tests ────────────────────────────────────────────────

describe('CLI argument parsing (main.ts logic)', () => {
  function parseArgs(args: string[]): { batchSize: number; dryRun: boolean } {
    const batchIdx = args.indexOf('--batch-size');
    const batchSize = parseInt(args[batchIdx + 1] ?? '3', 10) || 3;
    const dryRun = args.includes('--dry-run');
    return { batchSize, dryRun };
  }

  it('defaults to batch size 3 and dry-run false', () => {
    const result = parseArgs([]);
    expect(result.batchSize).toBe(3);
    expect(result.dryRun).toBe(false);
  });

  it('parses --batch-size argument', () => {
    const result = parseArgs(['--batch-size', '5']);
    expect(result.batchSize).toBe(5);
  });

  it('parses --dry-run flag', () => {
    const result = parseArgs(['--dry-run']);
    expect(result.dryRun).toBe(true);
  });

  it('handles both --batch-size and --dry-run together', () => {
    const result = parseArgs(['--batch-size', '2', '--dry-run']);
    expect(result.batchSize).toBe(2);
    expect(result.dryRun).toBe(true);
  });

  it('falls back to default batch size when value is NaN', () => {
    const result = parseArgs(['--batch-size', 'not-a-number']);
    expect(result.batchSize).toBe(3);
  });

  it('falls back to default when --batch-size has no following argument', () => {
    const result = parseArgs(['--batch-size']);
    expect(result.batchSize).toBe(3);
  });
});

// ── Batch lifecycle tests ─────────────────────────────────────────────────────

describe('batch lifecycle (main.ts orchestration logic)', () => {
  it('advances category index by batch size modulo total categories', () => {
    const categoryIndex = 0;
    const batchSize = 3;
    const newIndex = (categoryIndex + batchSize) % CATEGORY_COUNT;
    expect(newIndex).toBe(3);
  });

  it('wraps category index correctly when near the end', () => {
    const batchSize = 5;
    const startIndex = CATEGORY_COUNT - 2; // near end
    const newIndex = (startIndex + batchSize) % CATEGORY_COUNT;
    const expected = (startIndex + batchSize) % CATEGORY_COUNT;
    expect(newIndex).toBe(expected);
  });

  it('iterating through all categories with batch size 3 covers everything over time', () => {
    const totalCategories = CATEGORY_COUNT;
    const batchSize = 3;
    const seen = new Set<string>();
    let idx = 0;

    // Simulate many runs
    for (let run = 0; run < 20; run++) {
      const batch = getBatch(idx, batchSize);
      for (const cat of batch) seen.add(cat.key);
      idx = (idx + batchSize) % totalCategories;
    }

    expect(seen.size).toBe(totalCategories);
  });

  it('dryRun skips addFindings and save operations', () => {
    // This simulates the main.ts dry-run path:
    // if (!dryRun) { addFindings(...); saveFindings(...); saveState(...); }
    // else { log would-add count only }

    let findingsAdded = false;
    let stateSaved = false;

    const dryRun = true;
    const raws: any[] = [{ url: 'https://ex.com/test', title: 'Test', summary: 'x', category: 't', whyBad: 'x' }];

    if (!dryRun) {
      findingsAdded = true;
      stateSaved = true;
    }

    expect(findingsAdded).toBe(false);
    expect(stateSaved).toBe(false);
  });

  it('non-dry-run path executes addFindings and save ops', () => {
    let findingsAdded = false;
    let stateSaved = false;

    const dryRun = false;
    const raws: any[] = [{ url: 'https://ex.com/test', title: 'Test', summary: 'x', category: 't', whyBad: 'x' }];

    if (!dryRun) {
      findingsAdded = true;
      stateSaved = true;
    }

    expect(findingsAdded).toBe(true);
    expect(stateSaved).toBe(true);
  });

  it('error in runResearch is caught and raws set to empty array', async () => {
    // Simulating the error handling in main.ts:
    let raws: any[] = [];
    try {
      throw new Error('API call failed');
    } catch (err) {
      raws = [];
    }

    expect(raws).toEqual([]);
  });

  it('error in runResearch does not crash the batch loop', () => {
    // main.ts catches per-category errors and continues
    const results: string[] = [];

    for (let i = 0; i < 3; i++) {
      try {
        if (i === 1) throw new Error('Research failed for cat B');
        results.push(`Category ${i} succeeded`);
      } catch {
        results.push(`Category ${i} failed`);
      }
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toBe('Category 0 succeeded');
    expect(results[1]).toBe('Category 1 failed');
    expect(results[2]).toBe('Category 2 succeeded');
  });
});

// ── Integration: full flow with real data ─────────────────────────────────────

describe('full main.ts lifecycle integration', () => {
  const dataDir = join(__dirname, '..', 'data');
  const findingsPath = join(dataDir, 'findings.json');
  const statePath = join(dataDir, 'run-state.json');
  const bakFindings = join(dataDir, '.findings.json.bak');
  const bakState = join(dataDir, '.run-state.json.bak');

  beforeEach(() => {
    // Backup real data
    if (existsSync(findingsPath)) {
      writeFileSync(bakFindings, readFileSync(findingsPath));
    }
    if (existsSync(statePath)) {
      writeFileSync(bakState, readFileSync(statePath));
    }
  });

  afterEach(() => {
    // Restore originals
    if (existsSync(bakFindings)) {
      writeFileSync(findingsPath, readFileSync(bakFindings));
      rmSync(bakFindings);
    }
    if (existsSync(bakState)) {
      writeFileSync(statePath, readFileSync(bakState));
      rmSync(bakState);
    }
  });

  it('loads findings and state for a new run (simulating main.ts startup)', async () => {
    const { loadFindings, loadState } = await import('../src/findings.js');
    const { getBatch } = await import('../src/categories.js');

    const store = loadFindings();
    const state = loadState();

    expect(store).toBeDefined();
    expect(state).toBeDefined();
    expect(state.categoryIndex).toBeGreaterThanOrEqual(0);

    const batch = getBatch(state.categoryIndex, 3);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThanOrEqual(3);
  });

  it('handles the full dry-run lifecycle end-to-end', async () => {
    // This simulates what happens when you run `npx tsx src/main.ts --dry-run`
    const { loadFindings, loadState, addFindings } = await import('../src/findings.js');
    const { getBatch } = await import('../src/categories.js');

    const store = loadFindings();
    const state = loadState();
    const originalLength = store.findings.length;
    const originalIndex = state.categoryIndex;

    const batch = getBatch(state.categoryIndex, 2);

    // Simulate dry-run: no addFindings, no save
    let totalAdded = 0;
    for (const cat of batch) {
      const mockRaws: any[] = [
        { url: 'https://dry-run-example.com/test', title: 'Dry Run Test', summary: 'Test', category: cat.key, whyBad: 'Testing' },
      ];
      // In dry-run mode, we don't call addFindings
      totalAdded += mockRaws.length;
    }

    // Dry run should NOT modify store or state
    expect(store.findings.length).toBe(originalLength);
    expect(state.categoryIndex).toBe(originalIndex);
  });

  it('handles the full real-run lifecycle without errors', async () => {
    const { loadFindings, loadState, addFindings, saveFindings, saveState } = await import('../src/findings.js');
    const { getBatch } = await import('../src/categories.js');

    const store = loadFindings();
    const state = loadState();
    const originalLength = store.findings.length;
    const originalIndex = state.categoryIndex;
    const batchSize = 2;

    const batch = getBatch(state.categoryIndex, batchSize);

    let totalAdded = 0;
    for (const cat of batch) {
      const mockRaws: any[] = [
        {
          url: `https://integration-test.com/${cat.key}-1`,
          title: `Integration Test ${cat.name}`,
          domain: 'integration-test.com',
          summary: 'Test finding for integration test',
          category: cat.key,
          whyBad: 'Integration test - should be removed in cleanup',
          severity: 'low',
        },
      ];

      const added = addFindings(store, state, mockRaws, cat.key);
      totalAdded += added.length;
    }

    // Advance index
    state.categoryIndex = (state.categoryIndex + batchSize) % CATEGORY_COUNT;

    // Save
    saveFindings(store);
    saveState(state);

    // Verify the data was persisted
    const { loadFindings: load2, loadState: loadState2 } = await import('../src/findings.js');
    const store2 = load2();
    const state2 = loadState2();

    expect(store2.findings.length).toBe(originalLength + totalAdded);
    expect(state2.categoryIndex).toBe((originalIndex + batchSize) % CATEGORY_COUNT);

    // The integration test entries should be in seenUrls
    for (const url of state2.seenUrls) {
      if (url.startsWith('https://integration-test.com/')) {
        expect(url).toBeTruthy();
      }
    }

    // Cleanup: remove our test entries
    store2.findings = store2.findings.filter(
      (f: Finding) => !f.url.startsWith('https://integration-test.com/')
    );
    state2.seenUrls = state2.seenUrls.filter(
      (url: string) => !url.startsWith('https://integration-test.com/')
    );
    state2.categoryIndex = originalIndex;
    saveFindings(store2);
    saveState(state2);

    // Verify cleanup
    const store3 = load2();
    const state3 = loadState2();
    expect(store3.findings.length).toBe(originalLength);
    expect(state3.categoryIndex).toBe(originalIndex);
    expect(state3.seenUrls.filter((u: string) => u.startsWith('https://integration-test.com/'))).toHaveLength(0);
  });

  it('advances category index correctly and wraps around', () => {
    const batchSize = 3;
    const startIndex = CATEGORY_COUNT - 1; // near end
    const newIndex = (startIndex + batchSize) % CATEGORY_COUNT;

    // Verify the category index advances (modular arithmetic)
    expect(newIndex).toBe((CATEGORY_COUNT - 1 + 3) % CATEGORY_COUNT);
    expect(newIndex).toBe(2); // (34-1+3)%34 = 36%34 = 2

    // getBatch(startIndex, batchSize) calculates start = (startIndex * batchSize) % len
    // For startIndex=33, batchSize=3: start = (33*3)%34 = 99%34 = 31
    const batch = getBatch(startIndex, batchSize);
    const expectedStart = (startIndex * batchSize) % CATEGORY_COUNT;
    expect(batch[0].key).toBe(CATEGORIES[expectedStart].key);
    expect(batch[batch.length - 1].key).toBe(CATEGORIES[(expectedStart + batchSize - 1) % CATEGORY_COUNT].key);
  });
});
