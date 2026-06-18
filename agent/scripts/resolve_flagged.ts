/**
 * resolve_flagged.ts — Batched resolution pass for ambiguous flagged entries.
 *
 * Reads data/flagged-review.json and resolves entries in batches of 5.
 * Each batch: scrape all 5 articles (via pi-research scrapeUrl), then one
 * Qwen3.6 call for the batch with full prior-flag context per entry.
 *
 * Model: Qwen3.6-35B (WORKHORSE_MODEL_ID) — same as the inline pipeline.
 * DeepSeek is NOT used here; it is reserved for the large-scale batch layer 3
 * passes (sample_audit.ts, full_audit.ts).
 *
 * Decision policy:
 *   KEEP or FIX_IN_PLACE → apply and remove from flagged-review.json
 *   REMOVE               → remove from corpus + tombstone + clear from store
 *   FLAG_FOR_REVIEW      → increment resolveAttempts
 *   Exhausted (>= maxResolveAttempts) → REMOVED from corpus at start of run
 *
 * "Still ambiguous after max attempts → remove" is strict: unverifiable entries
 * do not stay in the corpus.
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
import { getOpenRouterModel, completeText, WORKHORSE_MODEL_ID } from '../src/models.js';
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
const BATCH_SIZE = 5;
const SCRAPE_CONCURRENCY = 5;
const SCRAPE_TIMEOUT_MS = 90_000;
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 12_000; // wider window for retry context

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

log(`Flagged-review: ${allFlagged.length} total — ${pending.length} pending, ${exhausted.length} exhausted (→ remove)`);
if (DRY_RUN) log('DRY RUN — no writes');

if (pending.length === 0 && exhausted.length === 0) {
  log('Nothing to resolve — flagged-review.json is clear.');
  process.exit(0);
}

// Remove exhausted entries immediately — they've had their chances.
if (!DRY_RUN && exhausted.length > 0) {
  log(`\nRemoving ${exhausted.length} entries that exhausted maxResolveAttempts (${MAX_ATTEMPTS}):`);
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
    log(`  ✗ EXPIRED  ${url}`);
    state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
  }
  state.lastRun = new Date().toISOString();
  writeAtomic(STATE_PATH, state);

  flagStore.flagged = flagStore.flagged.filter((e: FlaggedEntry) => !exhaustedUrls.has(e.url));
  writeAtomic(FLAGGED_PATH, flagStore);
  log(`Removed ${before - latest.findings.length} exhausted entries`);
}

if (pending.length === 0) {
  log('No pending entries — done.');
  process.exit(0);
}

const currentFindings: any[] = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).findings;
const findingByUrl = new Map(currentFindings.map((f: any) => [f.url, f]));

await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log(`SDK initialized — resolving ${pending.length} entries in batches of ${BATCH_SIZE} (${WORKHORSE_MODEL_ID})`);

const model = await getOpenRouterModel(WORKHORSE_MODEL_ID, { reasoning: true });

// Accumulate decisions across all batches, apply atomically at the end
const toRemove = new Set<string>();
const toFix: AuditResult[] = [];
const toKeep: string[] = [];
const updatedAttempts = new Map<string, { attempts: number; result: AuditResult | null }>();
let totalErrors = 0;

const totalBatches = Math.ceil(pending.length / BATCH_SIZE);

try {
  for (let b = 0; b < totalBatches; b++) {
    const batch = pending.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    log(`\nBatch ${b + 1}/${totalBatches} — ${batch.length} entries`);

    // Scrape all entries in the batch concurrently
    const scrapeResults = await mapWithConcurrency(batch, SCRAPE_CONCURRENCY, async (entry: FlaggedEntry, idx: number) => {
      const article = await scrapeOne(entry.url);
      log(`  [${idx + 1}/${batch.length}] ${entry.url.replace(/^https?:\/\//, '').slice(0, 55)} — ${article ? article.length + ' chars' : 'unavail'}`);
      return { entry, article };
    });

    const scraped = scrapeResults.map((r, i) =>
      r.ok ? r.value : { entry: batch[i]!, article: null }
    );
    const gotArticle = scraped.filter(s => s.article).length;
    log(`  scraped ${gotArticle}/${batch.length}`);

    // Build audit items with prior flag context
    const auditItems = scraped.map(({ entry, article }) => {
      const finding = findingByUrl.get(entry.url);
      return {
        url: entry.url,
        title: entry.title,
        category: entry.category,
        severity: entry.severity,
        summary: finding?.summary ?? '',
        whyBad: finding?.whyBad ?? '',
        article,
        priorFlagNote: `Flagged by ${entry.flaggedBy} (attempt ${entry.resolveAttempts + 1}/${MAX_ATTEMPTS}): ${entry.auditResult.dim1_note} — ${entry.auditResult.overall_reason}`,
      };
    });

    const userText = buildAuditText(auditItems);
    log(`  prompt ~${Math.round((AUDIT_SYSTEM.length + userText.length) / 4)} tokens — calling Qwen3.6...`);

    let batchResults: AuditResult[] = [];
    try {
      const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
        reasoning: 'medium',
        temperature: 0.15,
        timeoutMs: 240_000, // 4 min for 5 entries
      });

      const m = rawResponse.match(/\[[\s\S]*\]/);
      batchResults = JSON.parse(m ? m[0] : rawResponse.trim());
    } catch (e) {
      log(`  batch ${b + 1} error: ${String(e).slice(0, 100)} — skipping batch, will retry next run`);
      totalErrors += batch.length;
      continue;
    }

    for (const result of batchResults) {
      const entry = batch.find(e => e.url === result.id);
      if (!entry) continue;

      const verdict = result.overall;
      log(`  ${verdict === 'KEEP' ? '✓' : verdict === 'FIX_IN_PLACE' ? '✎' : verdict === 'REMOVE' ? '✗' : '⚑'} ${verdict.padEnd(14)} ${result.id.replace(/^https?:\/\//, '').slice(0, 50)}`);

      if (verdict === 'KEEP') {
        toKeep.push(entry.url);
        updatedAttempts.set(entry.url, { attempts: entry.resolveAttempts, result });
      } else if (verdict === 'FIX_IN_PLACE') {
        toFix.push(result);
        updatedAttempts.set(entry.url, { attempts: entry.resolveAttempts, result });
      } else if (verdict === 'REMOVE') {
        toRemove.add(entry.url);
        updatedAttempts.set(entry.url, { attempts: entry.resolveAttempts, result });
      } else {
        // FLAG_FOR_REVIEW — increment; if now at max, schedule removal
        const newAttempts = entry.resolveAttempts + 1;
        updatedAttempts.set(entry.url, { attempts: newAttempts, result });
        if (newAttempts >= MAX_ATTEMPTS) {
          log(`    → reached max attempts, scheduled for removal`);
          toRemove.add(entry.url);
        }
      }
    }
  }
} finally {
  await shutdownResearchSDK();
}

// ── Apply all decisions atomically ────────────────────────────────────────────

const decidedUrls = new Set([...toKeep, ...toFix.map(r => r.id), ...toRemove]);

if (!DRY_RUN && decidedUrls.size > 0) {
  const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));

  for (const f of latest.findings) {
    const fix = toFix.find(r => r.id === f.url);
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

  const before = latest.findings.length;
  latest.findings = latest.findings.filter((f: any) => !toRemove.has(f.url));
  latest.totalFindings = latest.findings.length;
  latest.lastUpdated = new Date().toISOString();
  writeAtomic(FINDINGS_PATH, latest);

  if (toRemove.size > 0) {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
    for (const url of toRemove) state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
    state.lastRun = new Date().toISOString();
    writeAtomic(STATE_PATH, state);
    log(`Removed ${before - latest.findings.length} entries, tombstoned`);
  }

  // Update flagged-review.json — drop resolved, update attempt counts
  const freshFlagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
  const updatedFlagged: FlaggedEntry[] = [];
  let totalResolved = 0;

  for (const entry of freshFlagStore.flagged as FlaggedEntry[]) {
    const decision = updatedAttempts.get(entry.url);
    if (!decision) {
      updatedFlagged.push(entry); // not in this run (limit or error)
      continue;
    }
    if (decidedUrls.has(entry.url)) {
      // Confidently resolved (keep, fix, or remove) — clear from store
      totalResolved++;
      continue;
    }
    // Still ambiguous but below max — update with latest result + incremented count
    updatedFlagged.push({
      ...entry,
      resolveAttempts: decision.attempts,
      auditResult: decision.result ?? entry.auditResult,
    });
  }

  freshFlagStore.flagged = updatedFlagged;
  writeAtomic(FLAGGED_PATH, freshFlagStore);

  const finalFlagCount = freshFlagStore.flagged.length;
  const finalCorpus = latest.totalFindings;

  console.log('\n' + '='.repeat(60));
  console.log('RESOLUTION PASS COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Attempted:       ${pending.length}`);
  console.log(`  Kept:            ${toKeep.length}`);
  console.log(`  Fixed:           ${toFix.length}`);
  console.log(`  Removed:         ${toRemove.size}`);
  console.log(`  Still ambiguous: ${updatedFlagged.filter(e => updatedAttempts.has(e.url)).length}`);
  console.log(`  Errors (retry):  ${totalErrors}`);
  console.log(`  Resolved total:  ${totalResolved}`);
  console.log(`  Remaining flags: ${finalFlagCount}`);
  console.log(`  Corpus:          ${finalCorpus}`);

  if (finalFlagCount > 0) {
    const atMax = (freshFlagStore.flagged as FlaggedEntry[]).filter(e => e.resolveAttempts >= MAX_ATTEMPTS).length;
    if (atMax > 0) log(`${atMax} entries will be removed next run (reached max attempts)`);
  }
}
