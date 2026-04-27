import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { Finding, FindingsStore, RunState } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');

function emptyStore(): FindingsStore {
  return { lastUpdated: new Date().toISOString(), totalFindings: 0, findings: [] };
}

function emptyState(): RunState {
  return { lastRun: new Date().toISOString(), categoryIndex: 0, seenUrls: [] };
}

export function loadFindings(): FindingsStore {
  if (!existsSync(FINDINGS_PATH)) return emptyStore();
  try {
    return JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')) as FindingsStore;
  } catch {
    return emptyStore();
  }
}

export function saveFindings(store: FindingsStore): void {
  store.lastUpdated = new Date().toISOString();
  store.totalFindings = store.findings.length;
  writeFileSync(FINDINGS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export function loadState(): RunState {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as RunState;
  } catch {
    return emptyState();
  }
}

export function saveState(state: RunState): void {
  state.lastRun = new Date().toISOString();
  // cap seenUrls at 5000 to avoid unbounded growth
  if (state.seenUrls.length > 5000) {
    state.seenUrls = state.seenUrls.slice(-5000);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

export interface RawFinding {
  url: string;
  title: string;
  domain?: string;
  summary: string;
  category: string;
  subcategory?: string;
  whyBad: string;
  severity?: string;
}

export function addFindings(
  store: FindingsStore,
  state: RunState,
  raws: RawFinding[],
  researchQuery: string,
): Finding[] {
  const seenSet = new Set(state.seenUrls);
  const existing = new Set(store.findings.map(f => f.url));
  const added: Finding[] = [];

  for (const raw of raws) {
    if (!raw.url || !raw.url.startsWith('http')) continue;
    if (seenSet.has(raw.url) || existing.has(raw.url)) continue;

    const finding: Finding = {
      id: randomUUID(),
      url: raw.url,
      title: raw.title || 'Untitled',
      domain: raw.domain || new URL(raw.url).hostname,
      summary: raw.summary || '',
      category: raw.category || 'uncategorized',
      subcategory: raw.subcategory,
      whyBad: raw.whyBad || '',
      severity: (['low', 'medium', 'high'].includes(raw.severity ?? '') ? raw.severity : 'medium') as Finding['severity'],
      foundAt: new Date().toISOString(),
      researchQuery,
    };

    store.findings.push(finding);
    state.seenUrls.push(raw.url);
    existing.add(raw.url);
    added.push(finding);
  }

  // sort newest first
  store.findings.sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  return added;
}
