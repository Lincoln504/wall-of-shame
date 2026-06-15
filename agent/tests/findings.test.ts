import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FindingsStore, RunState } from '../src/types.js';

vi.mock('@lincoln504/pi-research', () => ({
  verifyUrl: vi.fn().mockResolvedValue(true),
  initResearchSDK: vi.fn(),
  shutdownResearchSDK: vi.fn()
}));

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

    const added = await mod.addFindings(store, state, 'test_category', raws, 'test_query', alwaysReachable);

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
  });

  it('deduplicates by URL against seenUrls and existing findings, recording all processed URLs as seen', async () => {
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
          severity: 'medium',
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

    const added = await mod.addFindings(store, state, 'test', raws, 'test_query', alwaysReachable);

    expect(added).toHaveLength(1);
    expect(added[0].url).toBe('https://example.com/new');
    expect(store.findings).toHaveLength(2);
    // All three processed URLs are now recorded as seen (the pre-existing
    // 'seen', the duplicate 'dup' which was a finding but not yet in seenUrls,
    // and the newly added 'new') so none are re-researched next round. New
    // entries are stored canonicalized (no protocol/www).
    expect(state.seenUrls['test']).toHaveLength(3);
    expect(state.seenUrls['test']).toEqual(
      expect.arrayContaining(['example.com/dup', 'example.com/new']),
    );
  });

  it('deduplicates the same URL across categories (global, one entry per URL on the wall)', async () => {
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
          severity: 'medium',
          foundAt: '2025-01-01T00:00:00.000Z',
          researchQuery: 'q',
        },
      ],
    };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: { cat1: ['https://example.com/shared'] }, queryHistory: {} };
    const raws = [
      { url: 'https://example.com/shared', title: 'Shared', summary: 'y', category: 'cat2', whyBad: 'y' },
    ];

    const added = await mod.addFindings(store, state, 'cat2', raws, 'test_query', alwaysReachable);

    // A URL already on the wall under cat1 is NOT re-added under cat2.
    expect(added).toHaveLength(0);
    expect(store.findings).toHaveLength(1);
  });

  it('robustly deduplicates adversarial URL variations', async () => {
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
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: { cat1: ['https://www.example.com/page?utm_source=test'] }, queryHistory: {} };
    
    const raws = [
      { url: 'http://example.com/page?ref=social', title: 'Duplicate URL', summary: 'y', category: 'cat1', whyBad: 'y' },
    ];

    const added = await mod.addFindings(store, state, 'cat1', raws, 'test_query', alwaysReachable);
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

    const added = await mod.addFindings(store, state, 'test', raws, 'q', alwaysReachable);

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

    const added = await mod.addFindings(store, state, 't', raws, 'q', alwaysReachable);

    expect(added[0].severity).toBe('medium');
    expect(added[1].severity).toBe('medium');
    expect(added[2].severity).toBe('low');
  });

  it('sorts findings newest first after adding', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };

    const raws1 = [{ url: 'https://ex.com/oldest', title: 'Oldest', summary: '', category: 't', whyBad: 'x' }];
    await mod.addFindings(store, state, 't', raws1, 'q1', alwaysReachable);
    await new Promise(r => setTimeout(r, 10));
    const raws2 = [{ url: 'https://ex.com/newest', title: 'Newest', summary: '', category: 't', whyBad: 'x' }];
    await mod.addFindings(store, state, 't', raws2, 'q2', alwaysReachable);

    expect(store.findings).toHaveLength(2);
    expect(store.findings[0].url).toBe('https://ex.com/newest');
    expect(store.findings[1].url).toBe('https://ex.com/oldest');
  });

  it('extracts domain from URL when domain is not provided', async () => {
    const store: FindingsStore = { lastUpdated: '', totalFindings: 0, findings: [] };
    const state: RunState = { lastRun: '', categoryIndex: 0, seenUrls: {}, queryHistory: {} };
    const raws = [{ url: 'https://www.somesite.com/article', title: 'No domain', summary: '', category: 't', whyBad: 'x' }];

    const added = await mod.addFindings(store, state, 't', raws, 'q', alwaysReachable);
    expect(added[0].domain).toBe('www.somesite.com');
  });
});

describe('findings persistence', () => {
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

  it('round-trips findings through save and load', () => {
    const store: FindingsStore = {
      lastUpdated: '2025-06-01T00:00:00.000Z',
      totalFindings: 1,
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
      ],
    };

    mod.saveFindings(store);
    const loaded = mod.loadFindings();
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.findings[0].id).toBe('test-id-1');
  });

  it('migrates legacy flat seenUrls array to global_legacy key', () => {
    const legacyState = {
      lastRun: '2025-01-01T00:00:00.000Z',
      categoryIndex: 0,
      seenUrls: ['https://old.com/1'],
      queryHistory: { 'old query': '2025-01-01T00:00:00.000Z' }
    };
    writeState(JSON.stringify(legacyState));

    const loaded = mod.loadState();
    expect(loaded.seenUrls['global_legacy']).toContain('https://old.com/1');
    expect(loaded.queryHistory['migrated_legacy']).toBeDefined();
  });
});

describe('findings full lifecycle (integration)', () => {
  let mod: Awaited<ReturnType<typeof importFindingsModule>>;

  beforeAll(async () => {
    mod = await importFindingsModule();
  });

  beforeEach(() => {
    if (existsSync(findingsPath)) rmSync(findingsPath);
    if (existsSync(statePath)) rmSync(statePath);
  });

  it('load → addFindings → save → load produces consistent data', async () => {
    const store = mod.loadFindings();
    const state = mod.loadState();
    const raws = [{ url: 'https://ex.com/harmful', title: 'Harmful', summary: 'Bad stuff', category: 'cat1', whyBad: 'reason', severity: 'high' }];
    await mod.addFindings(store, state, 'cat1', raws, 'test_query', alwaysReachable);
    mod.saveFindings(store);
    mod.saveState(state);

    const store2 = mod.loadFindings();
    expect(store2.findings).toHaveLength(1);
    expect(store2.findings[0].url).toBe('https://ex.com/harmful');
  });
});
