/**
 * reverify_unverified.ts — targeted re-verification pass for entries that never
 * received a verificationLog from verify.ts (either pre-date the stage or were
 * omitted from batch model responses).
 *
 * Loads findings.json, identifies entries without verificationLog, scrapes each
 * article URL, sends to DeepSeek V4 Pro in batches of 10, and updates the entry
 * in-place with the verified summary/whyBad, or removes it if DeepSeek says invalid.
 *
 * Usage:
 *   cd agent && npx tsx scripts/reverify_unverified.ts [--dry-run]
 *
 * --dry-run: shows what would be removed/updated without writing.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeUrl, initResearchSDK, shutdownResearchSDK } from '@lincoln504/pi-research';
import { getOpenRouterModel, completeText, VERIFY_MODEL_ID } from '../src/models.js';
import { normalizeWhyBad, safeParseJson, mapWithConcurrency } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');

const DRY_RUN = process.argv.includes('--dry-run');
const SCRAPE_CONCURRENCY = 3;
const BATCH_SIZE = 10;
const SCRAPE_TIMEOUT_MS = 60000;
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 10000;

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

const VERIFY_PROMPT = `You are the Lead Auditor performing FINAL verification of Wall of Shame entries. For each entry, evaluate whether it belongs in the database.

DIRECTIONAL TEST — apply first. The Wall of Shame targets content that DEFENDS, NORMALIZES, LAUNDERS, or ADVOCATES for harm. It does NOT target content that EXPOSES, CRITICIZES, DOCUMENTS, or REPORTS ON harm.

INCLUDE (set valid:true) if the piece is on the side of those who exploit, dehumanize, or obstruct accountability — outright advocacy, sanitizing/laundering, normalizing as natural, rationalizing/excusing, legitimizing harmful ideas, or serving as propaganda.

DROP (set valid:false) if the piece is on the side of victims, critics, journalists, or reformers — even if the subject matter matches our categories. Also drop if the page is unavailable, unrelated, or an error page.

FOR EACH ENTRY:
- If ARTICLE TEXT is provided: apply the directional test using the real article. If the article EXPOSES or CRITICIZES harm → valid:false. If it DEFENDS or NORMALIZES harm → valid:true, then ground/clean the summary and whyBad.
- If ARTICLE TEXT is UNAVAILABLE: default to valid:false. Set valid:true ONLY if the draft clearly and unambiguously describes a piece that defends harm — no doubt, no journalism/research framing, no "examines" or "reveals" language.

HOUSE STANDARDS (apply to every valid:true entry):
- summary: single flowing paragraph (3-5 sentences, no bullets, no line breaks), plain language, verbatim quote only if confirmed in ARTICLE TEXT.
- whyBad: numbered breakdown starting with "1.", at least 3 points (claim → tactic → real-world harm), >= 150 words, plain English, no "Analysis:" label, no brackets, no ALL-CAPS shouting, no vague authorities ("studies show", "experts agree"), no fabricated statute numbers or statistics.

OUTPUT: raw JSON only, no markdown:
{"results": [{"id": "<echo the entry id>", "valid": true, "summary": "...", "whyBad": "1. ... 2. ... 3. ..."}, ...]}
Return one object per input entry.`;

function buildBatchText(items: { id: string; url: string; title: string; summary: string; whyBad: string; article: string | null }[]): string {
  const blocks = items.map((it, i) => [
    `[ENTRY ${i + 1}]`,
    `id: ${it.id}`,
    `TITLE: ${it.title}`,
    `URL: ${it.url}`,
    `ARTICLE TEXT:\n${it.article ?? 'UNAVAILABLE'}`,
    `DRAFT SUMMARY:\n${it.summary}`,
    `DRAFT ANALYSIS:\n${it.whyBad}`,
  ].join('\n'));
  return `Verify the following ${items.length} entries and return one result object per entry.\n\n${blocks.join('\n\n')}`;
}

interface BatchResult { id?: string; valid?: boolean; summary?: string; whyBad?: string }

async function verifyBatch(items: typeof unverified, model: any): Promise<Map<string, BatchResult>> {
  try {
    const text = await completeText(model, VERIFY_PROMPT, buildBatchText(items), {
      reasoning: 'medium', temperature: 0.3, topP: 0.9, json: true, timeoutMs: 600000,
    });
    const parsed = safeParseJson<{ results?: BatchResult[] }>(text);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    return new Map(results.filter(r => typeof r?.id === 'string').map(r => [r.id as string, r]));
  } catch (err) {
    log(`  [batch error] ${String(err).slice(0, 80)}`);
    return new Map();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const raw = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const findings: any[] = raw.findings;

const unverified = findings
  .filter(f => !f.verificationLog)
  .map(f => ({ id: f.id, url: f.url, title: f.title, summary: f.summary, whyBad: f.whyBad, article: null as string | null }));

log(`Found ${unverified.length} entries without verificationLog (out of ${findings.length} total)`);
if (DRY_RUN) log('DRY RUN — no writes will happen');

if (unverified.length === 0) {
  log('Nothing to verify. Exiting.');
  process.exit(0);
}

// Initialize SDK for scraping
await initResearchSDK({
  model: 'openrouter/google/gemma-4-26b-a4b-it',
  cwd: process.cwd(),
  config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 2, DEBUG: false },
  verbose: false,
});
log('SDK initialized');

// Phase 1: scrape all articles
log(`Scraping ${unverified.length} articles (concurrency=${SCRAPE_CONCURRENCY})...`);
const scraped = await mapWithConcurrency(unverified, SCRAPE_CONCURRENCY, async (item) => {
  const article = await scrapeOne(item.url);
  return { ...item, article };
});
const scrapedItems = scraped.map((r, i) => r.ok ? r.value : { ...unverified[i]!, article: null });
const gotArticle = scrapedItems.filter(it => it.article).length;
log(`Scraped ${gotArticle}/${scrapedItems.length} articles`);

// Phase 2: batch verify
log(`Verifying in batches of ${BATCH_SIZE}...`);
const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });

let kept = 0, dropped = 0, updated = 0, unchanged = 0;
const dropIds = new Set<string>();
const updates = new Map<string, { summary: string; whyBad: string }>();

for (let i = 0; i < scrapedItems.length; i += BATCH_SIZE) {
  const batch = scrapedItems.slice(i, i + BATCH_SIZE);
  log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(scrapedItems.length / BATCH_SIZE)} (${batch.length} entries)...`);
  const byId = await verifyBatch(batch, model);

  for (const item of batch) {
    const r = byId.get(item.id);
    if (!r) { unchanged++; continue; }
    if (r.valid === false) {
      log(`    DROP: ${item.url.slice(0, 70)}`);
      dropIds.add(item.id);
      dropped++;
    } else {
      const summary = (r.summary ?? '').trim();
      const whyBad = normalizeWhyBad(r.whyBad ?? '');
      if (summary.length >= 80 && whyBad.length >= 150) {
        updates.set(item.id, { summary, whyBad });
        updated++;
      } else {
        unchanged++;
      }
      kept++;
    }
  }
}

log(`\nSummary: ${kept} kept (${updated} updated, ${unchanged} unchanged), ${dropped} dropped`);

if (DRY_RUN) {
  log('DRY RUN complete — no writes.');
  await shutdownResearchSDK();
  process.exit(0);
}

// Apply updates and removals
const before = findings.length;
const newFindings = findings.filter(f => !dropIds.has(f.id)).map(f => {
  const upd = updates.get(f.id);
  if (upd) {
    return {
      ...f,
      summary: upd.summary,
      whyBad: upd.whyBad,
      verificationLog: `Reverify pass ${new Date().toISOString().slice(0, 10)}: article-grounded`,
    };
  }
  return f;
});

raw.findings = newFindings;
raw.totalFindings = newFindings.length;
raw.lastUpdated = new Date().toISOString();

if (!DRY_RUN) {
  writeAtomic(FINDINGS_PATH, raw);
  log(`Written: ${before} → ${newFindings.length} findings (removed ${before - newFindings.length})`);
}

await shutdownResearchSDK();
log('Done.');
