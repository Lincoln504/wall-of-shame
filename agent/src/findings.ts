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
      loaded.seenUrls = seenUrls;
    }

    return {
      lastRun: loaded.lastRun || state.lastRun,
      categoryIndex: typeof loaded.categoryIndex === 'number' ? loaded.categoryIndex : state.categoryIndex,
      seenUrls: seenUrls,
      queryHistory: queryHistory
    };
  } catch {
    return state;
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
    const url = canonicalizeUrl(f.url);
    const title = normalizeTitle(f.title);

    // Deep deduplication
    const isDuplicate = state.seenUrls[categoryKey]!.includes(url) ||
                       store.findings.some(existing => canonicalizeUrl(existing.url) === url) ||
                       store.findings.some(existing => normalizeTitle(existing.title) === title);

    if (isDuplicate) {
      log(`    [skipped] duplicate found: ${title.slice(0, 40)}...`);
      continue;
    }

    // Verification check
    log(`    [verify] checking ${f.domain}...`);
    const exists = await verifyUrl(f.url);
    if (!exists) {
      log(`    [skipped] URL unreachable or blocked: ${url}`);
      continue;
    }

    const finding: Finding = {
      id: Math.random().toString(36).slice(2, 11),
      ...f,
      foundAt: new Date().toISOString(),
      researchQuery,
    };

    store.findings.push(finding);
    state.seenUrls[categoryKey]!.push(url);
    added.push(finding);
  }

  return added;
}
