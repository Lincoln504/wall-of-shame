/**
 * resolve_flagged.ts — Targeted resolution pass for ambiguous entries.
 *
 * Reads data/flagged-review.json and attempts to resolve each entry with a
 * deeper scrape + DeepSeek analysis that has full context on WHY it was flagged.
 *
 * Decision policy:
 *   KEEP or FIX_IN_PLACE → apply and remove from flagged-review.json
 *   REMOVE               → remove from corpus + tombstone + remove from flagged-review.json
 *   FLAG_FOR_REVIEW      → increment resolveAttempts; if attempts >= maxResolveAttempts → REMOVE
 *
 * The "still ambiguous after max attempts → remove" rule enforces that only
 * verifiably qualifying entries remain in the corpus. If we cannot confirm
 * an entry meets criteria, it does not belong.
 *
 * Runs automatically from scale-loop.sh after each maintenance audit when
 * flagged-review.json has unresolved entries.
 *
 * Usage:
 *   cd agent && npx tsx scripts/resolve_flagged.ts [--dry-run] [--limit N]
 *
 *   --dry-run   report only, no writes
 *   --limit N   process at most N flagged entries per run (default: all)
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeUrl, initResearchSDK, shutdownResearchSDK } from '@lincoln504/pi-research';
import { getOpenRouterModel, completeText, VERIFY_MODEL_ID } from '../src/models.js';
import { mapWithConcurrency } from '../src/utils.js';
import { canonicalizeUrl } from '../src/utils.js';
import { AUDIT_SYSTEM, buildAuditText, VALID_CATEGORIES, VALID_SEVERITIES, type AuditResult, type FlaggedEntry } from './audit-criteria.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');
const FLAGGED_PATH = join(DATA_DIR, 'flagged-review.json');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='))?.split('=')[1];
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG) : Infinity;
const SCRAPE_TIMEOUT_MS = 90_000; // longer timeout for retry scrapes
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 12_000; // wider window than batch audit for deeper context

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

function writeAtomic(path: string, data: unknown) {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

async function scrapeOne(url: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), SCRAPE_TIMEOUT_MS);
  });
  try {
    let res;
    try { res = await Promise.race([scrapeUrl(url), timeout]); }
    finally { if (timer) clearTimeout(timer); }
    if (!res.success || !res.markdown || res.markdown.trim().length < MIN_ARTICLE_CHARS) return null;
    return res.markdown.trim().slice(0, MAX_ARTICLE_CHARS);
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const flagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
const MAX_ATTEMPTS: number = flagStore.maxResolveAttempts ?? 3;
const allFlagged: FlaggedEntry[] = flagStore.flagged;

const pending = allFlagged.filter(e => e.resolveAttempts < MAX_ATTEMPTS).slice(0, LIMIT);
const exhausted = allFlagged.filter(e => e.resolveAttempts >= MAX_ATTEMPTS);

log(`Flagged-review: ${allFlagged.length} total — ${pending.length} pending resolution, ${exhausted.length} exhausted (→ remove)`);

if (DRY_RUN) log('DRY RUN — no writes');

if (pending.length === 0 && exhausted.length === 0) {
  log('Nothing to resolve — flagged-review.json is clear.');
  process.exit(0);
}

// Entries that have hit max attempts get removed immediately — no more chances.
if (!DRY_RUN && exhausted.length > 0) {
  log(`\nRemoving ${exhausted.length} entries that hit maxResolveAttempts (${MAX_ATTEMPTS}) without confirmation:`);
  const exhaustedUrls = new Set(exhausted.map(e => e.url));

  const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
  const before = latest.findings.length;
  latest.findings = latest.findings.filter((f: any) => !exhaustedUrls.has(f.url));
  latest.totalFindings = latest.findings.length;
  latest.lastUpdated = new Date().toISOString();
  writeAtomic(FINDINGS_PATH, latest);

  const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
  for (const url of exhaustedUrls) {
    log(`  ✗ EXPIRED ${url}`);
    state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
  }
  state.lastRun = new Date().toISOString();
  writeAtomic(STATE_PATH, state);

  // Remove exhausted entries from flag store
  flagStore.flagged = flagStore.flagged.filter((e: FlaggedEntry) => !exhaustedUrls.has(e.url));
  writeAtomic(FLAGGED_PATH, flagStore);

  log(`Removed ${before - latest.findings.length} exhausted entries from corpus`);
}

if (pending.length === 0) {
  log('No pending entries to resolve.');
  process.exit(0);
}

await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log(`SDK initialized — resolving ${pending.length} entries`);

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });

let totalResolved = 0;
let totalStillAmbiguous = 0;

try {
  // Scrape all pending entries with wider context window
  log('\nScraping flagged entries...');
  const scrapeResults = await mapWithConcurrency(pending, 4, async (entry: FlaggedEntry, idx: number) => {
    const article = await scrapeOne(entry.url);
    log(`  [${idx + 1}/${pending.length}] ${entry.url.replace(/^https?:\/\//, '').slice(0, 50)} — ${article ? article.length + ' chars' : 'unavail'}`);
    return { entry, article };
  });

  const items = scrapeResults.map(r => r.ok ? r.value : { entry: pending[scrapeResults.indexOf(r)]!, article: null });
  const gotArticle = items.filter(it => it.article).length;
  log(`Scraped ${gotArticle}/${items.length}`);

  // Build prompt items with prior flag context included
  const auditItems = items.map(({ entry, article }) => ({
    url: entry.url,
    title: entry.title,
    category: entry.category,
    severity: entry.severity,
    summary: '', // we load from current findings below
    whyBad: '',
    article,
    priorFlagNote: `${entry.auditResult.dim1_note} | ${entry.auditResult.overall_reason} (attempt ${entry.resolveAttempts + 1}/${MAX_ATTEMPTS})`,
  }));

  // Populate summary/whyBad from current findings
  const currentFindings: any[] = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).findings;
  for (const item of auditItems) {
    const f = currentFindings.find(f => f.url === item.url);
    if (f) { item.summary = f.summary; item.whyBad = f.whyBad; }
  }

  const userText = buildAuditText(auditItems);
  log(`Prompt ~${Math.round((AUDIT_SYSTEM.length + userText.length) / 4)} tokens — calling DeepSeek...`);
  const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
    reasoning: 'high', // higher effort for resolution pass
    temperature: 0.15,
    timeoutMs: 600_000,
  });

  let results: AuditResult[] = [];
  try {
    const m = rawResponse.match(/\[[\s\S]*\]/);
    results = JSON.parse(m ? m[0] : rawResponse.trim());
  } catch (e) {
    log(`Parse error: ${String(e).slice(0, 100)} — writing raw to /tmp/wos_resolve_raw.txt`);
    writeFileSync('/tmp/wos_resolve_raw.txt', rawResponse);
    process.exitCode = 1;
  }

  if (process.exitCode !== 1 && results.length > 0) {
    const keeps   = results.filter(r => r.overall === 'KEEP');
    const fixes   = results.filter(r => r.overall === 'FIX_IN_PLACE');
    const removes = results.filter(r => r.overall === 'REMOVE');
    const still   = results.filter(r => r.overall === 'FLAG_FOR_REVIEW');

    log(`\nResolution: KEEP ${keeps.length} / FIX ${fixes.length} / REMOVE ${removes.length} / STILL AMBIGUOUS ${still.length}`);

    keeps.forEach(r => log(`  ✓ KEEP    ${r.id}`));
    fixes.forEach(r => log(`  ✎ FIX     ${r.id} — ${r.overall_reason}`));
    removes.forEach(r => log(`  ✗ REMOVE  ${r.id} — ${r.overall_reason}`));
    still.forEach(r => log(`  ⚑ STILL   ${r.id} — ${r.overall_reason}`));

    if (!DRY_RUN) {
      const removeUrls = new Set([...removes.map(r => r.id)]);
      const fixMap = new Map(fixes.map(r => [r.id, r]));
      const resolvedUrls = new Set([...keeps, ...fixes, ...removes].map(r => r.id));

      const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));

      // Apply fixes
      for (const f of latest.findings) {
        const fix = fixMap.get(f.url);
        if (!fix) continue;
        if (fix.corrected_summary) f.summary = fix.corrected_summary;
        if (fix.corrected_whybad) f.whyBad = fix.corrected_whybad;
        if (fix.corrected_category && (VALID_CATEGORIES as readonly string[]).includes(fix.corrected_category)) {
          f.category = fix.corrected_category;
        }
        if (fix.corrected_severity && (VALID_SEVERITIES as readonly string[]).includes(fix.corrected_severity as any)) {
          f.severity = fix.corrected_severity;
        }
      }

      // Apply removals
      latest.findings = latest.findings.filter((f: any) => !removeUrls.has(f.url));
      latest.totalFindings = latest.findings.length;
      latest.lastUpdated = new Date().toISOString();
      writeAtomic(FINDINGS_PATH, latest);

      if (removeUrls.size > 0) {
        const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
        if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
        for (const url of removeUrls) state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
        state.lastRun = new Date().toISOString();
        writeAtomic(STATE_PATH, state);
      }

      // Update flagged-review.json
      const freshFlagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
      const updatedFlagged: FlaggedEntry[] = [];
      for (const entry of freshFlagStore.flagged as FlaggedEntry[]) {
        if (resolvedUrls.has(entry.url)) {
          // Resolved — drop from store
          totalResolved++;
          continue;
        }
        const stillResult = still.find(r => r.id === entry.url);
        if (stillResult) {
          // Still ambiguous — increment attempt count; if now at max, it will be removed next run
          const updated = {
            ...entry,
            resolveAttempts: entry.resolveAttempts + 1,
            auditResult: stillResult, // update with latest audit result
          };
          updatedFlagged.push(updated);
          totalStillAmbiguous++;
          if (updated.resolveAttempts >= MAX_ATTEMPTS) {
            log(`  ⚑ ${entry.url} — reached max attempts (${MAX_ATTEMPTS}), will be REMOVED next run`);
          }
        } else {
          // Not in this batch (--limit was used or wasn't pending)
          updatedFlagged.push(entry);
        }
      }
      freshFlagStore.flagged = updatedFlagged;
      writeAtomic(FLAGGED_PATH, freshFlagStore);

      log(`\nFlagged-review.json: ${updatedFlagged.length} remaining (${totalResolved} resolved this run)`);
    }
  }
} finally {
  await shutdownResearchSDK();
}

const finalFlagCount = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8')).flagged.length;
const finalCorpus = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).totalFindings;
console.log('\n' + '='.repeat(60));
console.log('RESOLUTION PASS COMPLETE');
console.log('='.repeat(60));
console.log(`  Attempted:       ${pending.length}`);
console.log(`  Resolved:        ${totalResolved}`);
console.log(`  Still ambiguous: ${totalStillAmbiguous}`);
console.log(`  Remaining flags: ${finalFlagCount}`);
console.log(`  Corpus:          ${finalCorpus}`);
if (finalFlagCount > 0) {
  log(`${finalFlagCount} entries remain in flagged-review.json — run again or review manually.`);
}
