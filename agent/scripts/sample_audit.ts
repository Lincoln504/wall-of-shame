/**
 * sample_audit.ts — Maintenance audit: review recent entries + 10% of older corpus.
 *
 * Runs automatically from scale-loop.sh every AUDIT_INTERVAL rounds.
 * Also runnable standalone for manual spot-checks.
 *
 * Uses the canonical 7-dimension audit criteria from audit-criteria.ts.
 * Confident decisions (FIX_IN_PLACE, REMOVE) are applied immediately per batch.
 * Ambiguous decisions (FLAG_FOR_REVIEW) are written to data/flagged-review.json
 * for resolution by resolve_flagged.ts.
 *
 * Batched: 30 entries per DeepSeek call (same as full_audit.ts). Scales safely
 * to any corpus size — a 10% sample of 1500 entries (150 total) sends 5 calls
 * instead of one massive 150-entry context.
 *
 * Usage:
 *   cd agent && npx tsx scripts/sample_audit.ts [--recent N] [--step N] [--dry-run]
 *
 *   --recent N  audit all of the last N entries (inter-audit additions) PLUS a 10%
 *               sample of the remaining corpus. Pass the count of entries added
 *               since the last audit (as scale-loop.sh does via ADDED_SINCE_AUDIT).
 *   --step N    legacy: sample every Nth entry (default: auto to get ~50).
 *   --offset N  legacy: start offset within the step (default 4)
 *   --dry-run   report only, no writes
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
const RECENT_ARG = process.argv.find(a => a.startsWith('--recent='))?.split('=')[1];
const STEP_ARG = process.argv.find(a => a.startsWith('--step='))?.split('=')[1];
const OFFSET_ARG = process.argv.find(a => a.startsWith('--offset='))?.split('=')[1];
const BATCH_SIZE = 15;
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
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), SCRAPE_TIMEOUT_MS);
    });
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

const rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const findings: any[] = rawFindings.findings;

let sample: any[];
if (RECENT_ARG !== undefined) {
  const recentN = Math.max(0, parseInt(RECENT_ARG));
  const recentEntries = findings.slice(-recentN);
  const olderEntries = findings.slice(0, findings.length - recentN);
  const olderSample = olderEntries.filter((_, i) => i % 10 === 4);
  sample = [...recentEntries, ...olderSample];
  log(`Total: ${findings.length} — recent: ${recentEntries.length} (all) + older: ${olderSample.length} (10% of ${olderEntries.length}) = ${sample.length} entries`);
} else {
  const STEP = STEP_ARG ? parseInt(STEP_ARG) : Math.max(1, Math.floor(findings.length / 50));
  const OFFSET = OFFSET_ARG ? parseInt(OFFSET_ARG) : 4;
  const effectiveOffset = OFFSET % STEP;
  if (effectiveOffset !== OFFSET) log(`[warn] --offset ${OFFSET} normalized to ${effectiveOffset} for step=${STEP}`);
  sample = findings.filter((_, i) => i % STEP === effectiveOffset).slice(0, 55);
  log(`Total: ${findings.length} — sampling every ${STEP}th (offset ${effectiveOffset}) → ${sample.length} entries`);
}
if (DRY_RUN) log('DRY RUN — no writes');

const totalBatches = Math.ceil(sample.length / BATCH_SIZE);
log(`Batches: ${totalBatches} × up to ${BATCH_SIZE} entries each`);

await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log('SDK initialized');

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });

// Accumulate per-batch to produce the final summary report
const allResults: AuditResult[] = [];
let totalRemoved = 0;
let totalFixed = 0;
let totalFlagged = 0;

try {
  for (let b = 1; b <= totalBatches; b++) {
    const batch = sample.slice((b - 1) * BATCH_SIZE, b * BATCH_SIZE);
    log(`\nBatch ${b}/${totalBatches} — ${batch.length} entries`);

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

    let batchResults: AuditResult[] = [];
    try {
      const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
        reasoning: 'medium', temperature: 0.2, timeoutMs: 600_000,
      });
      writeFileSync(`/tmp/wos_sample_audit_b${b}_raw.txt`, rawResponse);
      const m = rawResponse.match(/\[[\s\S]*\]/);
      batchResults = JSON.parse(m ? m[0] : rawResponse.trim());
    } catch (e) {
      log(`  batch ${b} error: ${String(e).slice(0, 100)} — skipping`);
      continue;
    }

    allResults.push(...batchResults);

    const removes = batchResults.filter(r => r.overall === 'REMOVE');
    const fixes   = batchResults.filter(r => r.overall === 'FIX_IN_PLACE');
    const flags   = batchResults.filter(r => r.overall === 'FLAG_FOR_REVIEW');
    const keeps   = batchResults.filter(r => r.overall === 'KEEP');
    log(`  KEEP ${keeps.length} / FIX ${fixes.length} / FLAG ${flags.length} / REMOVE ${removes.length}`);
    removes.forEach(r => log(`  ✗ REMOVE ${r.id} — ${r.overall_reason}`));
    fixes.forEach(r => log(`  ✎ FIX    ${r.id}`));
    flags.forEach(r => log(`  ⚑ FLAG   ${r.id} — ${r.overall_reason}`));

    if (!DRY_RUN && (removes.length > 0 || fixes.length > 0 || flags.length > 0)) {
      const removeUrls = new Set(removes.map(r => r.id));
      const fixMap = new Map(fixes.map(r => [r.id, r]));

      const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));

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

      if (removes.length > 0) {
        latest.findings = latest.findings.filter((f: any) => !removeUrls.has(f.url));
        latest.totalFindings = latest.findings.length;
      }

      if (removes.length > 0 || fixes.length > 0) {
        latest.lastUpdated = new Date().toISOString();
        writeAtomic(FINDINGS_PATH, latest);
        log(`  applied: ${removes.length} removed, ${fixes.length} fixed`);
      }

      if (removes.length > 0) {
        const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
        if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
        for (const url of removeUrls) state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
        state.lastRun = new Date().toISOString();
        writeAtomic(STATE_PATH, state);
        log(`  tombstoned ${removes.length} URLs`);
      }

      if (flags.length > 0) {
        const flagStore = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8'));
        const existingUrls = new Set((flagStore.flagged as FlaggedEntry[]).map(e => e.url));
        const now = new Date().toISOString();
        let newFlags = 0;
        for (const r of flags) {
          if (existingUrls.has(r.id)) continue;
          const finding = findings.find(f => f.url === r.id);
          if (!finding) continue;
          flagStore.flagged.push({
            url: r.id,
            title: finding.title,
            category: finding.category,
            severity: finding.severity,
            auditResult: r,
            flaggedAt: now,
            flaggedBy: 'sample_audit',
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

// Final report
const finalCount = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).totalFindings;
const pendingFlags = JSON.parse(readFileSync(FLAGGED_PATH, 'utf-8')).flagged.length;

console.log('\n' + '='.repeat(60));
console.log(`AUDIT RESULTS: ${sample.length} sampled, ${allResults.length} evaluated`);
console.log('='.repeat(60));
console.log(`  KEEP:            ${allResults.filter(r => r.overall === 'KEEP').length}`);
console.log(`  FIX_IN_PLACE:    ${totalFixed}`);
console.log(`  FLAG FOR REVIEW: ${totalFlagged} (${pendingFlags} total pending)`);
console.log(`  REMOVE:          ${totalRemoved}`);
console.log(`  Final corpus:    ${finalCount}`);
console.log();

const dims = ['dim1_directional','dim2_summary','dim3_whybad','dim4_quotes','dim5_format','dim6_category','dim7_severity'];
const dimNames = ['Directional   ','Summary acc.  ','WhyBad acc.   ','Quote fidelity','Formatting    ','Category      ','Severity      '];
if (allResults.length > 0) {
  dims.forEach((d, i) => {
    const fails = allResults.filter(r => (r as any)[d] === 'FAIL').length;
    const borderline = allResults.filter(r => (r as any)[d] === 'BORDERLINE').length;
    const na = allResults.filter(r => (r as any)[d] === 'N/A').length;
    const denom = allResults.length - na;
    const pct = denom > 0 ? Math.round(((denom - fails - borderline) / denom) * 100) : 100;
    console.log(`  ${dimNames[i]}: ${pct}% pass  (${fails} FAIL${borderline ? `, ${borderline} BORDERLINE` : ''}${na ? `, ${na} N/A` : ''})`);
  });
}

if (allResults.filter(r => r.overall === 'REMOVE').length > 0) {
  console.log('\n--- REMOVE ---');
  allResults.filter(r => r.overall === 'REMOVE').forEach(r => {
    console.log(`\n  ✗ ${r.id}`);
    console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
    console.log(`    Reason: ${r.overall_reason}`);
  });
}
if (allResults.filter(r => r.overall === 'FLAG_FOR_REVIEW').length > 0) {
  console.log('\n--- FLAG FOR REVIEW ---');
  allResults.filter(r => r.overall === 'FLAG_FOR_REVIEW').forEach(r => {
    console.log(`\n  ⚑ ${r.id}`);
    console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
    console.log(`    Reason: ${r.overall_reason}`);
  });
}

writeFileSync('/tmp/wos_sample_audit_result.json', JSON.stringify({
  timestamp: new Date().toISOString(), sampleSize: sample.length,
  totalRemoved, totalFixed, totalFlagged, results: allResults,
}, null, 2));
log('Full results → /tmp/wos_sample_audit_result.json');
log('Done.');
