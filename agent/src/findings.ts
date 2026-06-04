import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyUrl as sdkVerifyUrl } from '@lincoln504/pi-research';
import type { Finding, FindingsStore, RunState } from './types.js';
import { FindingsStoreSchema, RunStateSchema } from './types.js';
import { safeParseValidatedJson, canonicalizeUrl, normalizeTitle } from './utils.js';

// Export types for consumer use
export type { Finding, FindingsStore, RunState };

/**
 * Verify if a URL exists using the Pi Research SDK (stealth browser).
 * High fidelity existence detection.
 */
export async function verifyUrl(url: string): Promise<boolean> {
  return await sdkVerifyUrl(url);
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
    const raw = readFileSync(FINDINGS_PATH, 'utf-8');
    return safeParseValidatedJson(FindingsStoreSchema, raw);
  } catch (err) {
    throw new Error(`CRITICAL: Findings file exists but is corrupted or invalid: ${String(err)}`);
  }
}

export function saveFindings(store: FindingsStore): void {
  store.lastUpdated = new Date().toISOString();
  store.totalFindings = store.findings.length;
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
    const firstQueryVal = Object.values(queryHistory)[0];
    if (firstQueryVal && typeof firstQueryVal === 'string') {
      queryHistory = { migrated_legacy: queryHistory };
      loaded.queryHistory = queryHistory;
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
            return url.toLowerCase().trim(); // Fallback if canonicalizeUrl isn't directly available here
          }
        });
      }
    }
    loaded.seenUrls = seenUrls;


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
  domain: string;
  summary: string;
  category: string;
  whyBad: string;
  severity: 'low' | 'medium' | 'high';
  verificationLog?: string;
}

/**
 * Append new findings to the store, performing deduplication and URL canonicalization.
 */
export async function addFindings(
  store: FindingsStore,
  state: RunState,
  categoryKey: string,
  newFindings: RawFinding[],
  researchQuery: string,
  log: (msg: string) => void
): Promise<Finding[]> {
  const added: Finding[] = [];

  if (!state.seenUrls[categoryKey]) {
    state.seenUrls[categoryKey] = [];
  }

  for (const f of newFindings) {
    let url = f.url;
    let canonUrl = '';
    let domain = f.domain;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        log(`    [skipped] non-http URL: ${url}`);
        continue;
      }
      canonUrl = canonicalizeUrl(url);
      if (!domain) domain = parsed.hostname;
    } catch {
      log(`    [skipped] invalid URL format: ${url}`);
      continue;
    }

    const title = normalizeTitle(f.title);

    // Deep deduplication (scoped to category)
    const isDuplicate = state.seenUrls[categoryKey]!.some(seen => canonicalizeUrl(seen) === canonUrl) ||
                       store.findings.some(existing => existing.category === categoryKey && canonicalizeUrl(existing.url) === canonUrl) ||
                       store.findings.some(existing => existing.category === categoryKey && normalizeTitle(existing.title) === title);

    if (isDuplicate) {
      log(`    [skipped] duplicate found: ${title.slice(0, 40)}...`);
      continue;
    }

    // Verify stealth existence if valid URL (but await it)
    try {
      const isValid = await verifyUrl(url);
      if (!isValid) {
        log(`    [skipped] URL failed verification: ${url}`);
        continue;
      }
    } catch {
      log(`    [skipped] URL verification error: ${url}`);
      continue;
    }

    let severity = f.severity;
    if (!severity || !['critical', 'high', 'medium', 'low'].includes(severity)) {
      severity = 'medium';
    }

    const finding: Finding = {
      ...f,
      id: f.id || randomUUID(),
      url,
      domain: domain!,
      severity: severity as Finding['severity'],
      category: categoryKey,
      foundAt: new Date().toISOString(),
      researchQuery,
    };

    store.findings.push(finding);
    state.seenUrls[categoryKey]!.push(canonUrl);
    added.push(finding);
  }

  // Sort store findings newest first
  store.findings.sort((a, b) => new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime());
  
  return added;
}
