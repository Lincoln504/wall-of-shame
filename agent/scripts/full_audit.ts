/**
 * full_audit.ts — Full-corpus DeepSeek verification pass.
 *
 * Iterates every entry in findings.json in batches, scrapes each article,
 * and runs DeepSeek V4 Pro against the canonical 7-dimension audit criteria
 * (from audit-criteria.ts). Confident decisions are applied immediately per batch.
 * Ambiguous entries (FLAG_FOR_REVIEW) are written to data/flagged-review.json.
 *
 * Safe to re-run: tombstoned URLs are skipped; flagged-review.json deduplicates.
 *
 * Usage:
 *   cd agent && npx tsx scripts/full_audit.ts [--batch-size N] [--dry-run] [--start-batch N]
 *
 *   --batch-size N   entries per DeepSeek call (default 30)
 *   --start-batch N  skip the first N-1 batches (resume after interruption)
 *   --dry-run        report only, no writes
 *
 * Output: /tmp/wos_full_audit_<timestamp>.json
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeUrl, initResearchSDK, shutdownResearchSDK } from '@lincoln504/pi-research';
import { getOpenRouterModel, completeText, VERIFY_MODEL_ID } from '../src/models.js';
import { mapWithConcurrency, canonicalizeUrl, safeParseJson } from '../src/utils.js';
import { AUDIT_SYSTEM, buildAuditText, VALID_CATEGORIES, VALID_SEVERITIES, type AuditResult, type FlaggedEntry } from './audit-criteria.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');
const FLAGGED_PATH = join(DATA_DIR, 'flagged-review.json');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1] ?? '15');
const START_BATCH = parseInt(process.argv.find(a => a.startsWith('--start-batch='))?.split('=')[1] ?? '1');
const SCRAPE_CONCURRENCY = 5;
const SCRAPE_TIMEOUT_MS = 60_000;
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 9_000;

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

log(`Full corpus audit — batch size ${BATCH_SIZE}${DRY_RUN ? ' (DRY RUN)' : ''}`);

let rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const totalBatches = Math.ceil(rawFindings.findings.length / BATCH_SIZE);
log(`Total: ${rawFindings.findings.length} entries → ${totalBatches} batches`);
if (START_BATCH > 1) log(`Resuming from batch ${START_BATCH}`);

const allResults: AuditResult[] = [];
let totalRemoved = 0;
let totalFixed = 0;
let totalFlagged = 0;

await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log('SDK initialized');

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: false });

try {
  for (let b = START_BATCH; b <= totalBatches; b++) {
    rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
    const currentFindings: any[] = rawFindings.findings;
    const batchStart = (b - 1) * BATCH_SIZE;
    const batch = currentFindings.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) { log(`Batch ${b}: empty — done`); break; }

    log(`\nBatch ${b}/${totalBatches} — entries ${batchStart + 1}–${batchStart + batch.length} of ${currentFindings.length}`);

    const scrapeResults = await mapWithConcurrency(batch, SCRAPE_CONCURRENCY, async (f: any, idx: number) => {
      const article = await scrapeOne(f.url);
      log(`  [${idx + 1}/${batch.length}] ${f.domain} — ${article ? article.length + ' chars' : 'unavail'}`);
      return { ...f, article };
    });
    const items = scrapeResults.map((r, i) => r.ok ? r.value : { ...batch[i]!, article: null });
    const gotArticle = items.filter((it: any) => it.article).length;
    log(`  scraped ${gotArticle}/${items.length}`);

    const userText = buildAuditText(items);
    log(`  prompt ~${Math.round((AUDIT_SYSTEM.length + userText.length) / 4)} tokens — calling DeepSeek...`);
    const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
      reasoning: false, temperature: 0.2, timeoutMs: 120_000,
    });

    let batchResults: AuditResult[] = [];
    try {
      batchResults = safeParseJson<AuditResult[]>(rawResponse);
    } catch (e) {
      log(`  parse error on batch ${b}: ${String(e).slice(0, 120)} — skipping batch`);
      writeFileSync(`/tmp/wos_full_audit_batch${b}_raw.txt`, rawResponse);
      continue;
    }

    allResults.push(...batchResults);

    const removes = batchResults.filter(r => r.overall === 'REMOVE');
    const fixes   = batchResults.filter(r => r.overall === 'FIX_IN_PLACE');
    const flags   = batchResults.filter(r => r.overall === 'FLAG_FOR_REVIEW');
    const keeps   = batchResults.filter(r => r.overall === 'KEEP');
    log(`  KEEP ${keeps.length} / FIX ${fixes.length} / FLAG ${flags.length} / REMOVE ${removes.length}`);

    removes.forEach(r => log(`  ✗ REMOVE ${r.id} — ${r.overall_reason}`));
    fixes.forEach(r => log(`  ✎ FIX    ${r.id} — ${r.overall_reason}`));
    flags.forEach(r => log(`  ⚑ FLAG   ${r.id} — ${r.overall_reason}`));

    if (!DRY_RUN && (removes.length > 0 || fixes.length > 0 || flags.length > 0)) {
      const removeUrls = new Set(removes.map(r => r.id));
      const fixMap = new Map(fixes.map(r => [r.id, r]));

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

      if (removes.length > 0) {
        // Audit-driven removals are QUALITY failures (bad/misclassified/unverifiable) — keep them
        // tombstoned so discovery never re-adds the same rejected content. (Any future
        // distribution/balancing-based pruning must NOT tombstone — those should stay rediscoverable.)
        const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
        if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
        for (const url of removeUrls) state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
        state.lastRun = new Date().toISOString();
        writeAtomic(STATE_PATH, state);
        log(`  tombstoned ${removes.length} URLs`);
      }

      if (removes.length > 0) log(`  applied: removed ${removes.length}`);
      if (fixes.length > 0) log(`  applied: fixed ${fixes.length} in place`);

      // Write flags to durable store
      if (flags.length > 0) {
        const flagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
        const existingUrls = new Set((flagStore.flagged as FlaggedEntry[]).map((e: FlaggedEntry) => e.url));
        const now = new Date().toISOString();
        let newFlags = 0;
        for (const r of flags) {
          if (existingUrls.has(r.id)) continue;
          const finding = latest.findings.find((f: any) => f.url === r.id);
          if (!finding) continue;
          flagStore.flagged.push({
            url: r.id,
            title: finding.title,
            category: finding.category,
            severity: finding.severity,
            auditResult: r,
            flaggedAt: now,
            flaggedBy: 'full_audit',
            resolveAttempts: 0,
            resolved: false,
          } satisfies FlaggedEntry);
          newFlags++;
        }
        if (newFlags > 0) {
          writeAtomic(FLAGGED_PATH, flagStore);
          log(`  wrote ${newFlags} new flags to flagged-review.json`);
        }
      }
    }

    totalRemoved += removes.length;
    totalFixed   += fixes.length;
    totalFlagged += flags.length;
  }
} finally {
  await shutdownResearchSDK();
}

// Final summary
const finalCount = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).totalFindings;
const pendingFlags = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8')).flagged.length;
console.log('\n' + '='.repeat(60));
console.log(`FULL AUDIT COMPLETE`);
console.log('='.repeat(60));
console.log(`  Evaluated:      ${allResults.length} entries`);
console.log(`  Kept:           ${allResults.filter(r => r.overall === 'KEEP').length}`);
console.log(`  Fixed:          ${totalFixed}`);
console.log(`  Flagged:        ${totalFlagged} (${pendingFlags} total pending in flagged-review.json)`);
console.log(`  Removed:        ${totalRemoved}`);
console.log(`  Final corpus:   ${finalCount}`);

const dims = ['dim1_directional','dim2_summary','dim3_whybad','dim4_quotes','dim5_format','dim6_category','dim7_severity'];
const dimNames = ['Directional   ','Summary acc.  ','WhyBad acc.   ','Quote fidelity','Formatting    ','Category      ','Severity      '];
if (allResults.length > 0) {
  console.log();
  dims.forEach((d, i) => {
    const fails = allResults.filter(r => (r as any)[d] === 'FAIL').length;
    const borderline = allResults.filter(r => (r as any)[d] === 'BORDERLINE').length;
    const na = allResults.filter(r => (r as any)[d] === 'N/A').length;
    const denom = allResults.length - na;
    const pct = denom > 0 ? Math.round(((denom - fails - borderline) / denom) * 100) : 100;
    console.log(`  ${dimNames[i]}: ${pct}% pass  (${fails} FAIL${borderline ? `, ${borderline} BORDERLINE` : ''}${na ? `, ${na} N/A` : ''})`);
  });
}

const outPath = `/tmp/wos_full_audit_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), totalEvaluated: allResults.length, totalRemoved, totalFixed, totalFlagged, results: allResults }, null, 2));
log(`Full results → ${outPath}`);

if (!DRY_RUN && pendingFlags > 0) {
  log(`${pendingFlags} entries pending in flagged-review.json — run resolve_flagged.ts to process them.`);
}
