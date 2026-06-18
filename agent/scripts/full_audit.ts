/**
 * full_audit.ts — Full-corpus DeepSeek verification pass.
 *
 * Iterates every entry in findings.json in batches, scrapes each article,
 * and runs DeepSeek V4 Pro against ALL quality criteria:
 *   - Directional correctness (Conclusion Test)
 *   - Summary and whyBad accuracy vs. real article text
 *   - Quote fidelity (verbatim check)
 *   - Vague-authority phrase detection
 *   - Over-specificity / invented stats/citations
 *   - Format enforcement (single-para summary, numbered whyBad, word count, no markdown)
 *   - Category accuracy
 *   - Severity accuracy
 *   - Metadata leakage in text fields
 *
 * Verdicts:
 *   KEEP           — all checks pass, no changes needed
 *   FIX_IN_PLACE   — directional PASS but content has fixable issues; corrected fields provided
 *   FLAG_FOR_REVIEW — directional BORDERLINE or low confidence; needs human review
 *   REMOVE         — directional FAIL or article verifiably contradicts the entry
 *
 * Fixes and removals are applied atomically after each batch (progress survives interruption).
 * Safe to re-run: already-tombstoned URLs are skipped.
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
import { mapWithConcurrency } from '../src/utils.js';
import { canonicalizeUrl } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const STATE_PATH = join(DATA_DIR, 'run-state.json');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1] ?? '30');
const START_BATCH = parseInt(process.argv.find(a => a.startsWith('--start-batch='))?.split('=')[1] ?? '1');
const SCRAPE_CONCURRENCY = 5;
const SCRAPE_TIMEOUT_MS = 60_000;
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 9_000;

const VALID_CATEGORIES = [
  'labor','economics','race','gender','immigration','religion','climate','health',
  'democracy','policing','technology','disability','war','spectacle','current_affairs',
  'corruption','media','healthcare','oligarchy',
];

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

═══ WHAT THE DATABASE IS ═══

Every entry must be a piece that is ITSELF a bad actor — it DEFENDS, NORMALIZES, LAUNDERS, or ADVOCATES for harm. Journalism, criticism, and research about harm do NOT belong here.

THE CONCLUSION TEST (single most important filter):
- If the piece concludes "this policy/practice is bad, harmful, unjust, or should change" → REMOVE (it is a critic, not a defender)
- If the piece concludes "this policy/practice is good, natural, necessary, or justified" → KEEP (it normalizes harm)
Subject matter alone is never enough — a piece ABOUT police violence only qualifies if it ARGUES police violence is justified.

WHAT QUALIFIES:
- Outright advocacy (e.g. "billionaires earned their wealth," "police force was justified")
- Industry PR, think-tank briefs, op-eds sanitizing/laundering exploitation or oppression
- Content that naturalizes, rationalizes, excuses, or provides cover for harm
- Propaganda posing as neutral analysis

WHAT DOES NOT QUALIFY (REMOVE immediately):
- Journalism exposing or criticizing harm (Guardian, AP, NPR, Reuters, Jacobin, DeSmog, The Nation)
- Academic research documenting problems (Brookings, Pew, RAND, Harvard — if the conclusion is "this is harmful")
- Op-eds arguing AGAINST oligarchy, exploitation, or harm
- Neutral explainers or how-things-work pieces with no defensive stance
- Any piece whose primary thrust is accountability or reform

═══ CATEGORIES ═══

Entries must belong to exactly one of these categories:
labor, economics, race, gender, immigration, religion, climate, health, democracy, policing,
technology, disability, war, spectacle, current_affairs, corruption, media, healthcare, oligarchy

Category notes:
- gender: sex/women-based misogyny only — NOT gender-identity or sexual-orientation topics
- health: treatment misinformation; healthcare: for-profit system defense — these are distinct
- war: includes state-violence whitewashing (e.g. laundering Israel's operations in Gaza/occupied territories)
- current_affairs: reactive op-eds including atrocity spin

═══ SEVERITY RUBRIC ═══

high: actively dehumanizes a group, argues for stripping rights or lives, promotes/launders outright disinformation, explicit propaganda for extremist ideology, or direct cover for atrocities
medium: sanitizes, rationalizes, or excuses regressive policy or economic exploitation — stops short of dehumanization but meaningfully advances a harmful agenda
low: one-sided position with some genuine legal/economic/good-faith grounding; framing subtly tilts toward excusing harm but is mild

═══ FIELD STANDARDS ═══

summary field must:
- Be a single flowing descriptive paragraph, 3–5 sentences
- Use plain layman language
- Contain NO bullets, NO numbering, NO line breaks, NO markdown formatting
- Use verbatim quotes ONLY if exact wording is confirmed in the scraped article — otherwise paraphrase
- Be at least 80 characters

whyBad field must:
- Start with "1. " (required — names a specific claim from the piece)
- Contain "2. " (required — names the manipulation tactic in everyday words AND defines it in the same sentence)
- Contain "3. " (required — explains what the piece DOES to harm: sanitize/launder/justify/excuse/normalize/propagandize, plus mechanism and consequence)
- Be 150–280 words
- NOT start with "Analysis:" and NOT be surrounded by brackets
- Contain NO markdown (no **, no __, no backticks, no # headers)
- Contain NO ALL-CAPS non-acronym words
- End at the last substantive point — NO filler entries ("None," "N/A," "Not applicable," "No additional context")

BANNED vague-authority phrases (if present, whyBad FAILS the format check):
"multiple news outlets reported," "studies show," "many experts agree," "research finds,"
"researchers found," "critics note," "reports indicate," "widely reported," "observers say,"
or any similar unnamed-authority construction — UNLESS that exact phrase appears verbatim in the article.

BANNED over-specificity (if article text is available and the item is NOT in the article, it FAILS):
statute/section numbers, case names, precise statistics/percentages, study titles/dates — unless
literally present in the scraped article text. Extremely well-known institutions (ADA, OSHA,
Civil Rights Act, EPA) may be named without appearing in article text.

NO metadata leakage: phrases like "URL accessible," "content confirmed," "article verified,"
"scrape successful" must not appear in summary or whyBad.

═══ FOR EACH ENTRY ═══

You receive: title, URL, category, severity, summary, whyBad, and ARTICLE TEXT (scraped live, or UNAVAILABLE).

Evaluate each entry on SEVEN dimensions:

1. DIRECTIONAL: Apply the Conclusion Test to the ARTICLE TEXT (or to the summary/whyBad if unavailable).
   PASS = article itself defends/normalizes/advocates harm
   FAIL = article exposes, criticizes, or documents harm (→ REMOVE immediately)
   BORDERLINE = genuinely ambiguous; article has both critical and defensive elements

2. SUMMARY_ACCURACY: Does the summary faithfully represent what the article actually argues?
   Check: claims match article text; no fabricated details; framing is supported
   PASS / FAIL

3. WHYBAD_ACCURACY: Are the specific points in whyBad traceable to what the article actually does/argues?
   Check: claims are verifiable; no invented quotes, stats, or actions not in article
   PASS / FAIL

4. QUOTE_FIDELITY: Any text in quotation marks in summary or whyBad — does it appear verbatim in the article?
   PASS = all quotes confirmed, or no quotes present
   FAIL = at least one quote cannot be verified
   N/A = article is UNAVAILABLE (cannot check)

5. FORMAT: Does the entry meet all field standards above?
   Check: single-para summary, numbered whyBad (1./2./3. present), 150–280 words in whyBad,
   no markdown, no ALL-CAPS, no "Analysis:" label, no filler points, no banned vague-authority
   phrases, no metadata leakage, no over-specific fabrications
   PASS / FAIL

6. CATEGORY: Is the entry in the correct category from the list above?
   PASS = correct / FAIL = wrong category (provide correct_category in your response)

7. SEVERITY: Is the severity (high/medium/low) correctly assigned per the rubric above?
   PASS = correct / FAIL = wrong (provide correct_severity)

═══ VERDICTS ═══

REMOVE: dim1_directional is FAIL, OR article verifiably contradicts the entry, OR article is a critic/expose
FLAG_FOR_REVIEW: dim1_directional is BORDERLINE, OR article is unavailable and entry is ambiguous, OR confidence is genuinely low
FIX_IN_PLACE: dim1_directional PASS but one or more of dims 2–7 FAIL — provide corrected fields based ONLY on the actual article text
KEEP: all seven dimensions PASS — no changes needed

For FIX_IN_PLACE, provide ONLY the fields that need correction:
- corrected_summary (string): new single-paragraph summary, grounded in the article
- corrected_whybad (string): new numbered whyBad, grounded in the article, 150–280 words
- corrected_category (string): only if category is wrong
- corrected_severity ("low"|"medium"|"high"): only if severity is wrong
DO NOT fabricate content not in the article. If you cannot write a corrected field that stays grounded, set the verdict to FLAG_FOR_REVIEW instead.

═══ OUTPUT FORMAT ═══

Return ONLY a raw JSON array, one object per entry, in the same order as input:
[{
  "id": "<url>",
  "dim1_directional": "PASS|FAIL|BORDERLINE",
  "dim1_note": "one sentence",
  "dim2_summary": "PASS|FAIL",
  "dim2_note": "one sentence",
  "dim3_whybad": "PASS|FAIL",
  "dim3_note": "one sentence",
  "dim4_quotes": "PASS|FAIL|N/A",
  "dim4_note": "one sentence",
  "dim5_format": "PASS|FAIL",
  "dim5_note": "one sentence listing which specific format rules failed",
  "dim6_category": "PASS|FAIL",
  "dim6_note": "one sentence",
  "dim7_severity": "PASS|FAIL",
  "dim7_note": "one sentence",
  "overall": "KEEP|FIX_IN_PLACE|FLAG_FOR_REVIEW|REMOVE",
  "overall_reason": "one sentence",
  "corrected_summary": "(omit if not needed)",
  "corrected_whybad": "(omit if not needed)",
  "corrected_category": "(omit if not needed)",
  "corrected_severity": "(omit if not needed)"
}, ...]`;

function buildAuditText(items: { url: string; title: string; category: string; severity: string; summary: string; whyBad: string; article: string | null }[]): string {
  const blocks = items.map((it, i) => [
    `=== ENTRY ${i + 1} ===`,
    `URL: ${it.url}`,
    `TITLE: ${it.title}`,
    `CATEGORY: ${it.category}`,
    `SEVERITY: ${it.severity}`,
    `SUMMARY:\n${it.summary}`,
    `WHYBAD:\n${it.whyBad}`,
    `ARTICLE TEXT (${it.article ? `${it.article.length} chars` : 'UNAVAILABLE'}):\n${it.article ?? 'UNAVAILABLE'}`,
  ].join('\n'));
  return `Audit the following ${items.length} entries.\n\n${blocks.join('\n\n---\n\n')}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

log(`Full corpus audit — batch size ${BATCH_SIZE}${DRY_RUN ? ' (DRY RUN)' : ''}`);

let rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const totalBatches = Math.ceil(rawFindings.findings.length / BATCH_SIZE);
log(`Total: ${rawFindings.findings.length} entries → ${totalBatches} batches`);
if (START_BATCH > 1) log(`Resuming from batch ${START_BATCH}`);

const allResults: any[] = [];
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

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });

try {
  for (let b = START_BATCH; b <= totalBatches; b++) {
    rawFindings = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
    const currentFindings: any[] = rawFindings.findings;
    const batchStart = (b - 1) * BATCH_SIZE;
    const batch = currentFindings.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) { log(`Batch ${b}: empty (findings shifted by earlier removals) — done`); break; }

    log(`\nBatch ${b}/${totalBatches} — entries ${batchStart + 1}–${batchStart + batch.length} of ${currentFindings.length}`);

    // Scrape every article
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
    const fixes   = batchResults.filter(r => r.overall === 'FIX_IN_PLACE');
    const flags   = batchResults.filter(r => r.overall === 'FLAG_FOR_REVIEW');
    const keeps   = batchResults.filter(r => r.overall === 'KEEP');
    log(`  KEEP ${keeps.length} / FIX ${fixes.length} / FLAG ${flags.length} / REMOVE ${removes.length}`);

    removes.forEach(r => log(`  ✗ REMOVE ${r.id} — ${r.overall_reason}`));
    fixes.forEach(r => log(`  ✎ FIX    ${r.id} — ${r.overall_reason}`));
    flags.forEach(r => log(`  ⚑ FLAG   ${r.id} — ${r.overall_reason}`));

    if (!DRY_RUN && (removes.length > 0 || fixes.length > 0)) {
      const removeUrls = new Set(removes.map((r: any) => r.id));

      const latest = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));

      // Apply fixes
      for (const fix of fixes) {
        const entry = latest.findings.find((f: any) => f.url === fix.id);
        if (!entry) continue;
        if (fix.corrected_summary) entry.summary = fix.corrected_summary;
        if (fix.corrected_whybad) entry.whyBad = fix.corrected_whybad;
        if (fix.corrected_category && VALID_CATEGORIES.includes(fix.corrected_category)) {
          entry.category = fix.corrected_category;
        }
        if (fix.corrected_severity && ['low', 'medium', 'high'].includes(fix.corrected_severity)) {
          entry.severity = fix.corrected_severity;
        }
      }

      // Apply removals
      latest.findings = latest.findings.filter((f: any) => !removeUrls.has(f.url));
      latest.totalFindings = latest.findings.length;
      latest.lastUpdated = new Date().toISOString();
      writeAtomic(FINDINGS_PATH, latest);

      if (removes.length > 0) {
        const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
        if (!state.seenUrls['_audit_removed']) state.seenUrls['_audit_removed'] = [];
        for (const url of removeUrls) {
          state.seenUrls['_audit_removed'].push(canonicalizeUrl(url));
        }
        state.lastRun = new Date().toISOString();
        writeAtomic(STATE_PATH, state);
      }

      if (removes.length > 0) log(`  applied: removed ${removes.length} + tombstoned`);
      if (fixes.length > 0) log(`  applied: fixed ${fixes.length} entries in place`);
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
console.log('\n' + '='.repeat(60));
console.log(`FULL AUDIT COMPLETE`);
console.log('='.repeat(60));
console.log(`  Evaluated:    ${allResults.length} entries`);
console.log(`  Kept:         ${allResults.filter(r => r.overall === 'KEEP').length}`);
console.log(`  Fixed:        ${totalFixed}`);
console.log(`  Flagged:      ${totalFlagged}`);
console.log(`  Removed:      ${totalRemoved}`);
console.log(`  Final corpus: ${finalCount}`);

// Dimension pass rates
const dims = ['dim1_directional','dim2_summary','dim3_whybad','dim4_quotes','dim5_format','dim6_category','dim7_severity'];
const dimNames = ['Directional   ','Summary acc.  ','WhyBad acc.   ','Quote fidelity','Formatting    ','Category      ','Severity      '];
if (allResults.length > 0) {
  console.log();
  dims.forEach((d, i) => {
    const fails = allResults.filter(r => r[d] === 'FAIL').length;
    const borderline = allResults.filter(r => r[d] === 'BORDERLINE').length;
    const na = allResults.filter(r => r[d] === 'N/A').length;
    const denom = allResults.length - na;
    const pct = denom > 0 ? Math.round(((denom - fails - borderline) / denom) * 100) : 100;
    console.log(`  ${dimNames[i]}: ${pct}% pass  (${fails} FAIL${borderline ? `, ${borderline} BORDERLINE` : ''}${na ? `, ${na} N/A` : ''})`);
  });
}

const outPath = `/tmp/wos_full_audit_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
writeFileSync(outPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  totalEvaluated: allResults.length,
  totalRemoved,
  totalFixed,
  totalFlagged,
  results: allResults,
}, null, 2));
log(`Full results → ${outPath}`);

if (!DRY_RUN && (totalRemoved > 0 || totalFixed > 0)) {
  log('Run `node site/scripts/embed.mjs` (from site/) to rebuild the semantic search index.');
}
