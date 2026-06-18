/**
 * batch_audit.ts — Samples ~50 findings, scrapes their actual article text via pi-research's
 * scrapeUrl, then runs DeepSeek V4 Pro (1M ctx) in ONE call to audit every entry for:
 *   1. Directional correctness: is the piece itself a bad actor?
 *   2. Summary truthfulness against the actual article
 *   3. WhyBad accuracy (all numbered points traceable to article content)
 *   4. Quote verification (any quoted text must be verbatim from article)
 *   5. Formatting compliance (paragraph structure, numbering, no all-caps, etc.)
 *
 * Usage: cd agent && npx tsx scripts/batch_audit.ts [--all]
 * Output: writes /tmp/wos_audit_result.json and prints summary
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { scrapeUrl } from '@lincoln504/pi-research';
import { getOpenRouterModel, completeText, VERIFY_MODEL_ID } from '../src/models.js';

const FINDINGS_PATH = join(import.meta.dirname, '../data/findings.json');
const SCRAPE_TIMEOUT_MS = 30_000;
const MAX_ARTICLE_CHARS = 8_000;
const CONCURRENCY = 5;

// ── Load & sample findings ──────────────────────────────────────────────────

const raw = JSON.parse(readFileSync(FINDINGS_PATH, 'utf8'));
const all: any[] = raw.findings;
console.log(`Total findings: ${all.length}`);

const STEP = Math.max(1, Math.floor(all.length / 50));
const sample = all.filter((_, i) => i % STEP === 0).slice(0, 55);
console.log(`Sampling every ${STEP}th entry → ${sample.length} entries\n`);

// ── Scrape each article ─────────────────────────────────────────────────────

async function scrapeOne(url: string, _domain: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('timeout')), SCRAPE_TIMEOUT_MS);
  });
  try {
    let res;
    try { res = await Promise.race([scrapeUrl(url), timeout]); }
    finally { if (timer) clearTimeout(timer); }
    if (!res.success || !res.markdown || res.markdown.trim().length < 200) return 'UNAVAILABLE';
    return res.markdown.trim().slice(0, MAX_ARTICLE_CHARS);
  } catch {
    return 'UNAVAILABLE';
  }
}

async function mapConcurrent<T, R>(
  arr: T[],
  concurrency: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(arr.length);
  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const i = idx++;
      results[i] = await fn(arr[i]!);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

console.log('Scraping articles...');
const articles = await mapConcurrent(sample, CONCURRENCY, async (entry, i?: number) => {
  const idx = sample.indexOf(entry);
  const text = await scrapeOne(entry.url, entry.domain ?? entry.url);
  const status = text === 'UNAVAILABLE' ? '✗ unavail' : `✓ ${text.length} chars`;
  console.log(`  [${String(idx + 1).padStart(2)}/${sample.length}] ${entry.domain ?? entry.url} — ${status}`);
  return text;
});

const available = articles.filter(a => a !== 'UNAVAILABLE').length;
console.log(`\nScraped: ${available}/${sample.length} available\n`);

// ── Build DeepSeek audit prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are auditing a curated database called "Wall of Shame."

## PURPOSE OF THE DATABASE
Wall of Shame is a scathing search engine of bad, disagreeable, harmful, and malevolent web content. Every entry must be a piece that is ITSELF a bad actor — it DEFENDS, NORMALIZES, LAUNDERS, or ADVOCATES for harm.

WHAT DOES NOT QUALIFY:
- Journalism that EXPOSES or CRITICIZES harm → omit
- Neutral explainers that document how harmful things work → omit
- Academic analysis that studies bad phenomena critically → omit
- Op-eds arguing that something bad exists → omit
- Business/practical guides written from an industry perspective that don't defend harm → omit

WHAT QUALIFIES:
- A piece that CONCLUDES "this harmful arrangement is good / necessary / justified / natural"
- A piece that NORMALIZES power concentration, exploitation, or discrimination as legitimate
- A piece that LAUNDERS a harmful policy as reform or progress
- A piece that ADVOCATES for something harmful while framing it positively

THE CONCLUSION TEST: If the piece concludes "this is bad, harmful, or unjust" → omit (wrong entry). If the piece concludes "this is good, justified, necessary" → include (valid entry). The article's own stance is what matters, not its subject matter.

## YOUR AUDIT TASK
For each entry below, you are given:
- ENTRY METADATA: title, url, domain, category, summary, whyBad from the database
- ARTICLE TEXT: the actual scraped text of the article (or UNAVAILABLE if scraping failed)

Evaluate each entry on FIVE dimensions:

### DIM 1 — DIRECTIONAL CORRECTNESS
Does the article ITSELF defend/normalize/advocate for harm? This is the most important dimension.
- PASS: The article concludes the harmful thing is good, justified, necessary, or inevitable
- FAIL: The article is neutral analysis, journalism about harm, or criticism of harm

### DIM 2 — SUMMARY ACCURACY
Does the summary accurately represent what the article actually says?
- PASS: Summary is factually consistent with article text
- FAIL: Summary mischaracterizes the article's argument, overstates claims, or is simply wrong

### DIM 3 — WHYBAD ACCURACY
Are the specific claims in whyBad traceable to the actual article?
- PASS: Every numbered point cites something the article actually argues/does
- FAIL: Points describe what the subject does in the world, not what this specific article does; or points are not traceable to the article at all

### DIM 4 — QUOTE ACCURACY
If the summary or whyBad contains text in quotation marks, does that text appear verbatim in the article?
- PASS: All quoted text appears verbatim in article, or there are no quotes
- FAIL: Any quoted text does not appear verbatim in the article (even slight paraphrase is a FAIL)
- N/A: Article was UNAVAILABLE, cannot verify

### DIM 5 — FORMATTING
Does the entry meet formatting standards?
- PASS: Summary is a single prose paragraph (no bullets/line breaks); whyBad is numbered 1. 2. 3. (3-5 points); no ALL-CAPS words in either; no vague authorities ("some experts say"); no over-specific jargon
- FAIL: Any of the above violated

## RESPONSE FORMAT
Return a JSON array. For each entry, output:
{
  "id": "<the entry's url>",
  "dim1_directional": "PASS" | "FAIL" | "BORDERLINE",
  "dim1_note": "<one sentence explanation>",
  "dim2_summary": "PASS" | "FAIL",
  "dim2_note": "<brief note or empty string if PASS>",
  "dim3_whybad": "PASS" | "FAIL",
  "dim3_note": "<brief note or empty string if PASS>",
  "dim4_quotes": "PASS" | "FAIL" | "N/A",
  "dim4_note": "<brief note or empty if PASS or N/A>",
  "dim5_format": "PASS" | "FAIL",
  "dim5_note": "<brief note or empty if PASS>",
  "overall": "KEEP" | "REMOVE" | "FLAG_FOR_REVIEW",
  "overall_reason": "<one sentence>"
}

Respond with ONLY the JSON array, no commentary.`;

const entries = sample.map((entry, i) => {
  const art = articles[i]!;
  return `
=== ENTRY ${i + 1} ===
URL: ${entry.url}
DOMAIN: ${entry.domain ?? 'unknown'}
CATEGORY: ${entry.category}
TITLE: ${entry.title}

SUMMARY:
${entry.summary}

WHYBAD:
${entry.whyBad}

ARTICLE TEXT (${art === 'UNAVAILABLE' ? 'UNAVAILABLE — standards-only audit' : `${art.length} chars`}):
${art}
`.trim();
});

const USER_TEXT = `Audit the following ${sample.length} Wall of Shame entries:\n\n${entries.join('\n\n---\n\n')}`;

console.log(`Prompt size: ~${(SYSTEM_PROMPT.length + USER_TEXT.length).toLocaleString()} chars (~${Math.round((SYSTEM_PROMPT.length + USER_TEXT.length) / 4).toLocaleString()} tokens)`);
console.log('Calling DeepSeek V4 Pro...\n');

// ── Call DeepSeek ───────────────────────────────────────────────────────────

const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });
const raw_response = await completeText(model, SYSTEM_PROMPT, USER_TEXT, {
  reasoning: 'medium',
  temperature: 0.2,
  timeoutMs: 600_000, // 10 min for the full batch
});

// ── Parse response ──────────────────────────────────────────────────────────

// Save raw response for debugging
writeFileSync('/tmp/wos_audit_raw.txt', raw_response);
console.log(`Raw response: ${raw_response.length} chars, saved to /tmp/wos_audit_raw.txt`);

let results: any[] = [];
try {
  // Try JSON array match
  const jsonMatch = raw_response.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    results = JSON.parse(jsonMatch[0]);
  } else {
    // Try full response as JSON
    results = JSON.parse(raw_response.trim());
  }
} catch (e) {
  console.error('Failed to parse response:', String(e).slice(0, 200));
  console.error('Raw response excerpt:', raw_response.slice(0, 2000));
  process.exit(1);
}

// ── Print report ────────────────────────────────────────────────────────────

const removes = results.filter(r => r.overall === 'REMOVE');
const flags = results.filter(r => r.overall === 'FLAG_FOR_REVIEW');
const keeps = results.filter(r => r.overall === 'KEEP');

console.log(`\n${'='.repeat(60)}`);
console.log(`AUDIT RESULTS: ${sample.length} entries reviewed`);
console.log(`=`.repeat(60));
console.log(`  KEEP:            ${keeps.length}`);
console.log(`  FLAG FOR REVIEW: ${flags.length}`);
console.log(`  REMOVE:          ${removes.length}`);
console.log();

// Dim breakdown
const dims = ['dim1_directional', 'dim2_summary', 'dim3_whybad', 'dim4_quotes', 'dim5_format'];
const dimNames = ['Directional', 'Summary acc.', 'WhyBad acc.', 'Quote acc.', 'Formatting'];
dims.forEach((d, i) => {
  const fails = results.filter(r => r[d] === 'FAIL').length;
  const borderline = results.filter(r => r[d] === 'BORDERLINE').length;
  const label = `${dimNames[i]!.padEnd(14)}`;
  const pct = Math.round(((results.length - fails - borderline) / results.length) * 100);
  console.log(`  ${label}: ${pct}% pass   (${fails} FAIL, ${borderline} BORDERLINE)`);
});

console.log('\n--- REMOVES ---');
removes.forEach(r => {
  console.log(`\n  ✗ ${r.id}`);
  console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
  console.log(`    Reason: ${r.overall_reason}`);
});

console.log('\n--- FLAGS FOR REVIEW ---');
flags.forEach(r => {
  console.log(`\n  ⚑ ${r.id}`);
  console.log(`    Directional: ${r.dim1_directional} — ${r.dim1_note}`);
  const fails = dims.filter(d => r[d] === 'FAIL').map((d, i) => dimNames[dims.indexOf(d)]!);
  if (fails.length) console.log(`    Fails: ${fails.join(', ')}`);
  console.log(`    Reason: ${r.overall_reason}`);
});

// Write full results
const output = { timestamp: new Date().toISOString(), sampleSize: sample.length, results };
writeFileSync('/tmp/wos_audit_result.json', JSON.stringify(output, null, 2));
console.log('\nFull results written to /tmp/wos_audit_result.json');
