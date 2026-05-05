/**
 * findings.test.ts — Unit tests for findings.ts
 *
 * Tests the persistence layer (load/save), state management, and
 * the deduplication / addFindings business logic.
 *
 * Uses real filesystem in a temp directory — minimal mocking.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FindingsStore, RunState } from '../src/types.js';

// ── We'll monkey-patch the module's internal paths before importing ──

let tempDir: string;
let findingsPath: string;
let statePath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'wall-of-shame-test-'));
  process.env['PI_AGENT_DATA_DIR'] = tempDir;
  findingsPath = join(tempDir, 'findings.json');
  statePath = join(tempDir, 'run-state.json');
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function importFindingsModule() {
  const mod = await import('../src/findings.js');
  return mod;
}

// Helpers to directly write fixture files
function writeFindings(content: string) {
  writeFileSync(findingsPath, content, 'utf-8');
}

function writeState(content: string) {
  writeFileSync(statePath, content, 'utf-8');
}

function readFindings(): string {
  return readFileSync(findingsPath, 'utf-8');
}

function readState(): string {
  return readFileSync(statePath, 'utf-8');
}

// No-op URL verifier so tests never make real HTTP requests
const alwaysReachable = async (_url: string) => true;

// ── Pure function: addFindings ─────────────────────────────────────────────────

describe('addFindings', () => {
  let mod: Awaited<ReturnType<typeof importFindingsModule>>;

  beforeAll(async () => {
    mod = await importFindingsModule();
  });

  it('adds new findings from raw input', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [
      {
        url: 'https://example.com/harmful',
        title: 'Harmful Article',
        domain: 'example.com',
        summary: 'This article is bad',
        category: 'test_category',
        whyBad: 'It promotes harmful ideas',
        severity: 'high',
      },
    ];

    const added = await mod.addFindings(store, state, 'test_category', raws, 'test_query', undefined, alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      url: 'https://example.com/harmful',
      title: 'Harmful Article',
      domain: 'example.com',
      summary: 'This article is bad',
      category: 'test_category',
      whyBad: 'It promotes harmful ideas',
      severity: 'high',
      researchQuery: 'test_query',
    });
    expect(added[0].id).toBeDefined();
    expect(added[0].foundAt).toBeDefined();
    expect(store.findings).toHaveLength(1);
    expect(state.seenUrls['test_category']).toContain('example.com/harmful');
  });

  it('deduplicates by URL against both seenUrls and existing findings (scoped to category)', async () => {
    const store: FindingsStore = {
      lastUpdated: '',
      totalFindings: 1,
      findings: [
        {
          id: 'existing-id',
          url: 'https://example.com/dup',
          title: 'Existing',
          domain: 'example.com',
          summary: 'Already in store',
          category: 'test',
          whyBad: 'already tracked',
          severity: 'medium' as const,
          foundAt: '2025-01-01T00:00:00.000Z',
          researchQuery: 'old_query',
        },
      ],
    };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: { test: ['https://example.com/seen'] }, queryHistory: {} };
    const raws = [
      { url: 'https://example.com/dup', title: 'Duplicate', summary: '', category: 'test', whyBad: '' },        // in findings
      { url: 'https://example.com/seen', title: 'Seen', summary: '', category: 'test', whyBad: '' },           // in seenUrls
      { url: 'https://example.com/new', title: 'New', summary: 'Fresh', category: 'test', whyBad: 'new harmful content' }, // new
    ];

    const added = await mod.addFindings(store, state, 'test', raws, 'test_query', undefined, alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0].url).toBe('https://example.com/new');
    expect(store.findings).toHaveLength(2); // existing 1 + new 1
    expect(state.seenUrls['test']).toHaveLength(2); // original seen, new added (dup not re-added)
  });

  it('allows same URL in different categories', async () => {
    const store: FindingsStore = {
      lastUpdated: '',
      totalFindings: 1,
      findings: [
        {
          id: 'existing-id',
          url: 'https://example.com/shared',
          title: 'Existing in cat1',
          domain: 'example.com',
          summary: 'x',
          category: 'cat1',
          whyBad: 'x',
          severity: 'medium' as const,
          foundAt: '2025-01-01T00:00:00.000Z',
          researchQuery: 'q',
        },
      ],
    };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: { cat1: ['example.com/shared'] }, queryHistory: {} };
    const raws = [
      { url: 'https://example.com/shared', title: 'Shared', summary: 'y', category: 'cat2', whyBad: 'y' },
    ];

    const added = await mod.addFindings(store, state, 'cat2', raws, 'test_query', undefined, alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0].category).toBe('cat2');
    expect(store.findings).toHaveLength(2);
    expect(state.seenUrls['cat2']).toContain('example.com/shared');
  });

  it('robustly deduplicates adversarial URL variations (protocol, www, query params)', async () => {
    const store: FindingsStore = {
      lastUpdated: '',
      totalFindings: 0,
      findings: [
        {
          id: '1',
          url: 'https://www.example.com/page?utm_source=test',
          title: 'Existing',
          domain: 'example.com',
          summary: 'x',
          category: 'cat1',
          whyBad: 'x',
          severity: 'high',
          foundAt: '2025-01-01T00:00:00.000Z',
          researchQuery: 'q',
        },
      ],
    };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: { cat1: ['example.com/page?utm_source=test'] }, queryHistory: {} };
    
    const raws = [
      // Different protocol, no www, different tracking param -> Should be blocked
      { url: 'http://example.com/page?ref=social', title: 'Duplicate URL', summary: 'y', category: 'cat1', whyBad: 'y' },
    ];

    const added = await mod.addFindings(store, state, 'cat1', raws, 'test_query', undefined, alwaysReachable);
    expect(added).toHaveLength(0);
  });

  it('filters out items with invalid URLs', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [
      { url: '', title: 'Empty URL', summary: '', category: 'test', whyBad: '' },
      { url: 'not-a-url', title: 'Bad URL', summary: '', category: 'test', whyBad: '' },
      { url: 'ftp://files.com', title: 'FTP not http', summary: '', category: 'test', whyBad: '' },
      { url: 'https://valid.com/good', title: 'Valid', summary: 'yes', category: 'test', whyBad: 'reason' },
    ];

    const added = await mod.addFindings(store, state, 'test', raws, 'q', undefined, alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0].url).toBe('https://valid.com/good');
  });

  it('assigns default severity of medium when missing or invalid', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [
      { url: 'https://ex.com/a', title: 'No severity', summary: '', category: 't', whyBad: 'x' },
      { url: 'https://ex.com/b', title: 'Invalid severity', summary: '', category: 't', whyBad: 'x', severity: 'extreme' },
      { url: 'https://ex.com/c', title: 'Valid severity', summary: '', category: 't', whyBad: 'x', severity: 'low' },
    ];

    const added = await mod.addFindings(store, state, 't', raws, 'q', undefined, alwaysReachable);

    expect(added[0].severity).toBe('medium');
    expect(added[1].severity).toBe('medium');
    expect(added[2].severity).toBe('low');
  });

  it('sorts findings newest first after adding', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };

    // Add first batch
    const raws1 = [
      { url: 'https://ex.com/oldest', title: 'Oldest', summary: '', category: 't', whyBad: 'x' },
    ];
    await mod.addFindings(store, state, 't', raws1, 'q1', undefined, alwaysReachable);

    // Simulate time passing by using Date.now() — addFindings uses new Date().toISOString()
    // To guarantee different timestamps, we wait 10ms
    await new Promise(r => setTimeout(r, 10));

    const raws2 = [
      { url: 'https://ex.com/newest', title: 'Newest', summary: '', category: 't', whyBad: 'x' },
    ];
    await mod.addFindings(store, state, 't', raws2, 'q2', undefined, alwaysReachable);

    expect(store.findings).toHaveLength(2);
    expect(store.findings[0].url).toBe('https://ex.com/newest');
    expect(store.findings[1].url).toBe('https://ex.com/oldest');
  });

  it('extracts domain from URL when domain is not provided', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [
      { url: 'https://www.somesite.com/article', title: 'No domain', summary: '', category: 't', whyBad: 'x' },
    ];

    const added = await mod.addFindings(store, state, 't', raws, 'q', undefined, alwaysReachable);

    expect(added[0].domain).toBe('www.somesite.com');
  });

  it('handles empty raw array gracefully', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };

    const added = await mod.addFindings(store, state, 't', [], 'q', undefined, alwaysReachable);
    expect(added).toHaveLength(0);
    expect(store.findings).toHaveLength(0);
  });

  it('does not add duplicate URLs even if seen in same batch', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [
      { url: 'https://ex.com/dup-in-batch', title: 'First', summary: '', category: 't', whyBad: 'x' },
      { url: 'https://ex.com/dup-in-batch', title: 'Second (same URL)', summary: '', category: 't', whyBad: 'x' },
    ];

    const added = await mod.addFindings(store, state, 't', raws, 'q', undefined, alwaysReachable);
    expect(added).toHaveLength(1);
    expect(store.findings).toHaveLength(1);
  });
});

// ── File I/O: loadFindings / saveFindings / loadState / saveState ─────────────

describe('findings file I/O (integration)', () => {
  let mod: Awaited<ReturnType<typeof importFindingsModule>>;

  beforeAll(async () => {
    mod = await importFindingsModule();
  });

  beforeEach(() => {
    if (existsSync(findingsPath)) rmSync(findingsPath);
    if (existsSync(statePath)) rmSync(statePath);
  });

  it('loads empty store when findings.json is missing', () => {
    const store = mod.loadFindings();
    expect(store.findings).toEqual([]);
    expect(store.totalFindings).toBe(0);
  });

  it('loads empty store when findings.json is corrupted', () => {
    writeFileSync(findingsPath, '{invalid json', 'utf-8');
    const store = mod.loadFindings();
    expect(store.findings).toEqual([]);
  });

  it('round-trips findings through save and load', () => {
    const store: FindingsStore = {
      lastUpdated: '2025-06-01T00:00:00.000Z',
      totalFindings: 2,
      findings: [
        {
          id: 'test-id-1',
          url: 'https://ex.com/a',
          title: 'A',
          domain: 'ex.com',
          summary: 'First',
          category: 'cat1',
          whyBad: 'bad',
          severity: 'high',
          foundAt: '2025-06-01T00:00:00.000Z',
          researchQuery: 'q1',
        },
        {
          id: 'test-id-2',
          url: 'https://ex.com/b',
          title: 'B',
          domain: 'ex.com',
          summary: 'Second',
          category: 'cat2',
          whyBad: 'worse',
          severity: 'medium',
          foundAt: '2025-06-02T00:00:00.000Z',
          researchQuery: 'q2',
        },
      ],
    };

    mod.saveFindings(store);
    const loaded = mod.loadFindings();
    expect(loaded.findings).toHaveLength(2);
    expect(loaded.findings[0].id).toBe('test-id-1');
    expect(loaded.totalFindings).toBe(2);
    // saveFindings updates lastUpdated and totalFindings
    expect(loaded.lastUpdated).not.toBe('2025-06-01T00:00:00.000Z');
  });

  it('loads empty state when run-state.json is missing', () => {
    const state = mod.loadState();
    expect(state.categoryIndex).toBe(0);
    expect(state.seenUrls).toEqual({});
  });

  it('loads empty state when run-state.json is corrupted', () => {
    writeFileSync(statePath, 'not json', 'utf-8');
    const state = mod.loadState();
    expect(state.categoryIndex).toBe(0);
  });

  it('round-trips state through save and load', () => {
    const nowISO = new Date().toISOString();
    const state: RunState = {
      lastRun: '2025-06-01T00:00:00.000Z',
      categoryIndex: 3,
      seenUrls: { global: ['https://ex.com/a', 'https://ex.com/b'] },
      queryHistory: { cat1: { 'test query': nowISO } },
    };

    mod.saveState(state);
    const loaded = mod.loadState();
    expect(loaded.categoryIndex).toBe(3);
    expect(loaded.seenUrls['global']).toEqual(['ex.com/a', 'ex.com/b']);
    expect(loaded.queryHistory).toEqual({ cat1: { 'test query': nowISO } });
    // lastRun should be updated
    expect(loaded.lastRun).not.toBe('2025-06-01T00:00:00.000Z');
  });

  it('migrates legacy flat seenUrls array to global_legacy key', () => {
    const legacyState = {
      lastRun: '2025-01-01T00:00:00.000Z',
      categoryIndex: 0,
      seenUrls: ['https://old.com/1', 'https://old.com/2'],
      queryHistory: { 'old query': '2025-01-01T00:00:00.000Z' }
    };
    writeState(JSON.stringify(legacyState));

    const loaded = mod.loadState();
    expect(loaded.seenUrls['global_legacy']).toContain('https://old.com/1');
    expect(loaded.queryHistory['migrated_legacy']).toBeDefined();
    expect(loaded.queryHistory['migrated_legacy']['old query']).toBe('2025-01-01T00:00:00.000Z');
  });

  it('is idempotent when saving empty store', () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    mod.saveFindings(store);
    const loaded = mod.loadFindings();
    expect(loaded.findings).toEqual([]);
    expect(loaded.totalFindings).toBe(0);
  });
});

// ── Integration: addFindings + persistence together ──────────────────────────

describe('findings full lifecycle (integration)', () => {
  let mod: Awaited<ReturnType<typeof importFindingsModule>>;

  beforeAll(async () => {
    mod = await importFindingsModule();
  });

  beforeEach(() => {
    if (existsSync(findingsPath)) rmSync(findingsPath);
    if (existsSync(statePath)) rmSync(statePath);
  });

  afterEach(() => {
    if (existsSync(findingsPath)) rmSync(findingsPath);
    if (existsSync(statePath)) rmSync(statePath);
  });


  it('load → addFindings → save → load produces consistent data', async () => {
    const store = mod.loadFindings();
    const state = mod.loadState();
    expect(store.findings).toHaveLength(0);

    const raws = [
      { url: 'https://ex.com/harmful', title: 'Harmful', summary: 'Bad stuff', category: 'cat1', whyBad: 'reason', severity: 'high' },
    ];
    const added = await mod.addFindings(store, state, 'cat1', raws, 'test_query', undefined, alwaysReachable);
    expect(added).toHaveLength(1);

    mod.saveFindings(store);
    mod.saveState(state);

    const store2 = mod.loadFindings();
    expect(store2.findings).toHaveLength(1);
    expect(store2.findings[0].url).toBe('https://ex.com/harmful');

    const state2 = mod.loadState();
    expect(state2.seenUrls['cat1']).toContain('ex.com/harmful');
  });

  it('deduplication persists across load-save cycles', async () => {
    // First run
    const store = mod.loadFindings();
    const state = mod.loadState();
    const raws1 = [
      { url: 'https://ex.com/dup-test', title: 'First run', summary: 'x', category: 'c', whyBad: 'x' },
    ];
    await mod.addFindings(store, state, 'c', raws1, 'q1', undefined, alwaysReachable);
    mod.saveFindings(store);
    mod.saveState(state);

    // Second run (simulated new process)
    const store2 = mod.loadFindings();
    const state2 = mod.loadState();
    const raws2 = [
      { url: 'https://ex.com/dup-test', title: 'Second run (duplicate)', summary: 'x', category: 'c', whyBad: 'x' },
      { url: 'https://ex.com/new-item', title: 'New item', summary: 'y', category: 'c', whyBad: 'y' },
    ];
    const added = await mod.addFindings(store2, state2, 'c', raws2, 'q2', undefined, alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0].url).toBe('https://ex.com/new-item');
    expect(store2.findings).toHaveLength(2);
  });
});
