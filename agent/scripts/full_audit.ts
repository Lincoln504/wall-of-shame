/**
 * full_audit.ts — Full-corpus DeepSeek verification pass.
 *
 * Iterates every entry in findings.json in batches, scrapes each article,
 * and runs DeepSeek V4 Pro to audit directional correctness, summary/whyBad
 * accuracy, quote fidelity, and formatting. Removals are applied and tombstoned
 * after each batch so progress survives interruption.
 *
 * Safe to re-run: already-tombstoned URLs are skipped.
 *
 * Usage:
 *   cd agent && npx tsx scripts/full_audit.ts [--batch-size N] [--dry-run] [--start-batch N]
 *
 *   --batch-size N   entries per DeepSeek call (default 50)
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
import { mapWithConcurrency, safeParseJson } from '../src/utils.js';
import { canonicalizeUrl } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1] ?? '50');
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

const AUDIT_SYSTEM = `You are auditing the Wall of Shame database — a scathing search engine of bad, disagreeable, harmful, and malevolent web content.

WHAT THE DATABASE IS: Every entry must be a piece that is ITSELF a bad actor — it DEFENDS, NORMALIZES, LAUNDERS, or ADVOCATES for harm. Journalism, academic research, and criticism of harm do NOT belong here.

WHAT QUALIFIES:
- A piece that CONCLUDES "this harmful arrangement is good / necessary / justified / natural"
- Industry PR, think-tank briefs, op-eds that normalize exploitation or oppression
- Content that sanitizes, launders, or provides cover for power abuse

WHAT DOES NOT QUALIFY:
- Journalism that EXPOSES or CRITICIZES harm (even if subject matter matches a category)
- Academic research DOCUMENTING problems
- Progressive op-eds ARGUING AGAINST oligarchy or exploitation
- Neutral explainers or how-things-work pieces without a defensive stance

THE CONCLUSION TEST: If the piece concludes "this is bad/harmful/unjust" → omit (it's a critic). If it concludes "this is good/justified/necessary" → include (it's a defender).

FOR EACH ENTRY you receive: title, URL, summary, whyBad, and ARTICLE TEXT (scraped live, or UNAVAILABLE).

Evaluate each on FIVE dimensions:
1. DIRECTIONAL: Does the article ITSELF defend/normalize/advocate for harm? (PASS/FAIL/BORDERLINE)
2. SUMMARY: Does the summary accurately represent the article? (PASS/FAIL)
3. WHYBAD: Are the specific points in whyBad traceable to what the article actually does/argues? (PASS/FAIL)
4. QUOTES: Any text in quotation marks — does it appear verbatim in the article? (PASS/FAIL/N/A if unavailable)
5. FORMAT: Single-paragraph summary, numbered whyBad, no ALL-CAPS shouting, no vague authorities like "studies show"? (PASS/FAIL)

VERDICT: KEEP, REMOVE, or FLAG_FOR_REVIEW.
- REMOVE: directional failure (article doesn't defend harm, or clearly exposes/criticizes it)
- REMOVE: article completely contradicts the entry
- FLAG_FOR_REVIEW: directional is BORDERLINE or there is a significant content issue (quote fabrication, major claim mismatch)
- KEEP: passes directional check, content is broadly accurate

Return ONLY a raw JSON array, one object per entry:
[{"id": "<url>", "dim1_directional": "PASS|FAIL|BORDERLINE", "dim1_note": "...", "dim2_summary": "PASS|FAIL", "dim2_note": "...", "dim3_whybad": "PASS|FAIL", "dim3_note": "...", "dim4_quotes": "PASS|FAIL|N/A", "dim4_note": "...", "dim5_format": "PASS|FAIL", "dim5_note": "...", "overall": "KEEP|REMOVE|FLAG_FOR_REVIEW", "overall_reason": "one sentence"}, ...]`;

function buildAuditText(items: { url: string; title: string; summary: string; whyBad: string; article: string | null }[]): string {
  const blocks = items.map((it, i) => [
    `=== ENTRY ${i + 1} ===`,
    `URL: ${it.url}`,
    `TITLE: ${it.title}`,
    `SUMMARY:\n${it.summary}`,
    `WHYBAD:\n${it.whyBad}`,
    `ARTICLE TEXT (${it.article ? `${it.article.length} chars` : 'UNAVAILABLE'}):\n${it.article ?? 'UNAVAILABLE'}`,
  ].join('\n'));
  return `Audit the following ${items.length} entries.\n\n${blocks.join('\n\n---\n\n')}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

log(`Full corpus audit — batch size ${BATCH_SIZE}${DRY_RUN ? ' (DRY RUN)' : ''}`);

let rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const rawState = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
const findings: any[] = rawFindings.findings;

const totalBatches = Math.ceil(findings.length / BATCH_SIZE);
log(`Total: ${findings.length} entries → ${totalBatches} batches`);
if (START_BATCH > 1) log(`Resuming from batch ${START_BATCH}`);

const allResults: any[] = [];
let totalRemoved = 0;
let totalFlagged = 0;

await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log('SDK initialized');

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });

try {
  for (let b = START_BATCH; b <= totalBatches; b++) {
    // Re-read current findings at the start of each batch — prior batches may have removed entries.
    rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
    const currentFindings: any[] = rawFindings.findings;
    const batchStart = (b - 1) * BATCH_SIZE;
    const batch = currentFindings.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) { log(`Batch ${b}: empty (findings shifted by earlier removals) — done`); break; }

    log(`\nBatch ${b}/${totalBatches} — entries ${batchStart + 1}–${batchStart + batch.length} of ${currentFindings.length}`);

    // Scrape
    const scrapeResults = await mapWithConcurrency(batch, SCRAPE_CONCURRENCY, async (f, idx) => {
      const article = await scrapeOne(f.url);
      log(`  [${idx + 1}/${batch.length}] ${f.domain} — ${article ? article.length + ' chars' : 'unavail'}`);
      return { ...f, article };
    });
    const items = scrapeResults.map((r, i) => r.ok ? r.value : { ...batch[i]!, article: null });
    const gotArticle = items.filter(it => it.article).length;
    log(`  scraped ${gotArticle}/${items.length}`);

    // DeepSeek audit
    const userText = buildAuditText(items);
    log(`  prompt ~${Math.round((AUDIT_SYSTEM.length + userText.length) / 4)} tokens — calling DeepSeek...`);
    const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
      reasoning: 'medium', temperature: 0.2, timeoutMs: 600_000,
    });

    let batchResults: any[] = [];
    try {
      const m = rawResponse.match(/\[[\s\S]*\]/);
      batchResults = JSON.parse(m ? m[0] : rawResponse.trim());
    } catch (e) {
      log(`  parse error on batch ${b}: ${String(e).slice(0, 120)} — skipping batch`);
      writeFileSync(`/tmp/wos_full_audit_batch${b}_raw.txt`, rawResponse);
      continue;
    }

    allResults.push(...batchResults);

    const removes = batchResults.filter(r => r.overall === 'REMOVE');
    const flags = batchResults.filter(r => r.overall === 'FLAG_FOR_REVIEW');
    const keeps = batchResults.filter(r => r.overall === 'KEEP');
    log(`  KEEP ${keeps.length} / FLAG ${flags.length} / REMOVE ${removes.length}`);

    if (removes.length > 0) {
      removes.forEach(r => log(`  ✗ REMOVE ${r.id} — ${r.overall_reason}`));
    }
    if (flags.length > 0) {
      flags.forEach(r => log(`  ⚑ FLAG   ${r.id} — ${r.overall_reason}`));
    }

    // Apply removals immediately after each batch
    if (!DRY_RUN && removes.length > 0) {
      const removeUrls = new Set(removes.map(r => r.id));
      const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
      latest.findings = latest.findings.filter((f: any) => !removeUrls.has(f.url));
      latest.totalFindings = latest.findings.length;
      latest.lastUpdated = new Date().toISOString();
      writeAtomic(FINDINGS_PATH, latest);

      const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
      if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
      for (const url of removeUrls) {
        state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
      }
      state.lastRun = new Date().toISOString();
      writeAtomic(STATE_PATH, state);

      log(`  applied: removed ${removes.length} entries + tombstoned`);
    }

    totalRemoved += removes.length;
    totalFlagged += flags.length;
  }
} finally {
  await shutdownResearchSDK();
}

// Final summary
const finalCount = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')).totalFindings;
console.log('\n' + '='.repeat(60));
console.log(`FULL AUDIT COMPLETE`);
console.log('='.repeat(60));
console.log(`  Evaluated:  ${allResults.length} entries`);
console.log(`  Removed:    ${totalRemoved}`);
console.log(`  Flagged:    ${totalFlagged}`);
console.log(`  Final corpus: ${finalCount}`);

// Dimension pass rates
const dims = ['dim1_directional', 'dim2_summary', 'dim3_whybad', 'dim4_quotes', 'dim5_format'];
const dimNames = ['Directional   ', 'Summary acc.  ', 'WhyBad acc.   ', 'Quote acc.    ', 'Formatting    '];
if (allResults.length > 0) {
  console.log();
  dims.forEach((d, i) => {
    const fails = allResults.filter(r => r[d] === 'FAIL').length;
    const borderline = allResults.filter(r => r[d] === 'BORDERLINE').length;
    const pct = Math.round(((allResults.length - fails - borderline) / allResults.length) * 100);
    console.log(`  ${dimNames[i]}: ${pct}% pass  (${fails} FAIL${borderline ? `, ${borderline} BORDERLINE` : ''})`);
  });
}

const outPath = `/tmp/wos_full_audit_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), totalEvaluated: allResults.length, totalRemoved, totalFlagged, results: allResults }, null, 2));
log(`Full results → ${outPath}`);

if (!DRY_RUN && totalRemoved > 0) {
  log('Re-run embed.mjs to update semantic search index after removals.');
}
