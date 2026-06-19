/**
 * resolve_flagged.ts — Deep, single-run resolution of ALL flagged entries.
 *
 * This is the investigation layer AFTER the big-context DeepSeek batch verify: when the
 * maintenance audit flags an entry as ambiguous, this pass investigates it deeply and reaches
 * a CONCRETE terminal verdict. Per project direction it is NOT a queue spread over rounds — it
 * treats the flagged set as a cue to clear NOW: every flagged entry is investigated, retried
 * within THIS run if it comes back ambiguous, and given a terminal verdict (KEEP / FIX / REMOVE)
 * before the run ends. The queue should be empty (or only budget-deferred) after each run.
 *
 * Model: GLM-4.7 (glm-coding, reasoning-capable, 200K ctx) — the deep single-entry investigator.
 * It is distinct from the big-context DeepSeek V4 Pro batch verify, which stays as-is.
 *
 * Each batch: scrape all entries' articles (pi-research scrapeUrl), then one GLM call with full
 * prior-flag context per entry. Verdicts:
 *   KEEP / FIX_IN_PLACE → apply, drop from flagged-review.json
 *   REMOVE              → drop from corpus + tombstone
 *   FLAG_FOR_REVIEW     → re-investigated in the next INNER round this run; once an entry has
 *                         been investigated maxResolveAttempts times (across rounds + runs) and
 *                         is still ambiguous, it is REMOVED (unverifiable entries don't linger).
 *
 * Entries not reached before the wall-clock budget (WOS_RESOLVE_BUDGET_MS, default 840s — under
 * the loop's 900s timeout) are left for the next cycle with their attempt count unchanged.
 *
 * Usage:
 *   cd agent && npx tsx scripts/resolve_flagged.ts [--dry-run] [--limit=N]
 *     --dry-run   report only, no writes
 *     --limit=N   cap entries considered this run (default: all)
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeUrl, initResearchSDK, shutdownResearchSDK } from '@lincoln504/pi-research';
import { getModel, getOpenRouterModel, completeText, GLM_CODING_PROVIDER, GLM_MODEL_ID, WORKHORSE_MODEL_ID } from '../src/models.js';
import { mapWithConcurrency, canonicalizeUrl, isErrorOrBlockedPage, safeParseJson } from '../src/utils.js';
import { AUDIT_SYSTEM, RESOLVE_ADDENDUM, buildAuditText, VALID_CATEGORIES, VALID_SEVERITIES, type AuditResult, type FlaggedEntry } from './audit-criteria.js';

const RESOLVE_SYSTEM = AUDIT_SYSTEM + RESOLVE_ADDENDUM;

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
const MAX_ARTICLE_CHARS = 12_000;
// Investigate a still-ambiguous entry up to this many INNER rounds within ONE run, so the
// queue is cleared now rather than deferred across audit cycles.
const MAX_INNER_ROUNDS = Math.max(1, Number(process.env['WOS_RESOLVE_INNER_ROUNDS']) || 3);
// Stop starting new batches past this wall-clock budget so the run finishes before the loop's
// 900s timeout SIGKILLs it (which would lose progress). Unreached entries wait for next cycle.
const BUDGET_MS = Math.max(60_000, Number(process.env['WOS_RESOLVE_BUDGET_MS']) || 840_000);

const startedAt = Date.now();
const budgetLeft = () => BUDGET_MS - (Date.now() - startedAt);

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
    const text = res.markdown?.trim() ?? '';
    if (!res.success || text.length < MIN_ARTICLE_CHARS || isErrorOrBlockedPage(text)) return null;
    return text.slice(0, MAX_ARTICLE_CHARS);
  } catch {
    return null;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
// Deep investigator = GLM-4.7 (coding plan). Fall back to the OpenRouter workhorse if the
// GLM provider is ever unavailable, so the queue still drains instead of hard-failing.
let model;
let modelLabel = `${GLM_CODING_PROVIDER}/${GLM_MODEL_ID}`;
try {
  model = await getModel(GLM_CODING_PROVIDER, GLM_MODEL_ID, { reasoning: false });
} catch (e) {
  modelLabel = `${WORKHORSE_MODEL_ID} (GLM unavailable: ${String(e).slice(0, 60)})`;
  model = await getOpenRouterModel(WORKHORSE_MODEL_ID, { reasoning: false });
}
log(`SDK initialized — draining ${pending.length} flagged entries this run (${modelLabel}, up to ${MAX_INNER_ROUNDS} inner rounds, budget ${Math.round(BUDGET_MS / 1000)}s)`);

// Terminal decisions accumulated across all inner rounds, applied atomically at the end.
const toRemove = new Set<string>();
const toFix: AuditResult[] = [];
const toKeep: string[] = [];
// Per-url running attempt count + latest result (for store update on leftover/terminal).
const attemptOf = new Map<string, number>(pending.map(e => [e.url, e.resolveAttempts]));
const latestResult = new Map<string, AuditResult>();
let totalErrors = 0;
let budgetStopped = false;

// Investigate one batch deeply; returns the parsed results (id-keyed by the model echo).
async function investigateBatch(batch: FlaggedEntry[], roundLabel: string): Promise<AuditResult[]> {
  const scrapeResults = await mapWithConcurrency(batch, SCRAPE_CONCURRENCY, async (entry: FlaggedEntry, idx: number) => {
    const article = await scrapeOne(entry.url);
    log(`  ${roundLabel} [${idx + 1}/${batch.length}] ${entry.url.replace(/^https?:\/\//, '').slice(0, 55)} — ${article ? article.length + ' chars' : 'unavail'}`);
    return { entry, article };
  });
  const scraped = scrapeResults.map((r, i) => (r.ok ? r.value : { entry: batch[i]!, article: null }));

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
      priorFlagNote: `Flagged by ${entry.flaggedBy} (investigation ${(attemptOf.get(entry.url) ?? 0) + 1}/${MAX_ATTEMPTS}): ${entry.auditResult.dim1_note} — ${entry.auditResult.overall_reason}`,
    };
  });

  const userText = buildAuditText(auditItems);
  try {
    const rawResponse = await completeText(model, RESOLVE_SYSTEM, userText, {
      reasoning: false, temperature: 0.15, timeoutMs: 240_000,
    });
    const parsed = safeParseJson<AuditResult[] | AuditResult>(rawResponse);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && (parsed as AuditResult).id) return [parsed as AuditResult];
    log(`  ${roundLabel} returned non-array JSON — batch deferred to next cycle`);
    totalErrors += batch.length;
    return [];
  } catch (e) {
    log(`  ${roundLabel} batch error: ${String(e).slice(0, 100)} — deferred to next cycle`);
    totalErrors += batch.length;
    return [];
  }
}

try {
  // Drain: investigate the working set; entries that come back FLAG_FOR_REVIEW are retried in
  // the next inner round THIS run until resolved, attempts exhausted, or the budget runs out.
  let carry: FlaggedEntry[] = pending;
  for (let round = 1; round <= MAX_INNER_ROUNDS && carry.length > 0; round++) {
    log(`\n── inner round ${round}/${MAX_INNER_ROUNDS} — ${carry.length} entr${carry.length === 1 ? 'y' : 'ies'} ──`);
    const nextCarry: FlaggedEntry[] = [];
    const batches = chunk(carry, BATCH_SIZE);

    for (let b = 0; b < batches.length; b++) {
      if (budgetLeft() <= 0) {
        budgetStopped = true;
        const remaining = batches.slice(b).flat();
        log(`  budget exhausted — ${remaining.length} entr${remaining.length === 1 ? 'y' : 'ies'} left for next cycle`);
        break;
      }
      const batch = batches[b]!;
      const results = await investigateBatch(batch, `r${round} batch ${b + 1}/${batches.length}`);
      const byId = new Map(results.filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));

      for (const entry of batch) {
        const result = byId.get(entry.url);
        if (!result) { nextCarry.push(entry); continue; } // model omitted it — retry next round

        // Safety net: corrected fields present but verdict says re-review → it has the evidence
        // to fix; upgrade to FIX_IN_PLACE so the correction is applied.
        if (result.overall === 'FLAG_FOR_REVIEW' && (result.corrected_summary || result.corrected_whybad)) {
          result.overall = 'FIX_IN_PLACE';
          log(`  ↑ upgraded FLAG_FOR_REVIEW→FIX_IN_PLACE: ${result.id.slice(0, 50)}`);
        }
        latestResult.set(entry.url, result);
        const verdict = result.overall;
        log(`  ${verdict === 'KEEP' ? '✓' : verdict === 'FIX_IN_PLACE' ? '✎' : verdict === 'REMOVE' ? '✗' : '⚑'} ${verdict.padEnd(14)} ${result.id.replace(/^https?:\/\//, '').slice(0, 50)}`);

        if (verdict === 'KEEP') { toKeep.push(entry.url); }
        else if (verdict === 'FIX_IN_PLACE') { toFix.push(result); }
        else if (verdict === 'REMOVE') { toRemove.add(entry.url); }
        else {
          // FLAG_FOR_REVIEW — count an investigation; retry this run if rounds + attempts allow,
          // else give a terminal verdict NOW (remove — unverifiable entries don't linger).
          const attempts = (attemptOf.get(entry.url) ?? 0) + 1;
          attemptOf.set(entry.url, attempts);
          if (attempts >= MAX_ATTEMPTS) {
            log(`    → ${attempts}/${MAX_ATTEMPTS} investigations, still ambiguous → REMOVE`);
            toRemove.add(entry.url);
          } else if (round < MAX_INNER_ROUNDS) {
            nextCarry.push({ ...entry, resolveAttempts: attempts });
          } else {
            // Last inner round and still ambiguous but below max — leave for next cycle.
            nextCarry.push({ ...entry, resolveAttempts: attempts });
          }
        }
      }
    }
    carry = budgetStopped ? [...nextCarry] : nextCarry;
    if (budgetStopped) break;
  }
  // Anything still in carry after the rounds/budget: leave flagged with updated attempts.
  for (const entry of carry) latestResult.set(entry.url, entry.auditResult);
} finally {
  await shutdownResearchSDK();
}

// ── Apply all decisions atomically ────────────────────────────────────────────

const terminalUrls = new Set([...toKeep, ...toFix.map(r => r.id), ...toRemove]);

if (!DRY_RUN && (terminalUrls.size > 0 || attemptOf.size > 0)) {
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

  // Update flagged-review.json — drop terminal verdicts, update attempt counts for leftovers.
  const freshFlagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
  const updatedFlagged: FlaggedEntry[] = [];
  let totalResolved = 0;

  for (const entry of freshFlagStore.flagged as FlaggedEntry[]) {
    if (terminalUrls.has(entry.url)) { totalResolved++; continue; } // resolved this run → clear
    const attempts = attemptOf.get(entry.url);
    if (attempts === undefined) { updatedFlagged.push(entry); continue; } // not touched this run
    // Still ambiguous (budget/round deferred) — persist updated attempt count + latest note.
    updatedFlagged.push({ ...entry, resolveAttempts: attempts, auditResult: latestResult.get(entry.url) ?? entry.auditResult });
  }

  freshFlagStore.flagged = updatedFlagged;
  writeAtomic(FLAGGED_PATH, freshFlagStore);

  console.log('\n' + '='.repeat(60));
  console.log('RESOLUTION PASS COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Investigated:    ${pending.length}`);
  console.log(`  Kept:            ${toKeep.length}`);
  console.log(`  Fixed:           ${toFix.length}`);
  console.log(`  Removed:         ${toRemove.size}`);
  console.log(`  Resolved total:  ${totalResolved}`);
  console.log(`  Deferred:        ${updatedFlagged.filter(e => attemptOf.has(e.url)).length}${budgetStopped ? ' (budget)' : ''}`);
  console.log(`  Errors (retry):  ${totalErrors}`);
  console.log(`  Remaining flags: ${freshFlagStore.flagged.length}`);
  console.log(`  Corpus:          ${latest.totalFindings}`);
}
