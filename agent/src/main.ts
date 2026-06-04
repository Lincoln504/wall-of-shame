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
import { runResearch, shutdownResearch, exportKnowledgeForSite } from './researcher.js';
import { runReview } from './reviewer.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush, git } from './git.js';
import { canonicalizeUrl } from './utils.js';
import type { RawFinding } from './findings.js';

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
    let totalErrors = 0;

    if (dryRun) {
      const batch = getBatch(state.categoryIndex, batchSize);
      log('DRY-RUN: skipping research — no API calls will be made');
      for (const cat of batch) {
        log(`  would research: ${cat.name} (${cat.key})`);
      }
      hr();
    } else {
      // Phase: Sequential Discovery & Review
      const MAX_ATTEMPTS = 3;
      let cursorIndex = state.categoryIndex;

      for (let i = 0; i < batchSize; i++) {
        const cat = CATEGORIES[cursorIndex % CATEGORY_COUNT]!;

        log(`[${i + 1}/${batchSize}] processing: ${cat.name}`);

        let succeeded = false;
        let catAdded = 0;
        // Cache research result so review retries skip the expensive research phase
        let researchDone = false;
        let cachedReviewInput: RawFinding[] | string | null = null;
        let cachedIsRaw = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            const phase = researchDone ? 'review' : 'full';
            log(`  [retry] ${phase} attempt ${attempt}/${MAX_ATTEMPTS} for ${cat.key}`);
          }
          try {
            if (!researchDone) {
              // 1. Research (skipped on review-only retries)
              const catHistory = state.queryHistory[cat.key] || {};
              const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, log);

              // Update query history
              const now = new Date().toISOString();
              if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
              for (const q of result.queries) {
                state.queryHistory[cat.key]![q] = now;
              }

              const reviewInput = result.findings.length > 0 ? result.findings : result.rawReport;
              cachedReviewInput = reviewInput ?? null;
              cachedIsRaw = typeof reviewInput === 'string';
              researchDone = true;
            }

            if (cachedReviewInput !== null) {
              const logLabel = cachedIsRaw ? 'raw report' : `${(cachedReviewInput as RawFinding[]).length} raw findings`;
              log(`  [pi] discovered ${logLabel}, starting review...`);

              // 2. Review (also extracts if input is a raw report)
              const reviewedFindings = await runReview(cachedReviewInput, log);
              const added = await addFindings(store, state, cat.key, reviewedFindings, cat.researchQuery, log);
              catAdded = added.length;
              totalAdded += catAdded;

              // Mark discoveries as seen
              if (!state.seenUrls[cat.key]) state.seenUrls[cat.key] = [];
              const sourceArray = cachedIsRaw ? reviewedFindings : (cachedReviewInput as RawFinding[]);
              for (const raw of sourceArray) {
                const canonical = canonicalizeUrl(raw.url);
                if (!state.seenUrls[cat.key].includes(canonical)) {
                  state.seenUrls[cat.key].push(canonical);
                }
              }

              saveFindings(store);
            } else {
              log(`  [info] no findings discovered for ${cat.name}`);
            }

            succeeded = true;
            break;
          } catch (err) {
            log(`ERROR [${cat.key}] attempt ${attempt}/${MAX_ATTEMPTS}: ${String(err)}`);
            if (err instanceof Error && err.stack) log(err.stack);
            if (attempt === MAX_ATTEMPTS) {
              log(`All ${MAX_ATTEMPTS} attempts failed for ${cat.key}, moving to next category.`);
              totalErrors++;
            }
          }
        }

        // Advance the persistent index regardless of outcome — retries happened inline
        state.categoryIndex = (cursorIndex + 1) % CATEGORY_COUNT;
        saveState(state);
        if (isGitRepo() && remoteExists() && hasDataChanges()) {
          commitAndPush(succeeded ? catAdded : 0, cat.name, log);
        }

        cursorIndex = (cursorIndex + 1) % CATEGORY_COUNT;
        hr();
      }
    }

    hr();
    log(`done. added: ${totalAdded} | errors: ${totalErrors} | next index: ${state.categoryIndex}`);

    // Export Knowledge for Web UI
    try {
      log('  [pi] exporting knowledge store for site...');
      await exportKnowledgeForSite('../site/public/knowledge.json');
    } catch (err) {
      log(`  [warn] knowledge export failed: ${String(err)}`);
    }

  } finally {
    await shutdownResearch();
    log('wall-of-shame agent shutdown complete');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
