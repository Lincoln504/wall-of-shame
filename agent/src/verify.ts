/**
 * verify.ts — per-link grounding & verification (Option B).
 *
 * After review, each candidate finding is checked against the ACTUAL article text,
 * not the multi-source research synthesis it was written from. We re-scrape the
 * finding's own URL using pi-research's SAME two-layer scraper (fast HTTP fetch, then
 * stealth-browser fallback) exposed via the SDK's scrapeUrl(), then run one grounded
 * gemma pass that:
 *   - confirms the summary's verbatim quote actually appears in the article (replacing
 *     it with a real one if the model had drifted),
 *   - verifies each analytical claim is supported by the real text (softening/removing
 *     unsupported ones, and adding concrete specifics that ARE in the article),
 *   - drops an entry the article does not actually support (valid:false).
 *
 * It NEVER breaks the pipeline: if the page can't be scraped (paywall/Cloudflare/dead),
 * or the grounded output fails a quality gate, the desk-audited finding is kept as-is.
 * Requires the research SDK to be initialized (it is, by the time review runs).
 */
import { scrapeUrl } from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { GEMMA_MODEL_ID, getOpenRouterModel, completeText } from './models.js';
import { safeParseJson, normalizeWhyBad, mapWithConcurrency } from './utils.js';

const MIN_ARTICLE_CHARS = 400;   // below this the scrape is too thin to ground on
const MAX_ARTICLE_CHARS = 12000; // bound the context handed to gemma
const GROUND_CONCURRENCY = 2;    // per category; the browser pool bounds real browsers

const GROUND_PROMPT = `You are the Lead Auditor VERIFYING a Wall of Shame entry against the ACTUAL article text provided below. The draft summary and analysis were written from a multi-source synthesis; your job is to ground them in what the article REALLY says. Use ONLY the ARTICLE TEXT — no web access, no outside facts.

Do all of the following:
1. VERIFY THE QUOTE: confirm the verbatim quote in the draft summary actually appears in the ARTICLE TEXT. If it does not appear (the model paraphrased or invented it), replace it with a real verbatim quote taken word-for-word from the ARTICLE TEXT.
2. VERIFY THE CLAIMS: check every claim in the analysis against the ARTICLE TEXT. Remove or soften any claim the article does not support. Keep the critical verdict ONLY if the article genuinely exhibits the harmful framing.
3. GROUND THE SPECIFICS: where the ARTICLE TEXT contains a concrete, real detail that sharpens the analysis, you MAY use it (it is grounded, not invented). Still do NOT add outside citations — no statute/section numbers, case names, statistics, or study titles UNLESS they literally appear in the ARTICLE TEXT.
4. VALIDITY: if the ARTICLE TEXT does NOT actually support this entry belonging on a Wall of Shame — it is neutral/factual reporting, argues the opposite, or the page is an error/unrelated page — set "valid": false.

Keep the EXACT format and standards:
- "summary": a single flowing descriptive PARAGRAPH (3–5 sentences, no bullets, no line breaks) in plain layman language, including at least one verbatim quote (in quotation marks) that appears in the ARTICLE TEXT.
- "whyBad": the numbered analysis beginning directly with "1." (no "Analysis:" label, no brackets), covering the quote+claim, the manipulation tactic explained in plain everyday words, the concrete harm, an "External Context:" sentence stated generally, and any "CONFLICT OF INTEREST:"/"TIMELINESS NOTE:". 150–280 words. Plain layman English, NO markdown, NO audit/verification metadata.

Return ONLY a raw JSON object: {"valid": true, "summary": "...", "whyBad": "1. ... 2. ... 3. ..."}`;

function buildUserText(f: RawFinding, article: string): string {
  return [
    `ARTICLE TITLE: ${f.title}`,
    `URL: ${f.url}`,
    `\nARTICLE TEXT (scraped):\n${article}`,
    `\nDRAFT SUMMARY:\n${f.summary}`,
    `\nDRAFT ANALYSIS:\n${f.whyBad}`,
  ].join('\n');
}

/** A grounded summary must still be a single paragraph with a quote. */
function summaryOk(s: string): boolean {
  const t = (s || '').trim();
  return t.length >= 80 && !/^-\s/.test(t) && !/\n\s*-\s/.test(t) && /["“”'’][^"“”'’]{3,}["“”'’]/.test(t);
}
/** A grounded analysis must still be the numbered breakdown. */
function whyBadOk(w: string): boolean {
  const t = (w || '').trim();
  return /^1\.\s/.test(t) && t.length >= 150;
}

/**
 * Ground a single finding against its scraped article. Returns the grounded finding,
 * the unchanged finding (scrape/gate failure → keep desk audit), or null (article
 * verified NOT to support the entry → drop it).
 */
async function groundOne(f: RawFinding, log: (m: string) => void): Promise<RawFinding | null> {
  let article: string;
  try {
    const res = await scrapeUrl(f.url);
    if (!res.success || !res.markdown || res.markdown.trim().length < MIN_ARTICLE_CHARS) {
      log(`    [ground] ${f.domain ?? f.url}: page not scrapable — keeping desk audit`);
      return f;
    }
    article = res.markdown.trim().slice(0, MAX_ARTICLE_CHARS);
  } catch (err) {
    log(`    [ground] ${f.domain ?? f.url}: scrape error (${String(err).slice(0, 60)}) — keeping desk audit`);
    return f;
  }

  try {
    const model = await getOpenRouterModel(GEMMA_MODEL_ID, { reasoning: true });
    const text = await completeText(model, GROUND_PROMPT, buildUserText(f, article), {
      reasoning: 'medium', temperature: 0.3, topP: 0.9, json: true,
    });
    const obj = safeParseJson<{ valid?: boolean; summary?: string; whyBad?: string }>(text);

    if (obj.valid === false) {
      log(`    [ground] ${f.domain ?? f.url}: article does not support the entry — DROPPED`);
      return null;
    }
    const summary = (obj.summary ?? '').trim();
    const whyBad = normalizeWhyBad(obj.whyBad ?? '');
    if (summaryOk(summary) && whyBadOk(whyBad)) {
      log(`    [ground] ${f.domain ?? f.url}: grounded ✓`);
      return { ...f, summary, whyBad };
    }
    log(`    [ground] ${f.domain ?? f.url}: grounded output failed gate — keeping desk audit`);
    return f;
  } catch (err) {
    log(`    [ground] ${f.domain ?? f.url}: grounding error (${String(err).slice(0, 60)}) — keeping desk audit`);
    return f;
  }
}

/**
 * Ground a batch of reviewed findings against their real article text. Drops only the
 * entries an article verifiably contradicts; keeps everything else (grounded or
 * desk-audited). Bounded concurrency so it adds little load on top of the run.
 */
export async function groundFindings(
  findings: RawFinding[],
  log: (m: string) => void,
): Promise<RawFinding[]> {
  if (findings.length === 0) return findings;
  log(`  [ground] verifying ${findings.length} finding(s) against live article text...`);
  const settled = await mapWithConcurrency(findings, GROUND_CONCURRENCY, (f) => groundOne(f, log));
  const out: RawFinding[] = [];
  let dropped = 0, kept = 0;
  settled.forEach((r, i) => {
    if (r.ok) {
      if (r.value === null) dropped++;
      else { out.push(r.value); kept++; }
    } else {
      out.push(findings[i]!); kept++; // failure isolation: never lose a finding to an error
    }
  });
  log(`  [ground] kept ${kept}, dropped ${dropped} (unsupported by source)`);
  return out;
}
