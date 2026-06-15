/**
 * run.ts — the single shared round-runner for the Wall of Shame agent.
 *
 * Both the batch entry point (main.ts) and the interactive menu (cli.ts) call
 * runRound() / runSeedRound() so there is exactly ONE definition of how a round
 * behaves (dedup, query-history, commit, cursor advancement).
 *
 * Two round types share one engine:
 *   - runRound()      — DISCOVERY: general web-search research per category, then
 *                       review. This is the steady-state lifecycle.
 *   - runSeedRound()  — SEED RE-EVALUATION: directly evaluate the curated legacy
 *                       URL list (no general search). Used to bring the existing
 *                       saved links back onto the wall quickly.
 *
 * Concurrency model (chosen for robust failure isolation, not raw speed):
 *   Phase 1 — per-category work runs CONCURRENTLY, bounded by `concurrency`, each
 *             category fully isolated (a crash in one never aborts the others).
 *             Side-effect free w.r.t. shared store/state.
 *   Phase 2 — a SEQUENTIAL fan-in merges each category's reviewed findings into
 *             the shared store/state (global dedup + stealth verification), saving
 *             atomically after each category so a mid-round crash keeps progress.
 *   Commit  — a single git commit/push at the end (no per-category commit races).
 */

import type { Category } from './types.js';
import { CATEGORY_COUNT } from './categories.js';
import {
  loadFindings, saveFindings, loadState, saveState, addFindings,
  type RawFinding, type FindingsStore, type RunState,
} from './findings.js';
import { runResearch, initializeResearch } from './researcher.js';
import { runReview } from './reviewer.js';
import { getLegacySeeds } from './legacy.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';
import { mapWithConcurrency } from './utils.js';

const RESEARCH_ATTEMPTS = 2;
const REVIEW_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5000;

export interface RoundOptions {
  /** Categories to process this round. */
  categories: Category[];
  /** Max categories worked on at once. */
  concurrency: number;
  log: (msg: string) => void;
  /** Commit & push the result at the end of the round. Default true. */
  commit?: boolean;
  /** Persistent cursor start, used to advance run-state.categoryIndex. */
  startIndex?: number;
}

export interface CategoryOutcome {
  key: string;
  name: string;
  added: number;
  error?: string;
}

export interface RoundResult {
  totalAdded: number;
  errors: number;
  perCategory: CategoryOutcome[];
  totalFindings: number;
}

interface ReviewedBundle {
  reviewed: RawFinding[];
  queries: string[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Review a report with bounded retries. Returns [] if the report is empty. */
async function reviewWithRetries(
  catKey: string,
  report: string,
  log: (msg: string) => void,
): Promise<RawFinding[]> {
  if (!report) {
    log(`  [warn] ${catKey}: empty report, nothing to review`);
    return [];
  }
  for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt++) {
    try {
      return await runReview(report, log);
    } catch (err) {
      log(`  [error] ${catKey} review attempt ${attempt}/${REVIEW_ATTEMPTS} failed: ${String(err)}`);
      if (attempt === REVIEW_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
  return [];
}

/** Phase-1 work for DISCOVERY: research (retried) then review (retried). */
async function researchAndReview(
  cat: Category,
  store: FindingsStore,
  state: RunState,
  log: (msg: string) => void,
): Promise<ReviewedBundle> {
  let report = '';
  let queries: string[] = [];

  for (let attempt = 1; attempt <= RESEARCH_ATTEMPTS; attempt++) {
    try {
      const catHistory = state.queryHistory[cat.key] || {};
      const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, log);
      report = result.rawReport || '';
      queries = result.queries;
      break;
    } catch (err) {
      log(`  [error] ${cat.key} research attempt ${attempt}/${RESEARCH_ATTEMPTS} failed: ${String(err)}`);
      if (attempt === RESEARCH_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }

  const reviewed = await reviewWithRetries(cat.key, report, log);
  return { reviewed, queries };
}

/** Build a directed reviewer report that evaluates a category's curated seed URLs. */
function buildSeedReport(cat: Category, seeds: { url: string; title: string }[]): string {
  const list = seeds.map((s, i) => `${i + 1}. ${s.url}${s.title ? `  — ${s.title}` : ''}`).join('\n');
  return [
    `CATEGORY: ${cat.name}`,
    `FOCUS: ${cat.description}`,
    '',
    'The following are previously-curated source URLs for this category. Evaluate EACH one:',
    "use the 'research' tool with depth: 0 and the URL as the query to read the page, then —",
    'if it uses biased framing to normalize, justify, or hide the harm described in the FOCUS —',
    'produce a finding following the output schema. OMIT any URL that is dead, unreachable, or',
    'merely reports facts neutrally. Write sharp, plain-English, hard-hitting analysis in whyBad.',
    '',
    'SEED URLS:',
    list,
  ].join('\n');
}

/** Phase-1 work for SEED mode: evaluate the category's legacy URLs directly. */
async function evaluateSeeds(
  cat: Category,
  log: (msg: string) => void,
): Promise<ReviewedBundle> {
  const seeds = getLegacySeeds(cat.key);
  if (seeds.length === 0) {
    log(`  [seed] ${cat.key}: no legacy seeds`);
    return { reviewed: [], queries: [] };
  }
  log(`  [seed] ${cat.key}: evaluating ${seeds.length} curated links`);
  const reviewed = await reviewWithRetries(cat.key, buildSeedReport(cat, seeds), log);
  return { reviewed, queries: [] };
}

/**
 * Phase 2: sequentially merge each category's reviewed findings into the shared
 * store/state, saving atomically per category, then a single fan-in commit.
 */
async function mergeAndPersist(
  categories: Category[],
  settled: Array<{ ok: true; value: ReviewedBundle } | { ok: false; error: unknown }>,
  store: FindingsStore,
  state: RunState,
  opts: { commit: boolean; startIndex?: number; log: (msg: string) => void },
): Promise<RoundResult> {
  const { log } = opts;
  let totalAdded = 0;
  let errors = 0;
  const perCategory: CategoryOutcome[] = [];

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    const outcome = settled[i]!;

    if (!outcome.ok) {
      errors++;
      perCategory.push({ key: cat.key, name: cat.name, added: 0, error: String(outcome.error) });
      log(`  [skip] ${cat.key}: failed after retries — ${String(outcome.error)}`);
      continue;
    }

    const { reviewed, queries } = outcome.value;

    let added = 0;
    try {
      const addedFindings = await addFindings(store, state, cat.key, reviewed, cat.researchQuery, log);
      added = addedFindings.length;
    } catch (err) {
      errors++;
      perCategory.push({ key: cat.key, name: cat.name, added: 0, error: String(err) });
      log(`  [skip] ${cat.key}: merge failed — ${String(err)}`);
      continue;
    }

    if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
    const now = new Date().toISOString();
    for (const q of queries) state.queryHistory[cat.key]![q] = now;

    totalAdded += added;
    perCategory.push({ key: cat.key, name: cat.name, added });
    log(`  [ok] ${cat.key}: +${added} new`);

    // Persist progress atomically after each category.
    saveFindings(store);
    saveState(state);
  }

  if (typeof opts.startIndex === 'number') {
    state.categoryIndex = (opts.startIndex + categories.length) % CATEGORY_COUNT;
  }
  saveState(state);

  if (opts.commit && totalAdded > 0 && isGitRepo() && remoteExists() && hasDataChanges()) {
    commitAndPush(totalAdded, `${categories.length} categories`, log);
  }

  return { totalAdded, errors, perCategory, totalFindings: store.findings.length };
}

/** Run a general-search DISCOVERY round over the given categories. */
export async function runRound(opts: RoundOptions): Promise<RoundResult> {
  const { categories, concurrency, log } = opts;
  const store = loadFindings();
  const state = loadState();

  await initializeResearch(log);
  log(`discovery round: ${categories.length} categories @ concurrency ${concurrency}`);

  const settled = await mapWithConcurrency(
    categories, concurrency,
    (cat) => researchAndReview(cat, store, state, log),
  );

  return mergeAndPersist(categories, settled, store, state, {
    commit: opts.commit ?? true,
    startIndex: opts.startIndex,
    log,
  });
}

/** Run a SEED re-evaluation round over the curated legacy URLs for each category. */
export async function runSeedRound(opts: RoundOptions): Promise<RoundResult> {
  const { categories, concurrency, log } = opts;
  const store = loadFindings();
  const state = loadState();

  await initializeResearch(log);
  log(`seed round: ${categories.length} categories @ concurrency ${concurrency}`);

  const settled = await mapWithConcurrency(
    categories, concurrency,
    (cat) => evaluateSeeds(cat, log),
  );

  return mergeAndPersist(categories, settled, store, state, {
    commit: opts.commit ?? true,
    startIndex: opts.startIndex,
    log,
  });
}
