/**
 * sample_audit.ts — Sample-audit a slice of findings against their real articles.
 *
 * Scrapes each sampled entry's URL, sends to DeepSeek V4 Pro for directional
 * verification + quality check, reports REMOVE / FLAG / KEEP, and applies
 * removals to findings.json (with seenUrls tombstones in run-state.json).
 *
 * Usage:
 *   cd agent && npx tsx scripts/sample_audit.ts [--step N] [--dry-run]
 *
 *   --step N    sample every Nth entry (default: auto to get ~50)
 *   --offset N  start offset within the step (default 4, different from batch_audit.ts)
 *   --dry-run   print report without modifying files
 *
 * Output: /tmp/wos_sample_audit_result.json
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
const STEP_ARG = process.argv.find(a => a.startsWith('--step='))?.split('=')[1];
const OFFSET_ARG = process.argv.find(a => a.startsWith('--offset='))?.split('=')[1];
const SCRAPE_CONCURRENCY = 4;
const SCRAPE_TIMEOUT_MS = 60000;
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 9000;

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

function writeAtomic(path: string, data: any) {
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

const rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const rawState = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
const findings: any[] = rawFindings.findings;

const STEP = STEP_ARG ? parseInt(STEP_ARG) : Math.max(1, Math.floor(findings.length / 50));
const OFFSET = OFFSET_ARG ? parseInt(OFFSET_ARG) : 4;
const sample = findings.filter((_, i) => i % STEP === OFFSET % STEP).slice(0, 55);
log(`Total: ${findings.length} — sampling every ${STEP}th (offset ${OFFSET}) → ${sample.length} entries`);
if (DRY_RUN) log('DRY RUN');

// Initialize SDK for scraping
await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log('SDK initialized');

// Scrape articles
log(`Scraping ${sample.length} articles...`);
const scrapeResults = await mapWithConcurrency(sample, SCRAPE_CONCURRENCY, async (f) => {
  const article = await scrapeOne(f.url);
  log(`  [${sample.indexOf(f)+1}/${sample.length}] ${f.domain} — ${article ? article.length + ' chars' : 'unavail'}`);
  return { ...f, article };
});
const items = scrapeResults.map((r, i) => r.ok ? r.value : { ...sample[i]!, article: null });
const gotArticle = items.filter(it => it.article).length;
log(`Scraped ${gotArticle}/${items.length}`);

// DeepSeek audit
const userText = buildAuditText(items);
log(`Prompt: ~${Math.round((AUDIT_SYSTEM.length + userText.length) / 4)} tokens — calling DeepSeek...`);
const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });
const rawResponse = await completeText(model, AUDIT_SYSTEM, userText, {
  reasoning: 'medium', temperature: 0.2, timeoutMs: 600000,
});

writeFileSync('/tmp/wos_sample_audit_raw.txt', rawResponse);
log(`DeepSeek responded (${rawResponse.length} chars) — parsing...`);

let results: any[] = [];
try {
  const m = rawResponse.match(/\[[\s\S]*\]/);
  results = JSON.parse(m ? m[0] : rawResponse.trim());
} catch (e) {
  log(`Parse error: ${String(e).slice(0, 100)}`);
  log(`Raw excerpt: ${rawResponse.slice(0, 500)}`);
  await shutdownResearchSDK();
  process.exit(1);
}

// Report
const removes = results.filter(r => r.overall === 'REMOVE');
const flags = results.filter(r => r.overall === 'FLAG_FOR_REVIEW');
const keeps = results.filter(r => r.overall === 'KEEP');

console.log('\n' + '='.repeat(60));
console.log(`AUDIT RESULTS: ${sample.length} sampled, ${results.length} evaluated`);
console.log('='.repeat(60));
console.log(`  KEEP:            ${keeps.length}`);
console.log(`  FLAG FOR REVIEW: ${flags.length}`);
console.log(`  REMOVE:          ${removes.length}`);
console.log();

const dims = ['dim1_directional', 'dim2_summary', 'dim3_whybad', 'dim4_quotes', 'dim5_format'];
const dimNames = ['Directional   ', 'Summary acc.  ', 'WhyBad acc.   ', 'Quote acc.    ', 'Formatting    '];
dims.forEach((d, i) => {
  const fails = results.filter(r => r[d] === 'FAIL').length;
  const borderline = results.filter(r => r[d] === 'BORDERLINE').length;
  const pct = Math.round(((results.length - fails - borderline) / results.length) * 100);
  console.log(`  ${dimNames[i]}: ${pct}% pass  (${fails} FAIL${borderline ? `, ${borderline} BORDERLINE` : ''})`);
});

if (removes.length > 0) {
  console.log('\n--- REMOVE ---');
  removes.forEach(r => {
    console.log(`\n  ✗ ${r.id}`);
    console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
    console.log(`    Reason: ${r.overall_reason}`);
  });
}

if (flags.length > 0) {
  console.log('\n--- FLAG FOR REVIEW ---');
  flags.forEach(r => {
    console.log(`\n  ⚑ ${r.id}`);
    console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
    const failDims = dims.filter(d => r[d] === 'FAIL').map((d, _i) => dimNames[dims.indexOf(d)]!.trim());
    if (failDims.length) console.log(`    Fails: ${failDims.join(', ')}`);
    console.log(`    Reason: ${r.overall_reason}`);
  });
}

writeFileSync('/tmp/wos_sample_audit_result.json', JSON.stringify({ timestamp: new Date().toISOString(), sampleSize: sample.length, results }, null, 2));
log('Full results → /tmp/wos_sample_audit_result.json');

// Apply removals
if (!DRY_RUN && removes.length > 0) {
  const removeUrls = new Set(removes.map(r => r.id));
  const newFindings = rawFindings.findings.filter((f: any) => !removeUrls.has(f.url));
  rawFindings.findings = newFindings;
  rawFindings.totalFindings = newFindings.length;
  rawFindings.lastUpdated = new Date().toISOString();
  writeAtomic(FINDINGS_PATH, rawFindings);

  // Tombstone in seenUrls
  if (!rawState.seenUrls['_audit_removed']) rawState.seenUrls['_audit_removed'] = [];
  for (const url of removeUrls) {
    rawState.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
  }
  rawState.lastRun = new Date().toISOString();
  writeAtomic(STATE_PATH, rawState);

  log(`Applied: removed ${removes.length} entries + tombstoned URLs`);
}

await shutdownResearchSDK();
log('Done.');
