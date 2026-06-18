/**
 * verify.ts — final grounding & standards verification before entry.
 *
 * Two phases:
 *   1. SCRAPE — re-fetch each candidate's OWN article using pi-research's two-layer
 *      scraper (fast HTTP fetch, then stealth-browser fallback) exposed via the SDK's
 *      scrapeUrl(). This is what makes the grounding real: we check the draft against
 *      the page itself, not the multi-source synthesis it was written from.
 *   2. VERIFY (batched) — group ~10 candidates (each with its scraped article text)
 *      into ONE DeepSeek V4 Pro call (1M-token context, cheap). For each entry the
 *      model GROUNDS it against the real article AND enforces every house standard
 *      (paragraph summary, numbered analysis, no vague unnamed-authority appeals, no
 *      filler points, no over-specificity, layman plain text). Entries the article
 *      verifiably does not support are dropped.
 *
 * It NEVER breaks the pipeline. If a page can't be scraped the entry is still
 * standards-cleaned from its draft (never dropped for missing text); if the batch
 * call fails or an item fails a quality gate, the desk-audited finding is kept as-is.
 * Per-item fallback is keyed on the stable finding id the model echoes back.
 */
import { scrapeUrl } from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { VERIFY_MODEL_ID, getOpenRouterModel, completeText } from './models.js';
import { safeParseJson, normalizeWhyBad, mapWithConcurrency, isErrorOrBlockedPage } from './utils.js';

const MIN_ARTICLE_CHARS = 400;   // below this the scrape is too thin to ground on
const MAX_ARTICLE_CHARS = 10000; // bound per-article context handed to the model
const SCRAPE_CONCURRENCY = 3;    // the browser pool bounds real browsers underneath
const BATCH_CONCURRENCY = 2;     // concurrent verification batches
const BATCH_SIZE = Math.max(1, Number(process.env['WOS_VERIFY_BATCH']) || 10);
// Hard ceiling on a single grounding scrape. The SDK has its own internal scrape
// timeout, but during an unattended overnight loop one wedged page must never stall
// a whole category — past this we fall back to standards-only for that entry.
const SCRAPE_TIMEOUT_MS = Math.max(15000, Number(process.env['WOS_VERIFY_SCRAPE_TIMEOUT_MS']) || 60000);

const BATCH_GROUND_PROMPT = `You are the Lead Auditor performing the FINAL verification of a batch of Wall of Shame entries before they are published. You will receive several numbered entries. For EACH entry, return exactly one result object, echoing back its "id".

Each entry gives you: id, TITLE, URL, ARTICLE TEXT (the real scraped page — or the literal word UNAVAILABLE), DRAFT SUMMARY, and DRAFT ANALYSIS. The drafts were written from a multi-source synthesis; your job is to ground them in what the page REALLY says and to enforce the house standards.

DIRECTIONAL TEST — APPLY FIRST, BEFORE ANYTHING ELSE. The Wall of Shame targets content that in any way props up, advances, sanitizes, launders, rationalizes, excuses, normalizes, or defends harmful power. It does NOT target content that EXPOSES, DOCUMENTS, REPORTS ON, or CRITICIZES harm. These are fundamentally opposite things, and confusing them is the most dangerous error.

Ask for each entry: "Whose side is this piece on?" and "What does it do to harm?" — the range is wide, from mild to severe:
- Mild end: softens or sugarcoats exploitation, treats injustice as inevitable, minimizes documented harm
- Middle: rationalizes regressive policy, launders corporate or government wrongdoing as reasonable, excuses dehumanization as policy necessity
- Severe end: outright advocates for stripping rights, serves as propaganda for extremist ideology, provides explicit cover for atrocities or disinformation

KEEP (set valid:true) if the piece performs any of the above — if it is on the side of those who exploit, dehumanize, restrict rights, or obstruct accountability.
DROP (set valid:false) if the piece is on the side of victims, critics, journalists, or reformers — even if its subject matter overlaps exactly with our categories.

CRITICAL FAILURE MODE TO AVOID: Research reports and academic studies that DOCUMENT problems are not targets. If a piece CONCLUDES that a policy is bad, unjust, or harmful — it is criticizing power, not defending it.
- A study showing school vouchers mainly benefit already-wealthy families → EXPOSING a problem → set valid:false
- An op-ed arguing school vouchers empower parents and expand freedom → DEFENDING the policy → valid:true
- A Georgetown report revealing that 64% of voucher recipients were already in private school → that piece CRITICIZES vouchers → set valid:false
- An industry brief claiming drug price controls will kill innovation → DEFENDING high prices → valid:true
- A public health study documenting how insurers deny claims → EXPOSING harm → set valid:false
- A journalism piece reporting that a politician used dehumanizing language → CRITICIZING that language → set valid:false

Red flags in the DRAFT that suggest a misclassified entry (apply even when ARTICLE TEXT is UNAVAILABLE):
- Summary uses "examines," "reveals," "documents," "shows," "analyzes," "investigates," "finds that" followed by a CRITICAL conclusion — this is journalism or research EXPOSING harm, not defending it
- WhyBad describes the HARM OF THE TOPIC (e.g., "vouchers divert public money") rather than the HARM COMMITTED BY THE PIECE (e.g., "piece argues vouchers are good")
- The piece's apparent conclusion is that the policy/practice is BAD — that is accountability, not normalization

PER ENTRY:
A) IF ARTICLE TEXT is provided (not UNAVAILABLE):
   0. DIRECTIONAL CHECK: apply the directional test above using the real article text. If the article's own argument DEFENDS or NORMALIZES harm — proceed. If the article EXPOSES, CRITICIZES, or DOCUMENTS harm — set "valid": false immediately; do not proceed to grounding steps.
   1. VERIFY THE QUOTE: check whether the summary contains text inside quotation marks. If it does, confirm those exact words appear in the ARTICLE TEXT. If the quoted text does not appear verbatim in the ARTICLE TEXT, either (a) replace it with a real verbatim excerpt copied word-for-word from the ARTICLE TEXT, or (b) rephrase the sentence as a paraphrase without quotation marks. Never retain a quote you cannot confirm. Never invent a replacement quote — a paraphrase without quotes is always better than a fabricated quote.
   2. VERIFY THE CLAIMS: check every claim in the analysis against the ARTICLE TEXT; remove or soften anything the article does not support. Keep the critical verdict ONLY if the article genuinely exhibits the harmful framing.
   3. GROUND THE SPECIFICS: where the ARTICLE TEXT contains a concrete real detail that sharpens the analysis, use it (it is grounded, not invented). You MAY include a specific (a number, name, statute) ONLY if it literally appears in the ARTICLE TEXT.
   4. VALIDITY: if the ARTICLE TEXT does NOT support this entry belonging on a Wall of Shame — it argues the opposite of harmful framing, or the page is an error/unrelated/blocked page — set "valid": false.
B) IF ARTICLE TEXT is UNAVAILABLE: apply the directional test to the DRAFT SUMMARY and DRAFT ANALYSIS. Default to "valid": false — set valid:true and proceed to standards enforcement ONLY IF the draft clearly and unambiguously describes a piece that DEFENDS or NORMALIZES harm (i.e., it argues the harmful thing is justified, natural, or good). If there is any doubt — if the draft reads like journalism, research, or criticism — set valid:false.

HOUSE STANDARDS — enforce on EVERY entry:
- "summary": a single flowing descriptive PARAGRAPH (3–5 sentences, NO bullets, NO line breaks), plain layman language. Include a verbatim quote ONLY if you confirmed the exact wording appears in the ARTICLE TEXT — otherwise describe the claim as a paraphrase without quotation marks. A summary with no quoted text is correct; a fabricated quote is not.
- "whyBad": a NUMBERED analysis beginning directly with "1." (no "Analysis:" label, no brackets), of ONLY as many points as carry real substance — normally 3 to 5. REQUIRED: 1. the quote + the claim it advances; 2. the manipulation tactic in EVERYDAY words, explained in the same sentence (never a bare academic label); 3. the concrete real-world harm it normalizes/justifies/hides. OPTIONAL: 4. a sentence beginning "External Context:" with a real, well-established fact stated generally — include ONLY if you genuinely have one; 5. "Conflict of interest:" and/or "Timeliness note:" where they genuinely apply. NEVER pad to a fixed count and NEVER write a filler placeholder point such as "5. No additional context", "None", "N/A", or "Not applicable" — end at the last real point.
- NO VAGUE AUTHORITIES: never support a point by gesturing at unnamed sources — no "multiple news outlets reported", "studies show", "many experts agree", "research finds", "researchers found", "critics note", "reports indicate", "widely reported" — UNLESS that exact statement appears in the ARTICLE TEXT. Otherwise state a plain common fact in your own words, argue from the piece's own logic, or say nothing.
- NO OVER-SPECIFICITY: no fabricated statute/section numbers, case names, precise statistics/percentages, or study titles/dates unless they literally appear in the ARTICLE TEXT. Name only extremely well-known institutions you are sure of (ADA, OSHA, the Civil Rights Act, the EPA).
- Plain layman English, 150–280 words for whyBad, PLAIN TEXT ONLY (no markdown), and NO audit/verification metadata ("URL accessible", "Content confirmed", etc.).
- NO ALL-CAPS words or labels in the output: write labels in sentence case ("External Context:", "Conflict of interest:", "Timeliness note:"), never shouting capitals, and rewrite any all-caps emphasis in the draft into normal case (ordinary acronyms like the ADA, OSHA, the EPA are fine).

OUTPUT: return ONLY a raw JSON object, no markdown, no preamble:
{"results": [{"id": "<echo the entry id>", "valid": true, "summary": "<cleaned paragraph>", "whyBad": "1. ... 2. ... 3. ... (optional 4. External Context: ...; 5. Conflict of interest: / Timeliness note: ...) — end at the last real point, never pad"}, ...]}
Return one object per input entry, in any order, each with the matching id.`;

function buildBatchUserText(items: { f: RawFinding; article: string | null }[]): string {
  const blocks = items.map((it, i) => {
    const art = it.article ? it.article : 'UNAVAILABLE';
    return [
      `[ENTRY ${i + 1}]`,
      `id: ${it.f.url}`,
      `TITLE: ${it.f.title}`,
      `URL: ${it.f.url}`,
      `ARTICLE TEXT:\n${art}`,
      `DRAFT SUMMARY:\n${it.f.summary}`,
      `DRAFT ANALYSIS:\n${it.f.whyBad}`,
    ].join('\n');
  });
  return `Verify the following ${items.length} entr${items.length === 1 ? 'y' : 'ies'} and return one result object per entry (echo each id).\n\n${blocks.join('\n\n')}`;
}

// Acronyms that legitimately appear in all-caps in entries — whitelist them out of
// the all-caps shouting check. Keep sorted and expand as new acronyms surface.
const ACRONYM_WHITELIST_RE = /\b(ACA|ADA|ADEC|AFL|ACLJ|AI|ALPR|APA|ATF|BLM|CBP|CATO|CDC|CEO|CFO|COO|CFPB|CRT|DACA|DEA|DEI|DHS|DOD|DOJ|DOL|DOT|DOGE|EEOC|EPA|ESA|ESG|EU|FAA|FBI|FCC|FDA|FEMA|FIFA|FMLA|FTC|GAO|GDP|GDPR|GOP|HHS|HIMARS|HIPAA|HUD|ICE|ICU|IMF|IRS|ITIF|JDAM|KKK|LGBT|LGBTQ|LIBOR|MAGA|MBS|MLRS|NAFTA|NATO|NBER|NFIB|NLRB|NLRA|NIH|NIST|NRA|NSA|OMB|OSHA|PAC|PPP|PR|RAND|REIT|RNC|DNC|SBA|SAVE|SEC|SEIU|SNAP|SSI|SSDI|STEM|SWIFT|TARP|TPP|TSA|UN|US|UK|USMCA|UBI|VA|VC|WTO|WHO)\b/g;

/** A grounded summary must be a single prose paragraph — no bullets, no line breaks. */
function summaryOk(s: string): boolean {
  const t = (s || '').trim();
  return (
    t.length >= 80 &&
    !/\n/.test(t) &&              // no line breaks (must be a single paragraph)
    !/^-\s/.test(t) &&            // no leading bullet
    !/\n\s*-\s/.test(t) &&        // no interior bullets
    !/\b[A-Z]{3,}\b/.test(t.replace(ACRONYM_WHITELIST_RE, ''))  // no shouting all-caps
  );
}

/** A grounded analysis must be a numbered breakdown with at least 3 points. */
function whyBadOk(w: string): boolean {
  const t = (w || '').trim();
  return (
    /^1\.\s/.test(t) &&           // starts with point 1
    /\b2\.\s/.test(t) &&          // has point 2 (tactic)
    /\b3\.\s/.test(t) &&          // has point 3 (real-world harm)
    t.length >= 150 &&
    !/\b[A-Z]{3,}\b/.test(t.replace(ACRONYM_WHITELIST_RE, ''))  // no shouting all-caps
  );
}

interface BatchResult { id?: string; valid?: boolean; summary?: string; whyBad?: string }

/**
 * Verify one batch in a single DeepSeek V4 Pro call. Returns, aligned to `items`,
 * the grounded finding, the unchanged finding (gate/parse miss → keep desk audit),
 * or null (article verified NOT to support the entry → drop).
 */
async function verifyBatch(
  items: { f: RawFinding; article: string | null }[],
  log: (m: string) => void,
): Promise<(RawFinding | null)[]> {
  let byId = new Map<string, BatchResult>();
  try {
    const model = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: true });
    const text = await completeText(model, BATCH_GROUND_PROMPT, buildBatchUserText(items), {
      reasoning: 'medium', temperature: 0.3, topP: 0.9, json: true, timeoutMs: 180000,
    });
    const parsed = safeParseJson<{ results?: BatchResult[] }>(text);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    byId = new Map(results.filter(r => r && typeof r.id === 'string').map(r => [r.id as string, r]));
  } catch (err) {
    log(`    [verify] batch error (${String(err).slice(0, 60)}) — keeping desk audit for ${items.length} entr${items.length === 1 ? 'y' : 'ies'}`);
    return items.map(it => it.f); // failure isolation: never lose the batch
  }

  return items.map((it) => {
    const r = byId.get(it.f.url);
    if (!r) return it.f; // model omitted it — keep the desk audit
    if (r.valid === false) {
      log(`    [verify] ${it.f.domain ?? it.f.url}: article does not support the entry — DROPPED`);
      return null;
    }
    const summary = (r.summary ?? '').trim();
    const whyBad = normalizeWhyBad(r.whyBad ?? '');
    if (summaryOk(summary) && whyBadOk(whyBad)) {
      return { ...it.f, summary, whyBad, verificationLog: `DeepSeek verify: article-grounded ${new Date().toISOString().slice(0, 10)}` };
    }
    return it.f; // returned output failed quality gates — keep the desk audit
  });
}

/** Scrape one finding's own article. Reuses _articleText from the reviewer stage if available. */
async function scrapeOne(f: RawFinding, log: (m: string) => void): Promise<{ f: RawFinding; article: string | null }> {
  // Reuse article scraped by the reviewer stage — avoids double-fetching the same URL.
  // Guard: if the cached content is an error page, treat as unavailable and re-scrape.
  if (f._articleText && f._articleText.length >= MIN_ARTICLE_CHARS && !isErrorOrBlockedPage(f._articleText)) {
    return { f, article: f._articleText.slice(0, MAX_ARTICLE_CHARS) };
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`scrape timeout after ${SCRAPE_TIMEOUT_MS}ms`)), SCRAPE_TIMEOUT_MS);
    });
    let res;
    try {
      res = await Promise.race([scrapeUrl(f.url), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = res.markdown?.trim() ?? '';
    if (!res.success || text.length < MIN_ARTICLE_CHARS || isErrorOrBlockedPage(text)) {
      return { f, article: null };
    }
    return { f, article: text.slice(0, MAX_ARTICLE_CHARS) };
  } catch (err) {
    log(`    [verify] ${f.domain ?? f.url}: scrape error (${String(err).slice(0, 50)}) — standards-only`);
    return { f, article: null };
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Ground + standards-verify a list of reviewed findings before entry. Scrapes each
 * article, then runs batched DeepSeek verification. Drops only entries an article
 * verifiably contradicts; keeps everything else (grounded, standards-cleaned, or
 * desk-audited on any failure).
 */
export async function groundFindings(
  findings: RawFinding[],
  log: (m: string) => void,
): Promise<RawFinding[]> {
  if (findings.length === 0) return findings;
  log(`  [verify] grounding ${findings.length} finding(s) against live article text (batched via ${VERIFY_MODEL_ID})...`);

  // Phase 1 — scrape every article concurrently.
  const scraped = await mapWithConcurrency(findings, SCRAPE_CONCURRENCY, (f) => scrapeOne(f, log));
  const items = scraped.map((r, i) => (r.ok ? r.value : { f: findings[i]!, article: null }));
  const scrapedCount = items.filter(it => it.article).length;
  log(`  [verify] scraped ${scrapedCount}/${items.length} article(s); verifying in batches of ${BATCH_SIZE}...`);

  // Phase 2 — verify in batches (each batch = one big-context call).
  const batches = chunk(items, BATCH_SIZE);
  const settled = await mapWithConcurrency(batches, BATCH_CONCURRENCY, (b) => verifyBatch(b, log));

  const out: RawFinding[] = [];
  let dropped = 0;
  settled.forEach((r, bi) => {
    if (r.ok) {
      r.value.forEach((v) => { if (v === null) dropped++; else out.push(v); });
    } else {
      batches[bi]!.forEach(it => out.push(it.f)); // batch threw entirely — keep originals
    }
  });
  log(`  [verify] kept ${out.length}, dropped ${dropped} (unsupported by source)`);
  // Strip pipeline-only field before findings are written to disk.
  return out.map(({ _articleText: _, ...rest }) => rest as RawFinding);
}
