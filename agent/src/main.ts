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
import { runReview } from './reviewer.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';

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
    const discoveryBatch: { findings: import('./findings.js').RawFinding[], categoryKey: string }[] = [];

    // 1. Discovery Phase
    for (let i = 0; i < batchSize; i++) {
      const cat = CATEGORIES[state.categoryIndex];
      if (!cat) break;

      log(`[${i + 1}/${batchSize}] discovering: ${cat.name}`);

      try {
        const catHistory = state.queryHistory[cat.key] || {};
        const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, log);
        
        if (result.findings.length > 0) {
          discoveryBatch.push({ findings: result.findings, categoryKey: cat.key });
        }
        
        // Update query history immediately
        const now = new Date().toISOString();
        if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
        for (const q of result.queries) {
          state.queryHistory[cat.key]![q] = now;
        }

        // Increment state index - we've successfully researched this category
        state.categoryIndex = (state.categoryIndex + 1) % CATEGORY_COUNT;
        saveState(state);
      } catch (err) {
        log(`ERROR during research for ${cat.key}: ${String(err)}`);
        log(`Category ${cat.key} failed - it will remain at index ${state.categoryIndex} for the next run.`);
        // Stop batch on failure to maintain serial progress
        break;
      }
      hr();
    }

    // 2. Review & Save Phase
    if (discoveryBatch.length > 0) {
      log(`starting batch review for ${discoveryBatch.reduce((acc, b) => acc + b.findings.length, 0)} discoveries...`);
      
      for (const item of discoveryBatch) {
        try {
          const reviewedFindings = await runReview(item.findings, log);
          const added = await addFindings(store, state, reviewedFindings, item.categoryKey, log);
          totalAdded += added.length;

          // Crucially: also mark all ORIGINAL findings as seen, even if rejected,
          // so we don't spend credits discovering them again next time.
          for (const raw of item.findings) {
            if (raw.url && !state.seenUrls.includes(raw.url)) {
              state.seenUrls.push(raw.url);
            }
          }
        } catch (err) {
          log(`  [warn] review failed for ${item.categoryKey}: ${String(err)}`);
          // Fallback: try to add the unreviewed ones
          const added = await addFindings(store, state, item.findings, item.categoryKey, log);
          totalAdded += added.length;
        }
      }

      saveFindings(store);
      saveState(state);
      log(`saved data locally — total: ${store.findings.length} (+${totalAdded} this run)`);

      // 3. Auto Push
      if (isGitRepo() && remoteExists() && hasDataChanges()) {
        log('automatically committing and pushing batch results...');
        try {
          commitAndPush(totalAdded);
          log('pushed — site will update shortly');
        } catch (err) {
          log(`WARN: git push failed: ${String(err)}`);
        }
      }
    } else {
      log('no new findings discovered in this batch.');
    }
  }

  hr();
  log(`done. next run will start at category index: ${state.categoryIndex}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
