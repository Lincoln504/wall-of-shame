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
 * Model: google/gemma-4-26b-a4b-it via OpenRouter (configured in ~/.pi/agent/)
 */

import { getBatch, CATEGORIES, CATEGORY_COUNT } from './categories.js';
import { loadFindings, saveFindings, loadState, saveState, addFindings } from './findings.js';
import { runResearch, shutdownResearch } from './researcher.js';
import { runReview } from './reviewer.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush, git } from './git.js';
import { canonicalizeUrl } from './utils.js';

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
  try {
    hr();
    log('wall-of-shame agent starting');
    log(`categories: ${CATEGORY_COUNT} | batch size: ${batchSize} | dry-run: ${dryRun}`);
    hr();

    const store = loadFindings();
    const state = loadState();
    log(`existing findings: ${store.findings.length}`);
    log(`resuming at category index: ${state.categoryIndex}`);

    let totalAdded = 0;

    if (dryRun) {
      const batch = getBatch(state.categoryIndex, batchSize);
      log('DRY-RUN: skipping research — no API calls will be made');
      for (const cat of batch) {
        log(`  would research: ${cat.name} (${cat.key})`);
      }
      hr();
    } else {
      // Phase: Sequential Discovery & Review
      for (let i = 0; i < batchSize; i++) {
        const cat = CATEGORIES[state.categoryIndex];
        if (!cat) break;

        log(`[${i + 1}/${batchSize}] processing: ${cat.name}`);

        try {
          // 1. Research
          const catHistory = state.queryHistory[cat.key] || {};
          const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, log);

          // Update query history
          const now = new Date().toISOString();
          if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
          for (const q of result.queries) {
            state.queryHistory[cat.key]![q] = now;
          }

          // Even if no findings, we advance the index for next time
          state.categoryIndex = (state.categoryIndex + 1) % CATEGORY_COUNT;

          if (result.findings.length > 0) {
            log(`  [pi] discovered ${result.findings.length} raw findings, starting review...`);
            
            // 2. Review
            const reviewedFindings = await runReview(result.findings, log);
            const added = await addFindings(store, state, cat.key, reviewedFindings, cat.researchQuery, log);
            totalAdded += added.length;

            // Mark ORIGINAL discoveries as seen for THIS category so we don't re-review them
            if (!state.seenUrls[cat.key]) state.seenUrls[cat.key] = [];
            for (const raw of result.findings) {
              const canonical = canonicalizeUrl(raw.url);
              if (!state.seenUrls[cat.key].includes(canonical)) {
                state.seenUrls[cat.key].push(canonical);
              }
            }

            saveFindings(store);
            saveState(state);
            commitAndPush(added.length, cat.name, log);
          } else {
            log(`  [info] no findings discovered for ${cat.name}`);
            saveState(state);
            commitAndPush(0, cat.name, log);
          }
        } catch (err) {
          log(`ERROR during processing for ${cat.key}: ${String(err)}`);
          log(`Progress paused at category index ${state.categoryIndex}.`);
          break;
        }
        hr();
      }
    }

    hr();
    log(`done. next run will start at category index: ${state.categoryIndex}`);
  } finally {
    await shutdownResearch();
    log('wall-of-shame agent shutdown complete');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
