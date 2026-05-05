import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { Finding, FindingsStore, RunState } from './types.js';
import { FindingsStoreSchema, RunStateSchema } from './types.js';
import { normalizeUrl } from '@lincoln504/pi-research';
import { safeParseValidatedJson } from './utils.js';

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
export const DATA_DIR = process.env['PI_AGENT_DATA_DIR'] || DEFAULT_DATA_DIR;
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');

function emptyStore(): FindingsStore {
  return { lastUpdated: new Date().toISOString(), totalFindings: 0, findings: [] };
}

function emptyState(): RunState {
  return { lastRun: new Date().toISOString(), categoryIndex: 0, seenUrls: [], queryHistory: {} };
}

export function loadFindings(): FindingsStore {
  if (!existsSync(FINDINGS_PATH)) return emptyStore();
  try {
    const raw = readFileSync(FINDINGS_PATH, 'utf-8');
    return safeParseValidatedJson(FindingsStoreSchema, raw);
  } catch (err) {
    console.error(`  [warn] failed to load or validate findings: ${String(err)}`);
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
  const state = emptyState();
  if (!existsSync(STATE_PATH)) return state;
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const loaded = JSON.parse(raw);
    
    // Migration: if loaded.queryHistory is flat (values are strings), move them to a 'legacy' bucket or clear them
    let queryHistory = loaded.queryHistory || {};
    const firstVal = Object.values(queryHistory)[0];
    if (firstVal && typeof firstVal === 'string') {
      queryHistory = { migrated_legacy: queryHistory };
      loaded.queryHistory = queryHistory;
    }

    return safeParseValidatedJson(RunStateSchema, JSON.stringify(loaded));
  } catch (err) {
    console.error(`  [warn] failed to load or validate state: ${String(err)}`);
    return state;
  }
}

export function saveState(state: RunState): void {
  state.lastRun = new Date().toISOString();

  // Normalize and deduplicate seenUrls
  state.seenUrls = Array.from(new Set(state.seenUrls.map(u => normalizeUrl(u))));

  // Prune query history: remove items older than 30 days
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const prunedHistory: Record<string, Record<string, string>> = {};
  
  for (const [catKey, history] of Object.entries(state.queryHistory || {})) {
    const catPruned: Record<string, string> = {};
    let hasEntries = false;
    for (const [query, lastAt] of Object.entries(history)) {
      if (now - new Date(lastAt).getTime() < THIRTY_DAYS_MS) {
        catPruned[query] = lastAt;
        hasEntries = true;
      }
    }
    if (hasEntries) {
      prunedHistory[catKey] = catPruned;
    }
  }
  state.queryHistory = prunedHistory;

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

/**
 * Robust title normalization for deduplication.
 * Removes all non-alphanumeric chars and lowercases.
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function addFindings(
  store: FindingsStore,
  state: RunState,
  raws: RawFinding[],
  researchQuery: string,
  log?: (msg: string) => void,
  verify: (url: string) => Promise<boolean> = verifyUrl,
): Promise<Finding[]> {
  const seenSet = new Set(state.seenUrls.map(u => normalizeUrl(u)));
  const existingUrls = new Set(store.findings.map(f => normalizeUrl(f.url)));
  const existingTitles = new Set(store.findings.map(f => normalizeTitle(f.title)));
  const added: Finding[] = [];

  for (const raw of raws) {
    if (!raw.url || !raw.url.startsWith('http')) continue;
    
    const normalizedUrl = normalizeUrl(raw.url);
    const normalizedTitle = normalizeTitle(raw.title || '');

    if (seenSet.has(normalizedUrl) || existingUrls.has(normalizedUrl)) {
      log?.(`  [skip] URL already processed: ${raw.url}`);
      continue;
    }

    if (normalizedTitle && existingTitles.has(normalizedTitle)) {
      log?.(`  [skip] Title already exists: ${raw.title}`);
      // Still mark URL as seen to avoid re-verifying this specific URL
      state.seenUrls.push(normalizedUrl);
      seenSet.add(normalizedUrl);
      continue;
    }

    const reachable = await verify(raw.url);
    if (!reachable) {
      log?.(`  [skip] URL unreachable (404/timeout): ${raw.url}`);
      // Still mark as seen so we don't retry it next run
      state.seenUrls.push(normalizedUrl);
      seenSet.add(normalizedUrl);
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
    state.seenUrls.push(normalizedUrl);
    existingUrls.add(normalizedUrl);
    existingTitles.add(normalizedTitle);
    added.push(finding);
  }

  // sort newest first
  store.findings.sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  return added;
}
