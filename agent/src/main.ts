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
    const categories = (all || seed) ? CATEGORIES : getBatch(startIndex, batchSize);

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

main().catch(err => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
