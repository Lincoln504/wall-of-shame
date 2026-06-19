import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyUrl as sdkVerifyUrl } from '@lincoln504/pi-research';
import { Value } from 'typebox/value';
import type { Finding, FindingsStore, RunState } from './types.js';
import { FindingsStoreSchema, RunStateSchema } from './types.js';
import { canonicalizeUrl, normalizeTitle, normalizeWhyBad } from './utils.js';

// Export types for consumer use
export type { Finding, FindingsStore, RunState };

/**
 * Verify that a URL EXISTS (not that it is freely scrapeable).
 *
 * This is an existence gate, not a content gate: a live page behind Cloudflare,
 * auth, or rate-limiting (401/403/429/503) genuinely exists and must NOT be
 * discarded — its content was already captured during the research stage. Only a
 * true 404/410 or a DNS/connection failure means the URL is dead.
 *
 * The SDK's verifyUrl() does a full stealth-browser *scrape* and returns false on
 * a Cloudflare challenge, which wrongly rejects (and permanently bans) legitimate
 * sources. So we lead with a cheap HTTP probe and only fall back to the stealth
 * browser when the HTTP layer is inconclusive (network error / timeout).
 */
const VERIFY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function verifyUrl(url: string): Promise<boolean> {
  // 1. Cheap HTTP probe. Any response other than 404/410 proves the URL exists.
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': VERIFY_UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return false;
    return true; // 2xx/3xx/401/403/429/503/etc. → the resource exists
  } catch {
    // 2. HTTP layer inconclusive (DNS/timeout/reset). Get a second opinion from the
    //    SDK stealth browser before declaring the URL dead.
    try {
      return await sdkVerifyUrl(url);
    } catch {
      return false;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');
export const DATA_DIR = process.env['PI_AGENT_DATA_DIR'] || DEFAULT_DATA_DIR;
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');

/**
 * Atomically write a JSON file by writing to a temporary file and renaming it.
 */
function writeAtomic(path: string, data: any): void {
  const tmpPath = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

function emptyStore(): FindingsStore {
  return { lastUpdated: new Date().toISOString(), totalFindings: 0, findings: [] };
}

function emptyState(): RunState {
  return { lastRun: new Date().toISOString(), categoryIndex: 0, seenUrls: {}, queryHistory: {} };
}

export function loadFindings(): FindingsStore {
  if (!existsSync(FINDINGS_PATH)) return emptyStore();
  try {
    // The findings file is OUR own artifact, always written via JSON.stringify, so
    // it is strict JSON — parse it directly. Do NOT route it through the LLM-noise
    // extractor (safeParseJson): that locates JSON by brace/bracket counting, which
    // a whyBad value containing literal "[ ... ]" or braces will derail.
    const raw = readFileSync(FINDINGS_PATH, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (!Value.Check(FindingsStoreSchema, data)) {
      throw new Error('findings.json does not match FindingsStoreSchema');
    }
    return data as FindingsStore;
  } catch (err) {
    throw new Error(`CRITICAL: Findings file exists but is corrupted or invalid: ${String(err)}`);
  }
}

export function saveFindings(store: FindingsStore): void {
  store.lastUpdated = new Date().toISOString();
  store.totalFindings = store.findings.length;
  // Self-healing guard: normalize EVERY entry's whyBad on every write (idempotent on
  // already-clean text). This prevents a concurrent round that loaded a pre-clean
  // store from writing stale "Analysis: [...]" / fenced values back onto the wall.
  for (const f of store.findings) f.whyBad = normalizeWhyBad(f.whyBad);
  writeAtomic(FINDINGS_PATH, store);
}

export function loadState(): RunState {
  const state = emptyState();
  if (!existsSync(STATE_PATH)) return state;
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const loaded = JSON.parse(raw);
    
    // Migration: if loaded.queryHistory is flat (values are strings), move them to a 'legacy' bucket
    let queryHistory = loaded.queryHistory || {};
    if (Object.keys(queryHistory).length > 0) {
      const firstQueryVal = Object.values(queryHistory)[0];
      if (firstQueryVal && typeof firstQueryVal === 'string') {
        queryHistory = { migrated_legacy: queryHistory };
        loaded.queryHistory = queryHistory;
      }
    }
    
    // Migration: if loaded.seenUrls is an array, move it to a 'global_legacy' key
    let seenUrls = loaded.seenUrls || {};
    if (Array.isArray(seenUrls)) {
      seenUrls = { global_legacy: seenUrls };
    }
    
    // Canonicalize all loaded URLs
    for (const key of Object.keys(seenUrls)) {
      if (Array.isArray(seenUrls[key])) {
        seenUrls[key] = seenUrls[key].map(url => {
          try {
            return new URL(url).href;
          } catch {
            return url.toLowerCase().trim();
          }
        });
      }
    }

    return {
      lastRun: loaded.lastRun || state.lastRun,
      categoryIndex: typeof loaded.categoryIndex === 'number' ? loaded.categoryIndex : state.categoryIndex,
      seenUrls: seenUrls,
      queryHistory: queryHistory
    };
  } catch {
    throw new Error("CRITICAL: State file exists but is corrupted");
  }
}

export function saveState(state: RunState): void {
  state.lastRun = new Date().toISOString();
  writeAtomic(STATE_PATH, state);
}

export interface RawFinding {
  url: string;
  title: string;
  summary: string;
  category: string;
  whyBad: string;
  domain?: string;
  severity?: string;
  /** One sentence stating what the piece CONCLUDES that makes it a bad actor
   *  (not just its subject matter). Required by the extraction prompt; optional
   *  here so legacy entries without it still load. */
  directionalBasis?: string;
  /** Audit trail: most recent stage that reviewed this entry (reviewer then verifier). */
  verificationLog?: string;
  /** Scraped article text attached by the reviewer stage so the verifier can reuse
   *  it without re-fetching. Stripped before writing to findings.json. */
  _articleText?: string;
}

/**
 * Add newly discovered findings to the store and state.
 * Performs deep deduplication and stealth URL verification.
 */
// Stopwords dropped when building the semantic-duplicate key (significant words like nouns
// and years are kept, so different articles stay distinct).
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'at', 'by', 'with', 'from', 'is', 'are', 'as', 'that', 'this', 'its', 'their']);
/** Collapse a hostname to its registrable-ish root: inside.fifa.com & quality.fifa.com → fifa.com. */
function rootDomain(hostOrUrl: string): string {
  let h = (hostOrUrl || '').toLowerCase();
  try { h = new URL(h.includes('://') ? h : `https://${h}`).hostname; } catch { /* use as-is */ }
  h = h.replace(/^www\./, '');
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}
/** Root-domain-scoped key of a title's sorted significant words, so the SAME article republished
 *  at a different URL and with a reworded title (e.g. "X World Cup 2026" vs "X for the 2026 World
 *  Cup") collapses to one. URL-norm and exact-title-norm both miss these. */
function titleDomainKey(title: string, hostOrUrl: string): string {
  const words = (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w && !TITLE_STOPWORDS.has(w)).sort();
  return `${rootDomain(hostOrUrl)}|${words.join(' ')}`;
}

export async function addFindings(
  store: FindingsStore,
  state: RunState,
  categoryKey: string,
  newFindings: RawFinding[],
  researchQuery: string,
  log: (msg: string) => void,
  stats?: { duplicates: number; failedVerify: number; invalid: number }
): Promise<Finding[]> {
  const added: Finding[] = [];
  const bump = (k: 'duplicates' | 'failedVerify' | 'invalid') => { if (stats) stats[k]++; };

  if (!state.seenUrls[categoryKey]) {
    state.seenUrls[categoryKey] = [];
  }

  // Global dedup sets — the wall holds at most one entry per URL/title across ALL
  // categories and rounds. seenUrls is persisted per category, but a URL seen in
  // any category (or already a finding) blocks re-adding it anywhere.
  const globalSeen = new Set<string>();
  for (const urls of Object.values(state.seenUrls)) {
    for (const u of urls) globalSeen.add(canonicalizeUrl(u));
  }
  const existingUrls = new Set(store.findings.map(existing => canonicalizeUrl(existing.url)));
  const existingTitles = new Set(store.findings.map(existing => normalizeTitle(existing.title)));
  // Semantic-duplicate guard (same article, different URL + reworded title).
  const existingTitleKeys = new Set(store.findings.map(e => titleDomainKey(e.title, e.domain || e.url)));

  // Record a URL as permanently seen so duplicate / failed URLs are never
  // re-researched or re-verified in a later round. Idempotent.
  const markSeen = (canon: string) => {
    if (!globalSeen.has(canon)) {
      globalSeen.add(canon);
      state.seenUrls[categoryKey]!.push(canon);
    }
  };

  for (const f of newFindings) {
    const url = f.url;
    let canonUrl = '';
    let domain = f.domain;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        log(`    [skipped] non-http URL: ${url}`);
        bump('invalid');
        continue;
      }
      canonUrl = canonicalizeUrl(url);
      if (!domain) domain = parsed.hostname;
    } catch {
      log(`    [skipped] invalid URL format: ${url}`);
      bump('invalid');
      continue;
    }

    const title = normalizeTitle(f.title);
    const titleKey = titleDomainKey(f.title, domain || url);

    // Deep deduplication (global: across every category and prior round)
    if (globalSeen.has(canonUrl) || existingUrls.has(canonUrl) || existingTitles.has(title) || existingTitleKeys.has(titleKey)) {
      log(`    [skipped] duplicate found: ${title.slice(0, 40)}...`);
      markSeen(canonUrl);
      bump('duplicates');
      continue;
    }

    // Verify stealth existence if valid URL (but await it)
    try {
      const isValid = await verifyUrl(url);
      if (!isValid) {
        log(`    [skipped] URL failed verification: ${url}`);
        markSeen(canonUrl);
        bump('failedVerify');
        continue;
      }
    } catch {
      log(`    [skipped] URL verification error: ${url}`);
      markSeen(canonUrl);
      bump('failedVerify');
      continue;
    }

    let severity = f.severity;
    if (!severity || !['high', 'medium', 'low'].includes(severity)) {
      severity = 'medium';
    }

    const finding: Finding = {
      ...f,
      id: randomUUID(),
      url,
      domain: domain!,
      // Sanitize at storage time so a stray "Analysis: [...]" / fenced-JSON value can
      // never reach the wall, regardless of which model stage produced it.
      whyBad: normalizeWhyBad(f.whyBad),
      severity: severity as Finding['severity'],
      category: categoryKey,
      foundAt: new Date().toISOString(),
      researchQuery,
    };

    store.findings.push(finding);
    existingUrls.add(canonUrl);
    existingTitles.add(title);
    existingTitleKeys.add(titleKey);
    markSeen(canonUrl);
    added.push(finding);
  }

  // Sort store findings newest first
  store.findings.sort((a, b) => new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime());
  
  return added;
}
