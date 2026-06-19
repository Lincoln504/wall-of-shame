#!/usr/bin/env tsx
/**
 * wall-of-shame agent — batch entry point.
 *
 * Runs a research round (concurrently across categories) using pi-research via
 * the SDK, appends new findings to agent/data/findings.json, then commits and
 * pushes. All round logic lives in run.ts (shared with the interactive cli.ts).
 *
 * Usage:
 *   tsx src/main.ts                         # default: 3 categories from cursor (discovery)
 *   tsx src/main.ts --all                   # all categories in one round
 *   tsx src/main.ts --seed --all            # SEED: re-evaluate curated legacy links
 *   tsx src/main.ts --batch-size 6          # 6 categories from the cursor
 *   tsx src/main.ts --concurrency 4         # cap simultaneous categories (default 4)
 *   tsx src/main.ts --dry-run               # list categories, no API calls
 *   tsx src/main.ts --no-commit             # run but don't git commit/push
 */

import { getBatch, CATEGORIES, CATEGORY_COUNT } from './categories.js';
import { loadFindings, loadState } from './findings.js';
import { shutdownResearch } from './researcher.js';
import { runRound, runSeedRound } from './run.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function numArg(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const v = parseInt(args[idx + 1] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const all = args.includes('--all');
const seed = args.includes('--seed');
const batchSize = all ? CATEGORY_COUNT : Math.min(numArg('--batch-size', 3), CATEGORY_COUNT);
const concurrency = Math.min(numArg('--concurrency', 4), CATEGORY_COUNT);
const dryRun = args.includes('--dry-run');
const commit = !args.includes('--no-commit');

// ── Soft category balancing ─────────────────────────────────────────────────────
// The corpus fills faster in content-rich categories (economics, healthcare, labor)
// than in thin ones. We do NOT enforce a strict ratio — natural over-representation is
// valid — but the most-populated categories are researched LESS often: each --all round
// drops the current top-N categories with probability THROTTLE. Over many rounds this
// gently down-weights the leaders without ever starving anything. Disable with
// PI_RESEARCH_TOP_THROTTLE=0; tune the count with --throttle-top N (default 4).
//
// DEDUP POLICY — category balancing is the ONE omission that is NOT tombstoned. A source
// passed over because its category was throttled this round is simply never fetched, so it
// never reaches markSeen/_audit_removed: it stays fully eligible for a future round when its
// category is no longer saturated. (Everything else considered-but-unused — failed scrapes,
// failed verification, duplicates, audit/quality removals — IS tombstoned so it is never
// reprocessed; see findings.ts markSeen and the _audit_removed tombstone in the audit scripts.)
// This is by construction: balance is applied by SKIPPING categories at intake, never by
// pruning already-stored entries — so good, verified content is never deleted for balance.
const TOP_N = numArg('--throttle-top', 4);
const THROTTLE = (() => {
  const v = parseFloat(process.env['PI_RESEARCH_TOP_THROTTLE'] ?? '0.5');
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5;
})();

function throttleSaturated<T extends { key: string }>(
  cats: T[],
  findings: { category: string }[],
  log: (m: string) => void,
): T[] {
  if (THROTTLE <= 0 || cats.length <= TOP_N) return cats;
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] || 0) + 1;
  const saturated = new Set(
    cats.map(c => c.key)
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
      .slice(0, TOP_N),
  );
  // Each saturated category is independently kept with probability (1 - THROTTLE).
  const kept = cats.filter(c => !saturated.has(c.key) || Math.random() >= THROTTLE);
  const dropped = cats.filter(c => !kept.includes(c));
  if (dropped.length) {
    log(`category throttle: down-weighting top-${TOP_N} saturated — skipping [${dropped.map(c => c.key).join(', ')}] this round (p=${THROTTLE})`);
  }
  return kept.length ? kept : cats; // never return an empty round
}

// ── Logging ───────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const hr = () => console.log(`[${ts()}] ${'─'.repeat(60)}`);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let shouldShutdown = false;
  try {
    hr();
    log('wall-of-shame agent starting');

    const store = loadFindings();
    const state = loadState();
    log(`existing findings: ${store.findings.length}`);
    log(`mode: ${seed ? 'SEED (legacy re-evaluation)' : 'DISCOVERY (general search)'} | round size: ${batchSize} | concurrency: ${concurrency} | dry-run: ${dryRun}`);
    log(`resuming at category index: ${state.categoryIndex}`);

    // Seed mode always covers all categories with curated links; discovery
    // rotates through the cursor unless --all is given.
    const startIndex = (all || seed) ? 0 : state.categoryIndex;
    let categories = (all || seed) ? CATEGORIES : getBatch(startIndex, batchSize);
    // Apply the soft top-N throttle to discovery --all rounds only (seed re-evaluation
    // must cover every category; partial cursor rounds already rotate coverage).
    if (all && !seed) categories = throttleSaturated(categories, store.findings, log);

    if (dryRun) {
      log('DRY-RUN: skipping research — no API calls will be made');
      for (const cat of categories) log(`  would ${seed ? 'seed-evaluate' : 'research'}: ${cat.name} (${cat.key})`);
      hr();
      return;
    }

    shouldShutdown = true;
    const round = seed ? runSeedRound : runRound;
    const result = await round({ categories, concurrency, log, commit, startIndex });

    hr();
    log(`round complete. +${result.totalAdded} new findings, ${result.errors} categories errored.`);
    log(`total findings on the wall: ${result.totalFindings}`);
    for (const c of result.perCategory) {
      log(`  ${c.key.padEnd(12)} +${c.added}${c.error ? `  [ERROR] ${c.error.slice(0, 80)}` : ''}`);
    }
    hr();
  } catch (err) {
    console.error('Fatal agent error:', err);
    process.exitCode = 1;
  } finally {
    if (shouldShutdown) await shutdownResearch();
    log('agent shutdown complete.');
  }
}

main()
  .then(() => {
    // Batch CLI: exit deterministically. wall-of-shame opens its own keep-alive
    // HTTP sockets to OpenRouter (gemma completeSimple for extraction/review, and
    // verifyUrl's fetch). undici honours the server's keep-alive hint (up to a
    // ~10-min cap), so at concurrency an idle socket pool keeps libuv's event loop
    // alive for many minutes AFTER all work + SDK shutdown are done — the process
    // would otherwise appear to "hang". The pi-research SDK itself disposes its own
    // sockets cleanly (verified); this is purely about our own clients.
    //
    // All durable work (findings.json, run-state.json, audit JSON, git) is written
    // synchronously before we reach here, so forcing exit truncates nothing. The
    // timer is unref'd: if the loop is already empty the process exits immediately;
    // otherwise it force-exits after a brief stdout-drain grace window.
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  })
  .catch(err => {
    console.error('Fatal unhandled error:', err);
    process.exit(1);
  });
