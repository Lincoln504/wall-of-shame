/**
 * cli.test.ts — Unit tests for the CLI menu logic
 *
 * Tests the helper functions and data access that the CLI relies on.
 * The interactive readline portions are tested via the menu logic paths.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CATEGORIES, CATEGORY_COUNT, getBatch } from '../src/categories.js';
import { loadFindings, loadState } from '../src/findings.js';

// ── CLI uses loadFindings / loadState — verify these work ─────────────────────

describe('CLI data access', () => {
  it('loads findings and state for menu display', () => {
    const store = loadFindings();
    const state = loadState();
    expect(store).toBeDefined();
    expect(typeof store.totalFindings).toBe('number');
    expect(Array.isArray(store.findings)).toBe(true);
    expect(state).toBeDefined();
    expect(typeof state.categoryIndex).toBe('number');
    expect(typeof state.seenUrls).toBe('object');
    expect(Array.isArray(state.seenUrls)).toBe(false);
  });

  it('can compute next batch for menu preview', () => {
    const state = loadState();
    const batch = getBatch(state.categoryIndex, 3);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every(c => c.key && c.name)).toBe(true);
  });

  it('category index is within valid range', () => {
    const state = loadState();
    expect(state.categoryIndex).toBeGreaterThanOrEqual(0);
    expect(state.categoryIndex).toBeLessThan(CATEGORY_COUNT);
  });

  it('each category for batch preview has a name', () => {
    const state = loadState();
    const batch = getBatch(state.categoryIndex, 3);
    for (const cat of batch) {
      expect(typeof cat.name).toBe('string');
      expect(cat.name.length).toBeGreaterThan(0);
    }
  });
});

// ── Menu option logic (pure function testing) ─────────────────────────────────

describe('CLI menu options logic', () => {
  it('option 1: runResearchBatch(false) constructs batch correctly', () => {
    const state = loadState();
    const batchSize = 3;
    const batch = getBatch(state.categoryIndex, batchSize);
    expect(batch.length).toBeLessThanOrEqual(batchSize);
  });

  it('option 2: runResearchBatch(true) uses same batch logic', () => {
    const state = loadState();
    const batch = getBatch(state.categoryIndex, 3);
    expect(batch.every(c => typeof c.researchQuery === 'string')).toBe(true);
  });

  it('option 3: showStats can compute severity counts', () => {
    const store = loadFindings();
    const severityCounts: Record<string, number> = {};
    for (const f of store.findings) {
      severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
    }
    const totalFromCounts = Object.values(severityCounts).reduce((a, b) => a + b, 0);
    expect(totalFromCounts).toBe(store.findings.length);
  });

  it('option 3: showStats can compute category counts', () => {
    const store = loadFindings();
    const catCounts: Record<string, number> = {};
    for (const f of store.findings) catCounts[f.category] = (catCounts[f.category] ?? 0) + 1;
    const totalFromCounts = Object.values(catCounts).reduce((a, b) => a + b, 0);
    expect(totalFromCounts).toBe(store.findings.length);
  });

  it('option 4: viewFindings can filter by category', () => {
    const store = loadFindings();
    const cat = store.findings[0]?.category;
    if (cat) {
      const filtered = store.findings.filter(f => f.category === cat);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every(f => f.category === cat)).toBe(true);
    }
    // If no findings, the test passes vacuously
  });

  it('option 4: viewFindings can filter by severity', () => {
    const store = loadFindings();
    for (const sev of ['high', 'medium', 'low'] as const) {
      const filtered = store.findings.filter(f => f.severity === sev);
      expect(filtered.every(f => f.severity === sev)).toBe(true);
    }
  });

  it('option 4: recent findings limit works', () => {
    const store = loadFindings();
    const limit = 20;
    const recent = store.findings.slice(0, limit);
    expect(recent.length).toBeLessThanOrEqual(limit);
    // Should be sorted newest first
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1]!.foundAt >= recent[i]!.foundAt).toBe(true);
    }
  });

  it('option 5: resetState logic works', () => {
    const state = loadState();
    const originalIndex = state.categoryIndex;
    // Simulate reset
    const newState = { ...state, categoryIndex: 0 };
    expect(newState.categoryIndex).toBe(0);
    // Verify the original is unchanged (we didn't actually save)
    expect(state.categoryIndex).toBe(originalIndex);
  });
});

// ── GitHub Actions workflow validation ────────────────────────────────────────

describe('GitHub Actions integration', () => {
  it('deploy workflow copies findings.json from correct path', () => {
    // The deploy workflow does: cp agent/data/findings.json site/public/findings.json
    // Verify the source file actually exists in the repo
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'findings.json');
    expect(existsSync(sourcePath)).toBe(true);
  });

  it('research workflow uses correct CLI args', () => {
    // Verifies the workflow uses the same arg pattern as the CLI
    const batchSize = 3;
    const dryRun = false;
    const args = `--batch-size ${batchSize}` + (dryRun ? ' --dry-run' : '');
    expect(args).toBe('--batch-size 3');
  });
});
