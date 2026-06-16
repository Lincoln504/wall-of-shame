#!/usr/bin/env tsx
/**
 * polish.ts — one-off CONSISTENCY pass over existing entries.
 *
 * Normalizes structure and removes hallucination-risk, grounded ONLY in each
 * entry's own existing content (no web, no new facts):
 *   - summary → a single flowing descriptive paragraph with at least one verbatim quote.
 *   - whyBad  → the numbered "1. … 5." analysis (renumbers prose), with any leaked
 *               verification/audit metadata removed.
 *   - GENERALIZES over-specific citations (statute/section numbers, case names,
 *     precise stats, specific study titles) that gemma can hallucinate → general
 *     assertions. Strips markdown.
 *
 * Only entries that actually need it are reprocessed (already-clean, citation-safe
 * entries are left untouched). A no-regression gate keeps the original field if the
 * model's output is structurally invalid or too short. API-only (no browsers), so
 * it is memory-safe to run at modest concurrency.
 *
 * Usage: npx tsx src/polish.ts [--concurrency 4] [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './findings.js';
import { GEMMA_MODEL_ID, getOpenRouterModel, completeText } from './models.js';
import { safeParseJson, normalizeWhyBad } from './utils.js';

const args = process.argv.slice(2);
const numArg = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  if (i === -1) return dflt;
  const v = parseInt(args[i + 1] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const CONCURRENCY = numArg('--concurrency', 4);
const DRY_RUN = args.includes('--dry-run');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');

interface Finding {
  url: string; title: string; domain?: string; summary: string;
  category: string; whyBad: string; severity?: string; verificationLog?: string; [k: string]: unknown;
}

// Patterns that flag over-specific (hallucinatable) citations.
const OVER_SPECIFIC = /\bU\.?S\.?C\.?\b|§|\bSection\s+\d|\b\d+(\.\d+)?\s?%|\b\d{4}\s+(study|report|survey)|\bv\.\s+[A-Z][a-z]+/;
const AUDIT_META = /Audit VERIFIED|URL accessible|URL verified|PDF accessible|Content confirmed|Text extraction confirms/i;
const MARKDOWN = /\*\*|__[A-Za-z]|`|^#{1,6}\s/m;
// Coined/academic rhetoric labels that read as jargon to a layman. If one appears
// WITHOUT an inline plain-language explanation nearby, the entry needs a readability pass.
const JARGON = /sympathetic-victim gambit|predator-prey dynamic|race-to-the-(bottom|top)|just-world fallacy|historical determinism|manufactured doubt|insinuation fallacy|threat inflation|false dichotomy|false dilemma|appeal to (authority|nature|fear)|ad hominem|straw ?man|whataboutism|motte[- ]and[- ]bailey|gish gallop|epistemic|hegemon/i;

function summaryNeedsWork(s: string): boolean {
  const t = (s || '').trim();
  if (/^-\s/.test(t) || /\n\s*-\s/.test(t)) return true; // bulleted (should be a paragraph)
  if (/\n/.test(t)) return true;                         // multi-line (should be one paragraph)
  if (MARKDOWN.test(t)) return true;
  return false;
}
function whyBadNeedsWork(w: string): boolean {
  const t = (w || '').trim();
  if (!/^1\.\s/.test(t)) return true;                    // not numbered
  if (AUDIT_META.test(t)) return true;                   // leaked metadata
  if (OVER_SPECIFIC.test(t)) return true;                // over-specific citation
  if (JARGON.test(t)) return true;                       // unexplained academic/rhetoric jargon
  if (MARKDOWN.test(t)) return true;
  return false;
}
function needsPolish(f: Finding): boolean {
  return summaryNeedsWork(f.summary) || whyBadNeedsWork(f.whyBad);
}

const POLISH_PROMPT = `You are the Lead Auditor cleaning up an EXISTING Wall of Shame entry for CONSISTENCY. Do NOT change the verdict, the facts, the URL, the title, or the category. Ground your output ONLY in the ENTRY below — no web access, no new facts, no fabrication.

Produce a cleaned "summary" and "whyBad":

SUMMARY: a single flowing descriptive paragraph (3–5 sentences, NO bullets, NO line breaks), in plain language, INCLUDING at least one verbatim quote (in quotation marks) taken from the entry. Preserve the substance of the existing summary; just render it as a clean paragraph.

WHYBAD: the numbered analysis, beginning directly with "1." (no "Analysis:" label, no surrounding brackets), covering in order: 1. a verbatim quote and the claim it advances; 2. the named framing technique(s) or fallacy(ies) in plain English; 3. the concrete real-world harm it normalizes/justifies/hides; 4. a sentence beginning "External Context:" with well-established rebutting facts stated GENERALLY; 5. where applicable "CONFLICT OF INTEREST:" and/or "TIMELINESS NOTE:". PRESERVE the depth and reasoning of the existing analysis — only restructure it into this numbered form and fix the problems below. Aim for 150–280 words.

FIX:
- Remove ALL verification/audit metadata ("Audit VERIFIED", "URL accessible (200)", "Content confirmed", "PDF accessible", author/date verification stamps). That belongs in a log, NEVER in the analysis.
- GENERALIZE every over-specific citation: replace statute/section numbers (e.g. "18 U.S.C. § 611"), specific case names, precise statistics/percentages, and specific study titles/dates with general assertions ("long-standing federal law already prohibits this"; "extensive peer-reviewed research finds the opposite"; "the agency's own data contradicts this"). Keep only extremely well-known institution names you are sure of (ADA, OSHA, Civil Rights Act). When unsure, argue from the piece's own logic.
- WRITE FOR A LAYMAN — remove jargon. Rewrite any coined or academic rhetoric label into a plain-language description of the move, in the same sentence. Replace terms like "sympathetic-victim gambit", "predator-prey dynamic", "race-to-the-bottom", "just-world fallacy", "false dichotomy", "threat inflation", "manufactured doubt" with what they actually mean in everyday words (e.g. "quotes a sympathetic example to distract from who the policy really hurts"; "presents only two options when others exist"; "stirs fear of an exaggerated threat"). A reader who has never studied rhetoric must understand every sentence on first read. If a precise legal/technical term is unavoidable, explain it inline.
- PLAIN TEXT only — no markdown (no asterisk bold/italics, no backtick code spans, no hash headers).

Return ONLY a raw JSON object: {"summary": "- ...\\n- ...", "whyBad": "1. ... 2. ... 3. ... 4. External Context: ... 5. ..."}`;

function buildUserText(f: Finding): string {
  return [
    `title: ${f.title}`,
    `domain: ${f.domain ?? ''}`,
    `category: ${f.category}`,
    `current summary:\n${f.summary}`,
    `current whyBad:\n${f.whyBad}`,
  ].join('\n\n');
}

async function polishOne(f: Finding): Promise<{ summary?: string; whyBad?: string } | null> {
  const model = await getOpenRouterModel(GEMMA_MODEL_ID, { reasoning: true });
  const text = await completeText(model, POLISH_PROMPT, buildUserText(f), { reasoning: 'medium' });
  if (!text?.trim()) return null;
  let obj: { summary?: string; whyBad?: string };
  try { obj = safeParseJson<{ summary?: string; whyBad?: string }>(text); } catch { return null; }

  const out: { summary?: string; whyBad?: string } = {};

  // whyBad gate: numbered, normalized, and not a degradation.
  const newWhy = normalizeWhyBad(obj.whyBad ?? '');
  const oldWhyClean = normalizeWhyBad(f.whyBad); // strips audit prefix for fair comparison
  if (/^1\.\s/.test(newWhy) && newWhy.length >= 150 && newWhy.length >= oldWhyClean.length * 0.6 && !OVER_SPECIFIC.test(newWhy) && !AUDIT_META.test(newWhy)) {
    out.whyBad = newWhy;
  }

  // summary gate: a single paragraph (no bullets/newlines), has a quote, not a degradation.
  const newSum = (obj.summary ?? '').trim();
  if (!/^-\s/.test(newSum) && !/\n/.test(newSum) && /["“”'’]/.test(newSum) && newSum.length >= Math.min(80, f.summary.length * 0.5)) {
    out.summary = newSum;
  }

  return (out.summary || out.whyBad) ? out : null;
}

async function pool<T>(items: T[], limit: number, worker: (it: T, i: number) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  });
  await Promise.all(runners);
}

async function main() {
  const store = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')) as { findings: Finding[] };
  const targets = store.findings.filter(needsPolish);
  console.log(`[polish] ${store.findings.length} entries; ${targets.length} need polishing (concurrency=${CONCURRENCY}, dry-run=${DRY_RUN})`);
  if (DRY_RUN) {
    const sumOnly = targets.filter(f => summaryNeedsWork(f.summary) && !whyBadNeedsWork(f.whyBad)).length;
    const whyOnly = targets.filter(f => !summaryNeedsWork(f.summary) && whyBadNeedsWork(f.whyBad)).length;
    const both = targets.filter(f => summaryNeedsWork(f.summary) && whyBadNeedsWork(f.whyBad)).length;
    console.log(`[polish] breakdown — summary-only:${sumOnly} whyBad-only:${whyOnly} both:${both}`);
    console.log('[polish] dry-run: no model calls, no file written.');
    return;
  }

  let okSum = 0, okWhy = 0, kept = 0;
  await pool(targets, CONCURRENCY, async (f) => {
    const tag = `${(f.category || '').padEnd(14)} ${(f.title || '').slice(0, 42)}`;
    try {
      const r = await polishOne(f);
      if (r?.whyBad) { f.whyBad = r.whyBad; okWhy++; }
      if (r?.summary) { f.summary = r.summary; okSum++; }
      console.log(`  ${r?.whyBad || r?.summary ? '✓' : '·'} ${tag}${r?.summary ? ' [sum]' : ''}${r?.whyBad ? ' [why]' : ''}`);
      if (!r) kept++;
    } catch (err) {
      kept++;
      console.log(`  ! ${tag}  ERROR ${String(err).slice(0, 70)}`);
    }
  });

  console.log(`[polish] summaries fixed=${okSum} whyBad fixed=${okWhy} kept-original=${kept}`);
  if (okSum + okWhy > 0) {
    copyFileSync(FINDINGS_PATH, FINDINGS_PATH + `.bak-${Date.now()}`);
    const tmp = FINDINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    writeFileSync(FINDINGS_PATH, readFileSync(tmp, 'utf-8'), 'utf-8');
    try { unlinkSync(tmp); } catch { /* best effort */ }
    console.log(`[polish] wrote ${FINDINGS_PATH} (backup saved).`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('polish fatal:', err); process.exit(1); });
