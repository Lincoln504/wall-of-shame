import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { Finding, FindingsStore, RunState } from './types.js';

// Status codes that mean the URL exists even if we can't read the body.
// 401 excluded: sites like WSJ return 401 for ALL bot requests (real or fake)
// so it cannot signal existence.
const REACHABLE_CODES = new Set([200, 301, 302, 303, 307, 308, 403, 406, 429]);

// Strings present in bot-challenge bodies (Imperva/Incapsula, Cloudflare, DataDome).
// These sites return HTTP 200 but serve a JS challenge instead of real content,
// making 200 meaningless for existence detection.
const BOT_CHALLENGE_MARKERS = [
  '_Incapsula_Resource',   // Imperva
  'captcha-delivery.com',  // DataDome
  'cf-chl-bypass',         // Cloudflare
  '__cf_chl_',             // Cloudflare
];

export async function verifyUrl(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      // GET (not HEAD) so we can inspect the body for bot-challenge markers
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wall-of-shame-bot/1.0)' },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!REACHABLE_CODES.has(res.status)) return false;

    // For 200 responses, read a small chunk to detect bot challenge pages
    if (res.status === 200) {
      const chunk = await res.text().then(t => t.slice(0, 4096));
      if (BOT_CHALLENGE_MARKERS.some(m => chunk.includes(m))) return false;
    }

    return true;
  } catch {
    return false;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');
const DATA_DIR = process.env['PI_AGENT_DATA_DIR'] || DEFAULT_DATA_DIR;
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
  mkdirSync(DATA_DIR, { recursive: true });
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
  mkdirSync(DATA_DIR, { recursive: true });
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

export async function addFindings(
  store: FindingsStore,
  state: RunState,
  raws: RawFinding[],
  researchQuery: string,
  log?: (msg: string) => void,
  verify: (url: string) => Promise<boolean> = verifyUrl,
): Promise<Finding[]> {
  const seenSet = new Set(state.seenUrls);
  const existing = new Set(store.findings.map(f => f.url));
  const added: Finding[] = [];

  for (const raw of raws) {
    if (!raw.url || !raw.url.startsWith('http')) continue;
    if (seenSet.has(raw.url) || existing.has(raw.url)) continue;

    const reachable = await verify(raw.url);
    if (!reachable) {
      log?.(`  [skip] URL unreachable (404/timeout): ${raw.url}`);
      // Still mark as seen so we don't retry it next run
      state.seenUrls.push(raw.url);
      seenSet.add(raw.url);
      continue;
    }

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
