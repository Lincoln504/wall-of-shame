import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
  initResearchSDK,
  runQuickResearch,
  disposeResearchSDK,
  exportKnowledge,
  type HeadlessObserverOptions
} from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { DATA_DIR } from './findings.js';
import type { FindingsStore, RunState } from './types.js';

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'deepseek/deepseek-v3';


export interface ResearchResult {
  findings: RawFinding[];
  queries: string[];
  rawReport?: string;
}

// ── SDK Lifecycle ───────────────────────────────────────────────────────────

let isSDKInitialized = false;

/**
 * Initialize the PIE Research SDK for Wall of Shame.
 * Uses a local project knowledge_db.
 */
export async function initializeResearch(log: (msg: string) => void) {
  if (isSDKInitialized) return;

  log('  [pi] initializing research SDK with local knowledge store...');

  await initResearchSDK({
    // Pass as string — SDK resolves it from ~/.pi/agent/models.json internally
    model: `${OPENROUTER_PROVIDER}/${MODEL_ID}`,
    cwd: process.cwd(),
    config: {
      // KNOWLEDGE_STORE_DIR takes priority over USE_LOCAL_KNOWLEDGE_STORE in getDbDir(),
      // so set it explicitly to the agent's own knowledge_db directory.
      KNOWLEDGE_STORE_DIR: join(process.cwd(), 'knowledge_db'),
      MAX_SCRAPE_BATCHES: 4,
      RESEARCHER_TIMEOUT_MS: 600000,
    },
    verbose: false,
  });

  isSDKInitialized = true;
}

/**
 * Shutdown the PIE Research SDK.
 */
export async function shutdownResearch() {
  if (!isSDKInitialized) return;
  await disposeResearchSDK();
  isSDKInitialized = false;
}

/**
 * Export the Knowledge Store for the site.
 */
export async function exportKnowledgeForSite(outputPath: string) {
  if (!isSDKInitialized) return;
  await exportKnowledge(outputPath);
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
  try {
    log(`  [pi] starting research for: ${label}`);

    const observer: HeadlessObserverOptions = {
      onProgress: (event, data) => {
        if (event === 'researcher_start') log(`  [pi] researcher ${data?.id} started: ${data?.name}`);
        else if (event === 'researcher_progress' && data?.status) log(`  [pi] researcher ${data.id}: ${data.status}`);
        else if (event === 'search_start') log(`  [pi] search burst: ${data?.queries?.length ?? 0} queries`);
        else if (event === 'search_progress') log(`  [pi] search: ${data?.resultsCount ?? 0} links found so far`);
        else if (event === 'complete') log(`  [pi] research complete (${(data?.result ?? '').length} chars)`);
        else if (event === 'error') log(`  [pi] research error: ${data?.message}`);
      },
    };

    researchReport = await runQuickResearch(researchQueryStr, {
      depth: 0,
      observer,
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
  return { findings: [], queries: [], rawReport: researchReport };
}
