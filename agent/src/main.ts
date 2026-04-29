#!/usr/bin/env tsx
/**
 * wall-of-shame agent
 *
 * Runs a batch of research queries using pi-research via the pi SDK,
 * appends new findings to agent/data/findings.json, then commits and pushes.
 *
 * Invoked by cron or manually:
 *   npx tsx src/main.ts [--batch-size N] [--dry-run]
 *
 * Env:
 *   OpenRouter API key is read from ~/.pi/agent/auth.json (openrouter.api_key)
 *   or the ANTHROPIC_API_KEY fallback if you reconfigure the model.
 *
 * Model: deepseek/deepseek-v4-flash via OpenRouter (configured in ~/.pi/agent/)
 */

import { getBatch, CATEGORY_COUNT } from './categories.js';
import { loadFindings, saveFindings, loadState, saveState, addFindings } from './findings.js';
import { runResearch } from './researcher.js';
import { hasUncommittedChanges, commitAndPush, isGitRepo, remoteExists } from './git.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const batchSize = parseInt(args[args.indexOf('--batch-size') + 1] ?? '3', 10) || 3;
const dryRun = args.includes('--dry-run');

// ── Logging ───────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const hr = () => console.log(`[${ts()}] ${'─'.repeat(60)}`);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  hr();
  log('wall-of-shame agent starting');
  log(`categories: ${CATEGORY_COUNT}  |  batch size: ${batchSize}  |  dry-run: ${dryRun}`);
  hr();

  // Check git setup
  if (!dryRun) {
    if (!isGitRepo()) {
      log('WARN: not inside a git repo — skipping commit/push');
    } else if (!remoteExists()) {
      log('WARN: no "origin" remote — skipping push');
    }
  }

  const store = loadFindings();
  const state = loadState();
  log(`existing findings: ${store.findings.length}`);
  log(`resuming at category index: ${state.categoryIndex}`);

  const batch = getBatch(state.categoryIndex, batchSize);
  log(`this run: ${batch.map(c => c.key).join(', ')}`);
  hr();

  let totalAdded = 0;
  let anySucceeded = false;

  if (dryRun) {
    log('DRY-RUN: skipping research — no API calls will be made');
    for (const cat of batch) {
      log(`  would research: ${cat.name} (${cat.key})`);
    }
    hr();
  } else {
    for (let i = 0; i < batch.length; i++) {
      const cat = batch[i]!;
      log(`[${i + 1}/${batch.length}] researching: ${cat.name}`);

      let raws: import('./findings.js').RawFinding[];
      try {
        const result = await runResearch(cat.researchQuery, cat.key, cat.name, state.queryHistory, log);
        raws = result.findings;
        
        // Update query history with current timestamp
        const now = new Date().toISOString();
        for (const q of result.queries) {
          state.queryHistory[q] = now;
        }
        
        anySucceeded = true;
      } catch (err) {
        log(`ERROR during research for ${cat.key}: ${String(err)}`);
        raws = [];
      }

      log(`  raw findings from pi: ${raws.length}`);

      const added = await addFindings(store, state, raws, cat.key, log);
      log(`  new (deduplicated): ${added.length}`);
      totalAdded += added.length;

      hr();
    }

    // Only advance category index if at least one category succeeded
    if (anySucceeded) {
      state.categoryIndex = (state.categoryIndex + batchSize) % CATEGORY_COUNT;
    }

    saveFindings(store);
    saveState(state);
    log(`saved findings.json — total: ${store.findings.length}  (+${totalAdded} this run)`);

    if (totalAdded > 0) {
      if (isGitRepo() && remoteExists()) {
        log(`committing and pushing ${totalAdded} new findings...`);
        try {
          commitAndPush(totalAdded);
          log('pushed — GitHub Actions will rebuild the site');
        } catch (err) {
          log(`WARN: git push failed: ${String(err)}`);
          log('findings.json was saved locally — push manually when ready');
        }
      } else {
        log('skipped git push (no repo or no remote)');
      }
    } else {
      log('no new findings this run — nothing to commit');
    }
  }

  hr();
  log(`done. next run will start at category index: ${state.categoryIndex}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
