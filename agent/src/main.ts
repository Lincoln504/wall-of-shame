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

import { getBatch, CATEGORIES, CATEGORY_COUNT } from './categories.js';
import { loadFindings, saveFindings, loadState, saveState, addFindings } from './findings.js';
import { runResearch } from './researcher.js';

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
    // Process categories one-by-one to ensure state index only advances for success
    for (let i = 0; i < batchSize; i++) {
      const cat = CATEGORIES[state.categoryIndex];
      if (!cat) break;

      log(`[${i + 1}/${batchSize}] researching: ${cat.name}`);

      try {
        const catHistory = state.queryHistory[cat.key] || {};
        const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, log);
        const raws = result.findings;
        
        // Update query history with current timestamp
        const now = new Date().toISOString();
        if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
        for (const q of result.queries) {
          state.queryHistory[cat.key]![q] = now;
        }
        
        const added = await addFindings(store, state, raws, cat.key, log);
        log(`  new (deduplicated): ${added.length}`);
        totalAdded += added.length;

        // ONLY advance category index on success
        state.categoryIndex = (state.categoryIndex + 1) % CATEGORY_COUNT;
        
        // Save state immediately after each successful category
        saveFindings(store);
        saveState(state);
      } catch (err) {
        log(`ERROR during research for ${cat.key}: ${String(err)}`);
        log(`Category ${cat.key} failed - it will remain at index ${state.categoryIndex} for the next run.`);
        // We stop the batch on first failure to keep state simple and linear
        break;
      }

      hr();
    }

    log(`Batch complete — total: ${store.findings.length}  (+${totalAdded} this run)`);
  }

  hr();
  log(`done. next run will start at category index: ${state.categoryIndex}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
