#!/usr/bin/env tsx
/**
 * wall-of-shame agent
 *
 * Runs a batch of research queries using pi-research via the pi SDK,
 * appends new findings to agent/data/findings.json, then commits and pushes.
 */

import { getBatch, CATEGORIES, CATEGORY_COUNT } from './categories.js';
import { loadFindings, saveFindings, loadState, saveState, addFindings, type RawFinding, type Finding } from './findings.js';
import { runResearch, shutdownResearch, exportKnowledgeForSite, initializeResearch } from './researcher.js';
import { runReview } from './reviewer.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';
import { join } from 'path';

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

    if (dryRun) {
      const batch = getBatch(state.categoryIndex, batchSize);
      log('DRY-RUN: skipping research — no API calls will be made');
      for (const cat of batch) {
        log(`  would research: ${cat.name} (${cat.key})`);
      }
      hr();
      return;
    }

    // Initialize SDK once
    await initializeResearch(log);

    let totalAdded = 0;
    const cursorIndex = state.categoryIndex;

    for (let i = 0; i < batchSize; i++) {
      const currentIdx = (cursorIndex + i) % CATEGORY_COUNT;
      const cat = CATEGORIES[currentIdx]!;

      log(`[${i + 1}/${batchSize}] processing: ${cat.name}`);

      let catAdded = 0;
      let researchResult = null;

      // 1. Research Phase (with 2 retries)
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const catHistory = state.queryHistory[cat.key] || {};
          researchResult = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, log);
          break;
        } catch (err) {
          log(`  [error] research attempt ${attempt} failed: ${String(err)}`);
          if (attempt === 2) throw err;
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (!researchResult) continue;

      // 2. Review Phase (with 2 retries, independent of research)
      let reviewedFindings: RawFinding[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // Pass rawReport (string) to reviewer for extraction, not empty findings array
          reviewedFindings = await runReview(researchResult.rawReport, log);
          break;
        } catch (err) {
          log(`  [error] review attempt ${attempt} failed: ${String(err)}`);
          if (attempt === 2) {
             log(`  [warning] skipping category ${cat.key} due to persistent reviewer failure`);
          } else {
             await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      // 3. Save Phase
      if (reviewedFindings.length > 0) {
        const addedFindings = await addFindings(store, state, cat.key, reviewedFindings, cat.researchQuery, log);
        catAdded = addedFindings.length;
        totalAdded += catAdded;
        saveFindings(store);
        saveState(state);
        log(`  [success] added ${catAdded} new findings for ${cat.key}`);
      }

      // Increment global category index
      state.categoryIndex = (currentIdx + 1) % CATEGORY_COUNT;
      saveState(state);
      hr();
    }

    // 4. Export & Sync Phase
    if (totalAdded > 0 || hasDataChanges()) {
      log('exporting knowledge store for site...');
      const knowledgePath = join(process.cwd(), '..', 'site', 'public', 'knowledge.json');
      await exportKnowledgeForSite(knowledgePath);
      
      log('syncing changes with git...');
      commitAndPush(totalAdded, 'batch run', log);
    }

    log(`batch complete. added ${totalAdded} total findings.`);

  } catch (err) {
    log(`CRITICAL ERROR: ${String(err)}`);
    process.exit(1);
  } finally {
    await shutdownResearch();
    log('agent shutdown complete.');
  }
}

main().catch(err => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
