#!/usr/bin/env tsx
/**
 * cli.ts — Interactive CLI menu for the wall-of-shame agent
 *
 * A number-based menu that lets you:
 *   1. Run research (one batch)
 *   2. Dry-run research (no save/commit)
 *   3. View statistics & status
 *   4. View findings (recent or by category)
 *   5. Reset state (category index back to 0)
 *   6. Setup weekly cron job
 *   7. Exit
 *
 * Usage:
 *   cd agent && npx tsx src/cli.ts
 */

import { createInterface } from 'readline';
import { getBatch, CATEGORIES, CATEGORY_COUNT } from './categories.js';
import { loadFindings, loadState, saveState, saveFindings, addFindings } from './findings.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// ── Colors / formatting ───────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';

// ── Readline wrapper ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function question(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

// ── Display helpers ───────────────────────────────────────────────────────────

function banner(): void {
  console.clear();
  console.log(`${BOLD}${RED}╔═══════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${RED}║            WALL OF SHAME                  ║${RESET}`);
  console.log(`${BOLD}${RED}║   Automated Harmful Content Tracker      ║${RESET}`);
  console.log(`${BOLD}${RED}╚═══════════════════════════════════════════╝${RESET}`);
  console.log();
}

function divider(): void {
  console.log(`${DIM}${'─'.repeat(48)}${RESET}`);
}

function elapsed(start: number): string {
  const s = Math.floor((Date.now() - start) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function printMenu(): void {
  console.log();
  console.log(`${BOLD}Options:${RESET}`);
  console.log(`  ${CYAN}1${RESET})  Run research batch`);
  console.log(`  ${CYAN}2${RESET})  Dry-run research batch (no save)`);
  console.log(`  ${CYAN}3${RESET})  View statistics & status`);
  console.log(`  ${CYAN}4${RESET})  View findings`);
  console.log(`  ${CYAN}5${RESET})  Reset category index to 0`);
  console.log(`  ${CYAN}6${RESET})  Setup weekly cron job`);
  console.log(`  ${CYAN}7${RESET})  Exit`);
  console.log();
}

// ── Option 1 & 2: Run research ────────────────────────────────────────────────

async function runResearchBatch(dryRun: boolean): Promise<void> {
  console.log(`${BOLD}${dryRun ? YELLOW + 'DRY-RUN' : GREEN + 'RUNNING'} RESEARCH BATCH${RESET}`);
  divider();

  // Ask for batch size
  const sizeInput = await question(`${DIM}Batch size (default 3, max 50):${RESET} `);
  const batchSize = Math.min(Math.max(parseInt(sizeInput, 10) || 3, 1), 50);

  console.log();
  const store = loadFindings();
  const state = loadState();
  const batch = getBatch(state.categoryIndex, batchSize);

  console.log(`${DIM}Current state:${RESET}`);
  console.log(`  Findings: ${CYAN}${store.findings.length}${RESET}`);
  console.log(`  Category index: ${CYAN}${state.categoryIndex}${RESET} (${CATEGORIES[state.categoryIndex]?.name ?? 'N/A'})`);
  console.log(`  Categories in this batch:`);
  for (const cat of batch) {
    console.log(`    • ${cat.name} ${DIM}(${cat.key})${RESET}`);
  }
  console.log();

  const startTime = Date.now();
  let totalAdded = 0;
  let totalErrors = 0;

  if (dryRun) {
    console.log(`\n${YELLOW}This is a dry-run — nothing will be researched or saved.${RESET}`);
    console.log(`${DIM}The following categories would be processed:${RESET}`);
    for (const cat of batch) {
      console.log(`  • ${cat.name} ${DIM}(${cat.key})${RESET}`);
    }
    console.log(`\n${YELLOW}To actually run research, select option 1 instead.${RESET}\n`);
    totalAdded = 0;
  } else {
    const confirm = await question(`${RED}Run research?${RESET} This costs API credits! (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    divider();
    const startTimeReal = Date.now();

    const { runResearch } = await import('./researcher.js');
    const { runReview } = await import('./reviewer.js');
    const { addFindings } = await import('./findings.js');
    const { git } = await import('./git.js');
    const { canonicalizeUrl } = await import('./utils.js');

    // Sequential Processing
    for (let i = 0; i < batchSize; i++) {
      const cat = CATEGORIES[state.categoryIndex];
      if (!cat) break;

      process.stdout.write(`\n${BOLD}[${i + 1}/${batchSize}]${RESET} Processing: ${cat.name} ... `);

      try {
        // 1. Research
        const logFn = (msg: string) => process.stdout.write(`\n  ${DIM}${msg}${RESET}\n`);
        const catHistory = state.queryHistory[cat.key] || {};
        const result = await runResearch(cat.researchQuery, cat.key, cat.name, catHistory, store, state, logFn);
        
        // Update query history
        const now = new Date().toISOString();
        if (!state.queryHistory[cat.key]) state.queryHistory[cat.key] = {};
        for (const q of result.queries) {
          state.queryHistory[cat.key]![q] = now;
        }

        // Advance index
        const nextIndex = (state.categoryIndex + 1) % CATEGORY_COUNT;
        state.categoryIndex = nextIndex;

        const reviewInput = result.findings.length > 0 ? result.findings : result.rawReport;

        if (reviewInput) {
          const isRaw = typeof reviewInput === 'string';
          const logMsg = isRaw ? 'raw report found' : `${result.findings.length} findings found`;
          process.stdout.write(`${GREEN}${logMsg}${RESET}\n`);
          console.log(`  ${BOLD}Starting review...${RESET}`);

          // 2. Review
          const reviewed = await runReview(reviewInput, logFn);

          // 3. Save
          const added = await addFindings(store, state, cat.key, reviewed, cat.researchQuery, logFn);
          totalAdded += added.length;

          // Mark as seen
          if (!state.seenUrls[cat.key]) state.seenUrls[cat.key] = [];
          const sourceArray = isRaw ? reviewed : result.findings;
          for (const raw of sourceArray) {
            const canonical = canonicalizeUrl(raw.url);
            if (!state.seenUrls[cat.key].includes(canonical)) {
              state.seenUrls[cat.key].push(canonical);
            }
          }

          saveFindings(store);
          saveState(state);

          if (added.length > 0) {
            console.log(`  ${GREEN}Added ${added.length} findings, pushing...${RESET}`);
            if (isGitRepo() && remoteExists() && hasDataChanges()) {
              commitAndPush(added.length, cat.name, logFn);
            }
          } else {
            console.log(`  ${DIM}No new findings after review.${RESET}`);
            if (isGitRepo() && remoteExists() && hasDataChanges()) {
              commitAndPush(0, cat.name, logFn);
            }
          }
        } else {
          process.stdout.write(`${DIM}no discoveries${RESET}\n`);
          saveState(state);
          if (isGitRepo() && remoteExists() && hasDataChanges()) {
            commitAndPush(0, cat.name, logFn);
          }
        }
      } catch (err) {
        process.stdout.write(`${RED}ERROR${RESET}\n`);
        console.error(`\n${RED}  ${String(err)}${RESET}`);
        if (err instanceof Error && err.stack) {
          console.error(`${DIM}${err.stack}${RESET}`);
        }
        console.log(`\n${YELLOW}Stopping batch due to error. Category index is ${state.categoryIndex}.${RESET}`);
        totalErrors++;
        await pressEnter();
        break;
      }
      divider();
    }
  }

  divider();
  const elapsedTime = elapsed(startTime);
  console.log();
  console.log(`${BOLD}Results:${RESET}`);
  console.log(`  Duration:  ${CYAN}${elapsedTime}${RESET}`);
  console.log(`  Errors:    ${totalErrors > 0 ? RED : GREEN}${totalErrors}${RESET}`);

  if (!dryRun) {
    console.log(`  New items: ${GREEN}+${totalAdded}${RESET}`);
    console.log(`  Total:     ${CYAN}${store.findings.length}${RESET} findings`);
    console.log(`\n${DIM}Findings saved and pushed.${RESET}`);
  }
}

// ── Option 3: Statistics ──────────────────────────────────────────────────────

async function showStats(): Promise<void> {
  banner();
  console.log(`${BOLD}${BLUE}STATISTICS${RESET}`);
  divider();

  const store = loadFindings();
  const state = loadState();
  const findings = store.findings;

  // Basic counts
  console.log(`  ${BOLD}Findings:${RESET}`);
  console.log(`    Total entries:   ${CYAN}${store.totalFindings}${RESET}`);
  console.log(`    Last updated:    ${CYAN}${store.lastUpdated.slice(0, 10)}${RESET}`);
  console.log();

  // Severity breakdown
  const severityCounts: Record<string, number> = {};
  for (const f of findings) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;

  console.log(`  ${BOLD}By severity:${RESET}`);
  for (const sv of ['high', 'medium', 'low'] as const) {
    const color = sv === 'high' ? RED : sv === 'medium' ? YELLOW : DIM;
    const count = severityCounts[sv] ?? 0;
    const bar = '█'.repeat(Math.min(count, 30));
    console.log(`    ${color}${sv.padEnd(6)} ${String(count).padStart(4)} ${bar}${RESET}`);
  }
  console.log();

  // Category breakdown
  console.log(`  ${BOLD}By category (top 10):${RESET}`);
  const catCounts: Record<string, number> = {};
  for (const f of findings) catCounts[f.category] = (catCounts[f.category] ?? 0) + 1;
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats.slice(0, 10)) {
    const catName = CATEGORIES.find(c => c.key === cat)?.name ?? cat;
    const bar = '█'.repeat(Math.min(count, 25));
    console.log(`    ${DIM}${String(count).padStart(3)}${RESET} ${catName.padEnd(30)} ${CYAN}${bar}${RESET}`);
  }
  console.log();

  // State info
  console.log(`  ${BOLD}Run state:${RESET}`);
  console.log(`    Category index:  ${CYAN}${state.categoryIndex}${RESET} (${CATEGORIES[state.categoryIndex]?.name ?? 'N/A'})`);
  const totalSeen = Object.values(state.seenUrls).reduce((acc, urls) => acc + urls.length, 0);
  console.log(`    Seen URLs:       ${CYAN}${totalSeen}${RESET}`);
  console.log(`    Last run:        ${CYAN}${state.lastRun.slice(0, 10)}${RESET}`);
  console.log();

  // Domains
  const domains: Record<string, number> = {};
  for (const f of findings) domains[f.domain] = (domains[f.domain] ?? 0) + 1;
  const topDomains = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topDomains.length > 0) {
    console.log(`  ${BOLD}Top domains:${RESET}`);
    for (const [domain, count] of topDomains) {
      console.log(`    ${DIM}${String(count).padStart(3)}${RESET}  ${domain}`);
    }
    console.log();
  }

  await pressEnter();
}

// ── Option 4: View findings ───────────────────────────────────────────────────

async function viewFindings(): Promise<void> {
  banner();
  console.log(`${BOLD}${MAGENTA}VIEW FINDINGS${RESET}`);
  divider();

  const store = loadFindings();
  if (store.findings.length === 0) {
    console.log(`${YELLOW}No findings yet. Run a research batch first.${RESET}`);
    await pressEnter();
    return;
  }

  console.log(`  ${DIM}1${RESET})  Recent findings (last 20)`);
  console.log(`  ${DIM}2${RESET})  By category`);
  console.log(`  ${DIM}3${RESET})  By severity`);
  const choice = (await question(`\n${DIM}Choose:${RESET} `)).trim();

  let items = store.findings;

  if (choice === '2') {
    const catInput = await question(`${DIM}Category key (e.g. climate_denial):${RESET} `);
    items = items.filter(f => f.category === catInput.trim());
  } else if (choice === '3') {
    const sevInput = await question(`${DIM}Severity (high/medium/low):${RESET} `);
    items = items.filter(f => f.severity === sevInput.trim().toLowerCase());
  }

  banner();
  const show = items.slice(0, 20);
  for (let i = 0; i < show.length; i++) {
    const f = show[i]!;
    const sevColor = f.severity === 'high' ? RED : f.severity === 'medium' ? YELLOW : DIM;
    console.log(`  ${CYAN}${i + 1}${RESET}  ${sevColor}[${f.severity.toUpperCase()}]${RESET} ${f.title}`);
    console.log(`      ${DIM}${f.url}${RESET}`);
    console.log(`      ${DIM}${f.domain} · ${f.category} · ${f.foundAt.slice(0, 10)}${RESET}`);
    console.log(`      ${f.summary.slice(0, 120)}`);
    if (i < show.length - 1) console.log();
  }

  if (items.length > 20) {
    console.log(`${DIM}... and ${items.length - 20} more${RESET}`);
  }

  await pressEnter();
}

// ── Option 5: Reset state ─────────────────────────────────────────────────────

async function resetState(): Promise<void> {
  banner();
  console.log(`${BOLD}${YELLOW}RESET CATEGORY INDEX${RESET}`);
  divider();

  const state = loadState();
  console.log(`  Current index: ${CYAN}${state.categoryIndex}${RESET}`);
  console.log(`  Current category: ${CYAN}${CATEGORIES[state.categoryIndex]?.name ?? 'N/A'}${RESET}`);
  console.log();
  console.log(`${RED}This resets the category index back to 0, so the next run${RESET}`);
  console.log(`${RED}starts from the first category again.${RESET}`);
  console.log();

  const confirm = await question(`Reset to 0?${YELLOW} (y/N)${RESET}: `);
  if (confirm.toLowerCase() === 'y') {
    state.categoryIndex = 0;
    saveState(state);
    console.log(`${GREEN}Category index reset to 0${RESET}`);
  } else {
    console.log(`${DIM}Cancelled.${RESET}`);
  }

  await pressEnter();
}

// ── Option 6: Setup cron ──────────────────────────────────────────────────────

async function setupCron(): Promise<void> {
  banner();
  console.log(`${BOLD}${BLUE}WEEKLY CRON JOB${RESET}`);
  divider();

  const scriptPath = join(REPO_ROOT, 'scripts', 'setup-cron.sh');
  if (!existsSync(scriptPath)) {
    console.log(`${RED}setup-cron.sh not found at ${scriptPath}${RESET}`);
    await pressEnter();
    return;
  }

  console.log(`  This will add a cron entry to run the research agent`);
  console.log(`  every ${CYAN}Monday at 08:00${RESET}.`);
  console.log();

  const confirm = await question(`Run setup-cron.sh?${YELLOW} (y/N)${RESET}: `);
  if (confirm.toLowerCase() === 'y') {
    try {
      execSync(`bash "${scriptPath}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch (err) {
      console.log(`${RED}Cron setup failed: ${String(err).split('\n')[0]}${RESET}`);
    }
  }

  await pressEnter();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pressEnter(): Promise<void> {
  return question(`\n${DIM}Press Enter to continue...${RESET}`).then(() => {});
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      banner();

      // Quick status bar
      const store = loadFindings();
      const state = loadState();
      const batch = getBatch(state.categoryIndex, 3);

      console.log(`  ${BOLD}Status:${RESET}  ${CYAN}${store.findings.length}${RESET} findings`);
      console.log(`           ${CYAN}${state.categoryIndex}${RESET} / ${CATEGORY_COUNT} categories done`);
      console.log(`           Next up: ${DIM}${batch.slice(0, 3).map(c => c.name).join(', ')}${RESET}`);
      console.log();

      printMenu();

      const choice = (await question(`  ${BOLD}${GREEN}Select option${RESET} [1-7]: `)).trim();

      switch (choice) {
        case '1':
          await runResearchBatch(false);
          break;
        case '2':
          await runResearchBatch(true);
          break;
        case '3':
          await showStats();
          break;
        case '4':
          await viewFindings();
          break;
        case '5':
          await resetState();
          break;
        case '6':
          await setupCron();
          break;
        case '7':
          console.log(`\n${GREEN}Goodbye!${RESET}\n`);
          const { shutdownResearch } = await import('./researcher.js');
          await shutdownResearch();
          rl.close();
          process.exit(0);
        default:
          console.log(`\n${RED}Invalid option.${RESET}`);
          await new Promise(r => setTimeout(r, 800));
      }
    }
  } catch (err) {
    console.error(`${RED}FATAL:${RESET}`, err);
    rl.close();
    process.exit(1);
  }
}

main();
