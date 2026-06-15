#!/usr/bin/env tsx
/**
 * backfill.ts — one-off enrichment pass over EXISTING findings.
 *
 * Earlier "concise" rounds (notably 2026-05-05) produced thin 2–3 sentence whyBad
 * analyses. This brings them up to the golden bar (rich, numbered, named-fallacy,
 * external-context breakdowns) using gemma at MEDIUM reasoning — the same engine
 * the live pipeline now uses.
 *
 * Safety properties:
 *   - Only entries whose whyBad is shorter than THRESHOLD are touched; the golden
 *     cohort (min length ~815) is never regenerated.
 *   - Grounding is the entry's OWN summary (which already contains the verbatim
 *     quote + the article's argument) + title + domain. No web, no fabrication.
 *   - NO-REGRESSION GATE: a regenerated whyBad is only accepted if it is clearly
 *     richer (>= MIN_NEW chars AND longer than the original). Otherwise the
 *     original is kept verbatim. url/title/id/severity are never changed.
 *   - findings.json is backed up before writing and written atomically.
 *
 * Usage: npx tsx src/backfill.ts [--threshold 800] [--concurrency 6] [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './findings.js';
import { GEMMA_MODEL_ID, getOpenRouterModel, completeText } from './models.js';
import { safeParseJson } from './utils.js';

const args = process.argv.slice(2);
const numArg = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const v = parseInt(args[i + 1] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const THRESHOLD = numArg('--threshold', 800);
const CONCURRENCY = numArg('--concurrency', 6);
const DRY_RUN = args.includes('--dry-run');
const MIN_NEW = 700; // a backfilled analysis must reach at least this length to be accepted

const FINDINGS_PATH = join(DATA_DIR, 'findings.json');

interface Finding {
  url: string; title: string; domain?: string; summary: string;
  category: string; whyBad: string; severity?: string;
  verificationLog?: string; id?: string; foundAt?: string; researchQuery?: string;
}

const BACKFILL_PROMPT = `You are the Lead Auditor for the Wall of Shame database. You are re-auditing an EXISTING, already-approved entry to raise its analysis ("whyBad") to the database's golden quality bar. The entry stays on the wall and its verdict is unchanged — your ONLY job is to ENRICH and DEEPEN the whyBad.

You have NO web access. Ground your analysis ONLY in the ENTRY below — its summary already contains the article's verbatim quote and core argument. Do not change the URL, title, or category.

Write a whyBad that:
- begins with the literal token "Analysis: [" and ends with "]";
- is 180–280 words, written as an explicitly NUMBERED breakdown;
1. cite the verbatim quote (in quotation marks) and the claim it advances;
2. name the precise framing technique or logical fallacy in plain English (e.g. "false dichotomy", "loaded language", "sympathetic-victim gambit", "manufactured doubt", "cherry-picking", "just-world fallacy") — list MULTIPLE where present;
3. explain concretely how it normalizes, justifies, or hides real-world harm;
4. a sentence beginning "External Context:" supplying well-established rebutting facts (named studies, laws, agencies, outcomes, dates);
5. where applicable, a sentence beginning "CONFLICT OF INTEREST:" (author/publisher funding or institutional stake) and/or "TIMELINESS NOTE:" (a prediction that aged poorly).

NO FABRICATION: external context must be genuinely well-established public knowledge. Never invent specific statistics, study names, or figures you are not confident are real; if unsure, argue from the piece's own logic instead. Plain hard-hitting English, no academic jargon.

Return ONLY a raw JSON object: {"whyBad": "Analysis: [ ... ]"}`;

function buildUserText(f: Finding): string {
  return [
    `title: ${f.title}`,
    `domain: ${f.domain ?? ''}`,
    `category: ${f.category}`,
    `severity: ${f.severity ?? ''}`,
    `summary:\n${f.summary}`,
    `current whyBad (improve/expand, keep any genuine facts):\n${f.whyBad}`,
  ].join('\n\n');
}

async function enrichOne(f: Finding, log: (m: string) => void): Promise<string | null> {
  const model = await getOpenRouterModel(GEMMA_MODEL_ID, { reasoning: true });
  const text = await completeText(model, BACKFILL_PROMPT, buildUserText(f), { reasoning: 'medium' });
  if (!text?.trim()) return null;
  let whyBad = '';
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const obj = safeParseJson<{ whyBad?: string }>(m ? m[0] : text);
    whyBad = (obj.whyBad ?? '').trim();
  } catch {
    // Fall back to raw text if it looks like a bare analysis.
    if (/Analysis:\s*\[/.test(text)) whyBad = text.trim();
  }
  if (!whyBad) return null;
  // NO-REGRESSION GATE.
  if (whyBad.length < MIN_NEW || whyBad.length <= f.whyBad.length) {
    log(`    rejected (new=${whyBad.length} <= old=${f.whyBad.length})`);
    return null;
  }
  return whyBad;
}

async function pool<T>(items: T[], limit: number, worker: (it: T, i: number) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const store = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')) as { totalFindings?: number; findings: Finding[] };
  const targets = store.findings.filter(f => (f.whyBad || '').length < THRESHOLD);
  console.log(`[backfill] ${store.findings.length} entries; ${targets.length} below ${THRESHOLD} chars to enrich (concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  if (targets.length === 0) { console.log('[backfill] nothing to do.'); return; }

  let enriched = 0, kept = 0;
  const stamp = new Date().toISOString().slice(0, 10);

  await pool(targets, CONCURRENCY, async (f) => {
    const tag = `${f.category.padEnd(11)} ${(f.title || '').slice(0, 44)}`;
    try {
      const better = await enrichOne(f, (m) => console.log(m));
      if (better) {
        if (!DRY_RUN) {
          f.whyBad = better;
          f.verificationLog = `${(f.verificationLog ? f.verificationLog + ' | ' : '')}enriched ${stamp} (medium-reasoning backfill)`;
        }
        enriched++;
        console.log(`  ✓ ${tag}  ${better.length} chars`);
      } else {
        kept++;
        console.log(`  · ${tag}  kept original`);
      }
    } catch (err) {
      kept++;
      console.log(`  ! ${tag}  ERROR ${String(err).slice(0, 80)} — kept original`);
    }
  });

  console.log(`[backfill] enriched=${enriched} kept=${kept}`);
  if (DRY_RUN) { console.log('[backfill] dry-run: no file written.'); return; }
  if (enriched > 0) {
    copyFileSync(FINDINGS_PATH, FINDINGS_PATH + `.bak-${Date.now()}`);
    const tmp = FINDINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    writeFileSync(FINDINGS_PATH, readFileSync(tmp, 'utf-8'), 'utf-8');
    try { unlinkSync(tmp); } catch { /* best effort */ }
    console.log(`[backfill] wrote ${FINDINGS_PATH} (backup saved).`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('backfill fatal:', err); process.exit(1); });
