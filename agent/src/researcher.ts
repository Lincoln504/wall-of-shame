import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
  initResearchSDK,
  runQuickResearch,
  shutdownResearchSDK,
  type HeadlessObserverOptions
} from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { DATA_DIR } from './findings.js';
import type { FindingsStore, RunState } from './types.js';
import { getLegacyLinks } from './legacy.js';

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'google/gemma-4-26b-a4b-it';


export interface ResearchResult {
  findings: RawFinding[];
  queries: string[];
  rawReport?: string;
}

// ── SDK Lifecycle ───────────────────────────────────────────────────────────

let isSDKInitialized = false;

/**
 * Initialize the Pi Research SDK for Wall of Shame.
 *
 * The knowledge store is explicitly disabled (KNOWLEDGE_STORE_MODE: 'none') —
 * Wall of Shame is a stateless re-discovery pipeline that keeps its own dedup
 * state in run-state.json, so no vector store is wanted. These config overrides
 * are forwarded to every downstream service by the SDK (initResearchSDK ->
 * runDeepResearch -> runResearch).
 */
export async function initializeResearch(log: (msg: string) => void) {
  if (isSDKInitialized) return;

  log('  [pi] initializing research SDK (knowledge_store=none, aggressive scrape)...');

  await initResearchSDK({
    // "provider/id" — resolved against pi's model registry (~/.pi/agent).
    model: `${OPENROUTER_PROVIDER}/${MODEL_ID}`,
    cwd: process.cwd(),
    config: {
      // No knowledge/vector store — Wall of Shame manages its own dedup state.
      KNOWLEDGE_STORE_MODE: 'none',
      // Aggressive, thorough scraping for hard-hitting source discovery.
      MAX_SCRAPE_BATCHES: 3,
      // Generous per-researcher budget (config range is 180000–1800000 ms).
      RESEARCHER_TIMEOUT_MS: 900000,
    },
    verbose: false,
  });

  isSDKInitialized = true;
}

/**
 * Shutdown the Pi Research SDK and release all background resources.
 */
export async function shutdownResearch() {
  if (!isSDKInitialized) return;
  await shutdownResearchSDK();
  isSDKInitialized = false;
}

// ── Research Execution ────────────────────────────────────────────────────────

/**
 * Run research for a category using the pi-research programmatic SDK.
 */
export async function runResearch(
  query: string,
  categoryKey: string,
  label: string,
  queryHistory: Record<string, string>,
  findingsStore: FindingsStore,
  runState: RunState,
  log: (msg: string) => void,
): Promise<ResearchResult> {
  await initializeResearch(log);

  // 1. Get legacy links for this category to seed research
  const legacyLinks = getLegacyLinks(categoryKey);
  if (legacyLinks.length > 0) {
    log(`  [pi] found ${legacyLinks.length} legacy links for category: ${categoryKey}`);
  }

  // Calculate forbidden queries (used in the last 7 days)
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const forbiddenEntries = Object.entries(queryHistory || {})
    .filter(([_, lastAt]) => now - new Date(lastAt).getTime() < ONE_WEEK_MS)
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, 15);

  const forbidden = forbiddenEntries.map(([q, _]) => q);
  const avoidList = forbidden.length > 0
    ? `\n\nAVOID THESE EXACT QUERIES (searched within the last week):\n${forbidden.join('\n')}\nYou must use DIFFERENT phrasing and explore new angles.`
    : '';

  const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const researchStrategy = `
SEARCH STRATEGY — Be an investigative researcher focusing on how issues are framed:

1. TARGETED EVIDENCE: Queries must be specific and designed to surface high-quality results. Prioritize queries that lead to primary sources and technical documentation.
2. DESCRIPTIVE PHRASING: Look for how people justify or hide issues (e.g., "blaming workers," "ignoring risks," "pretending it's free"). Use exact terms, dates, names, and events.
3. VARY SOURCE TYPES: Target a mix of mainstream media op-eds, niche blogs, and industry PR where specific viewpoints are strongest.
4. VARY TIMEFRAMES: Include relevant years to see how arguments have changed over time.
5. FOCUS ON INTENT: Explore the goal behind how a piece is written and what effect it tries to have on the reader. Focus on analytical synthesis rather than simple fact-dumping.
6. CROSS-REFERENCE: Use findings from one search to spot similar patterns in others.

PERSPECTIVE TEST — Look for content where the piece's net effect is to make harmful outcomes seem normal or acceptable within the category.`;

  let researchQueryStr = `Research task (Current Date: ${currentDate}): ${query}${avoidList}\n\n${researchStrategy}`;

  let researchReport = '';
  const capturedQueries: string[] = [];
  try {
    log(`  [pi] starting research for: ${label}`);

    const observer: HeadlessObserverOptions = {
      onProgress: (event, data) => {
        if (event === 'researcher_start') log(`  [pi] researcher ${data?.id} started: ${data?.name}`);
        else if (event === 'researcher_progress' && data?.status) log(`  [pi] researcher ${data.id}: ${data.status}`);
        else if (event === 'search_start') {
          log(`  [pi] search burst: ${data?.queries?.length ?? 0} queries`);
          if (data?.queries) capturedQueries.push(...data.queries);
        }
        else if (event === 'search_progress') log(`  [pi] search: ${data?.resultsCount ?? 0} links found so far`);
        else if (event === 'complete') log(`  [pi] research complete (${(data?.result ?? '').length} chars)`);
        else if (event === 'error') log(`  [pi] research error: ${data?.message}`);
      },
    };

    researchReport = await runQuickResearch(researchQueryStr, {
      observer,
      // Pass historical links as seeds for research
      initialLinks: legacyLinks,
    });
  } catch (err) {
    log(`  [pi] CRITICAL ENGINE ERROR: ${String(err)}`);
    throw err;
  }

  log(`  [pi] research phase finished, handing off to reviewer...`);

  // Save the raw research report for debugging
  try {
    const reportsDir = join(DATA_DIR, 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    const reportFile = join(reportsDir, `${categoryKey}-${Date.now()}.md`);
    writeFileSync(reportFile, researchReport, 'utf-8');
    log(`  [debug] research report saved to: ${reportFile}`);
  } catch (err) {
    log(`  [warn] failed to save debug report: ${String(err)}`);
  }

  // Extraction and verification is handled entirely by runReview (reviewer.ts).
  // The reviewer accepts either pre-extracted findings OR a raw report string,
  // so we always pass the raw report and let it do everything in one step.
  return { findings: [], queries: capturedQueries, rawReport: researchReport };
}
