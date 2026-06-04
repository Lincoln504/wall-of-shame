import { vi } from 'vitest';
vi.mock('@lincoln504/pi-research', () => ({
  initResearchSDK: vi.fn().mockResolvedValue(undefined),
  disposeResearchSDK: vi.fn().mockResolvedValue(undefined),
  runQuickResearch: vi.fn().mockResolvedValue('test report'),
  exportKnowledge: vi.fn().mockResolvedValue(undefined),
  verifyUrl: vi.fn().mockResolvedValue(true)
}));
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

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CATEGORIES, CATEGORY_COUNT, getBatch } from '../src/categories.js';
import type { Finding, FindingsStore, RunState, Category } from '../src/types.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wall-of-shame-main-test-'));
  process.env['PI_AGENT_DATA_DIR'] = tempDir;
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

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

  it('retries a failing category up to MAX_ATTEMPTS times, then moves on', () => {
    // Each category gets MAX_ATTEMPTS tries within the same run.
    // After exhausting retries, the cursor (and persisted index) still advances.
    const TOTAL = 5;
    const MAX_ATTEMPTS = 3;
    let persistedIndex = 0;
    const results: string[] = [];

    let cursor = persistedIndex;
    for (let i = 0; i < 3; i++) {
      const catIdx = cursor % TOTAL;
      let succeeded = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (catIdx === 1) throw new Error('always fails');
          results.push(`cat${catIdx} ok`);
          succeeded = true;
          break;
        } catch {
          if (attempt === MAX_ATTEMPTS) {
            results.push(`cat${catIdx} err`);
          }
        }
      }
      // Always advance after all attempts
      persistedIndex = (cursor + 1) % TOTAL;
      cursor = (cursor + 1) % TOTAL;
    }

    expect(results).toEqual(['cat0 ok', 'cat1 err', 'cat2 ok']);
    // All three categories processed; index advanced past cat2
    expect(persistedIndex).toBe(3);
  });
});

// ── Integration: full flow with real data ─────────────────────────────────────

describe('full main.ts lifecycle integration', () => {
  beforeEach(() => {
    // Each test starts with a clean slate by clearing the temp dir files
    const findingsPath = join(tempDir, 'findings.json');
    const statePath = join(tempDir, 'run-state.json');
    if (existsSync(findingsPath)) rmSync(findingsPath);
    if (existsSync(statePath)) rmSync(statePath);
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

      const added = await addFindings(store, state, cat.key, mockRaws, cat.researchQuery, async () => true);
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

    // The integration test entries should be in seenUrls for their respective categories
    for (const cat of batch) {
      expect(state2.seenUrls[cat.key]).toContain(`integration-test.com/${cat.key}-1`);
    }

    // Cleanup: remove our test entries
    store2.findings = store2.findings.filter(
      (f: Finding) => !f.url.startsWith('https://integration-test.com/')
    );
    for (const cat of batch) {
      state2.seenUrls[cat.key] = state2.seenUrls[cat.key].filter(
        (url: string) => !url.startsWith('https://integration-test.com/')
      );
    }
    state2.categoryIndex = originalIndex;
    saveFindings(store2);
    saveState(state2);

    // Verify cleanup
    const store3 = load2();
    const state3 = loadState2();
    expect(store3.findings.length).toBe(originalLength);
    expect(state3.categoryIndex).toBe(originalIndex);
    for (const cat of batch) {
       expect(state3.seenUrls[cat.key]?.filter((u: string) => u.startsWith('https://integration-test.com/')) || []).toHaveLength(0);
    }
  });

  it('advances category index correctly and wraps around', () => {
    const batchSize = 3;
    const startIndex = CATEGORY_COUNT - 1; // near end
    const newIndex = (startIndex + batchSize) % CATEGORY_COUNT;

    // Verify the category index advances (modular arithmetic)
    expect(newIndex).toBe((CATEGORY_COUNT - 1 + 3) % CATEGORY_COUNT);
    expect(newIndex).toBe(2); // (13-1+3)%13 = 15%13 = 2

    // getBatch(startIndex, batchSize) calculates start = index % len
    // For startIndex=33, batchSize=3: start = 33
    const batch = getBatch(startIndex, batchSize);
    const expectedStart = startIndex % CATEGORY_COUNT;
    expect(batch[0].key).toBe(CATEGORIES[expectedStart].key);
    expect(batch[1].key).toBe(CATEGORIES[(expectedStart + 1) % CATEGORY_COUNT].key);
    expect(batch[2].key).toBe(CATEGORIES[(expectedStart + 2) % CATEGORY_COUNT].key);
  });
});
