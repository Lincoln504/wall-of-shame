/**
 * reviewer.ts — the audit/refinement stage (Qwen3.6, batched, article-grounded).
 *
 * Design: a grounded desk audit. Each candidate finding gets its own article
 * scraped via the SDK's two-layer scraper (fast HTTP → stealth-browser fallback)
 * before review. The reviewer audits each batch against the real article text —
 * not just the multi-source synthesis — which closes the directional
 * misclassification risk that existed when the reviewer could only see the
 * research-stage synthesis.
 *
 * Pipeline stage:
 *   researcher → REVIEWER → verify (DeepSeek final grounding)
 *
 * The reviewer's job (Qwen3.6, NO web access beyond scrapeUrl):
 *   1. Scope-gate using the REAL article: drop neutral reporting / journalism /
 *      academic research and anything that doesn't conclusively defend harm.
 *   2. Verify every quote/claim against the article text.
 *   3. Preserve-or-strengthen whyBad to the golden quality bar.
 *   4. Set directionalBasis (one sentence: what the piece concludes).
 *
 * Batching: REVIEWER_BATCH_SIZE findings per call (default 8), each with its
 * scraped article text. The verify stage (DeepSeek, 1M ctx) is a second, final
 * grounding pass after this.
 */

import { scrapeUrl } from '@lincoln504/pi-research';
import { Type } from 'typebox';
import { repairJson } from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { safeParseValidatedJson, mapWithConcurrency, isErrorOrBlockedPage } from './utils.js';
import { getOpenRouterModel, completeText, pickModelForContext } from './models.js';

// ── Reviewer schemas ─────────────────────────────────────────────────────────

const ReviewedFindingSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  category: Type.String(),
  whyBad: Type.String(),
  domain: Type.Optional(Type.String()),
  severity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  verificationLog: Type.Optional(Type.String()),
  directionalBasis: Type.Optional(Type.String()),
});

const ReviewerOutputSchema = Type.Array(ReviewedFindingSchema);

// ── Scraping ─────────────────────────────────────────────────────────────────

const REVIEWER_SCRAPE_CONCURRENCY = 4;
const REVIEWER_SCRAPE_TIMEOUT_MS = Math.max(15000, Number(process.env['WOS_REVIEW_SCRAPE_TIMEOUT_MS']) || 45000);
const REVIEWER_BATCH_SIZE = Math.max(1, Number(process.env['WOS_REVIEW_BATCH']) || 8);
const MIN_ARTICLE_CHARS = 400;
const MAX_ARTICLE_CHARS = 8000;

async function scrapeOneForReview(url: string): Promise<string | null> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('scrape timeout')), REVIEWER_SCRAPE_TIMEOUT_MS);
    });
    let res;
    try {
      res = await Promise.race([scrapeUrl(url), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = res.markdown?.trim() ?? '';
    if (!res.success || text.length < MIN_ARTICLE_CHARS || isErrorOrBlockedPage(text)) {
      return null;
    }
    return text.slice(0, MAX_ARTICLE_CHARS);
  } catch {
    return null;
  }
}

function chunkFindings<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are the Lead Auditor for the Wall of Shame database. Rigorously vet the candidate findings produced by the research team.

You do NOT have open web access. For each candidate you receive the ACTUAL ARTICLE TEXT scraped from the URL. Use that text as the primary source for grounding and the directional test. If a candidate's ARTICLE TEXT is UNAVAILABLE, rely on the RESEARCH CONTEXT and the candidate data alone, applying default-drop for any ambiguity.

MISSION: We only list content where the PIECE ITSELF — through its own argument, framing, or intent — works to sanitize, excuse, advance, launder, normalize, justify, or minimize harm. This spans a wide spectrum: from mild pieces that subtly treat exploitation as natural or inevitable, to moderate pieces that rationalize regressive policy through biased framing, to severe pieces that actively advocate for dehumanization, spread disinformation, or serve as propaganda for extremist ideology. The common thread is that the piece is on the side of power, not accountability. Neutral, factual reporting of a harmful event is NOT for this database — only content that is itself complicit in the harm, provides cover for it, or advances it.

DIRECTIONAL RULE — THE MOST CRITICAL GATE. This database targets content that DEFENDS power and NORMALIZES harm. It does NOT target content that EXPOSES, CRITICIZES, or REPORTS ON harm. Confusing these two is the most dangerous error.

A piece QUALIFIES — it is on the side of harm in any of these ways (INCLUDE):
- Outright advocates: an op-ed arguing billionaires deserve their wealth, a manifesto that police violence is justified, content that calls immigrants criminals or invaders
- Sanitizes / launders: industry PR greenwashing a fossil fuel company, a think-tank brief that dresses up union-busting as worker freedom, military euphemisms used to hide civilian deaths
- Normalizes / naturalizes: treating wage suppression as market economics, presenting austerity as the only responsible choice, framing inequality as just "how things work"
- Rationalizes / excuses: arguing that denied healthcare is responsible "cost control," excusing mass surveillance as a necessary security trade-off, presenting anti-democratic power grabs as "reform"
- Legitimizes harmful ideas by giving them unearned credibility: treating white nationalist talking points as legitimate policy debate, manufacturing doubt about settled science by platforming fringe "experts"
- Serves as propaganda or cover: content that advances a harmful agenda while posing as neutral, analysis that provides political cover for exploitation or discrimination

A piece DOES NOT QUALIFY (exposes or criticizes harm — OMIT):
- The Guardian / AP / NPR / Reuters reporting that Trump used dehumanizing language (journalism ABOUT harm ≠ the harm itself)
- Jacobin, DeSmog, InfluenceMap, The Nation, or similar publications EXPOSING corporate or government wrongdoing
- A Harvard or academic study DOCUMENTING how fossil fuel companies obstruct climate action
- A progressive op-ed ARGUING AGAINST oligarchy, inequality, or exploitation (criticizing the problem ≠ the problem)
- An article ANALYZING military euphemisms like "collateral damage" to EXPOSE how they hide civilian deaths
- ANY university, policy center, or research institution report (Georgetown, Brookings, Pew, RAND, etc.) that CONCLUDES a policy is harmful or unjust — those are critics, not defenders
- ANY article that REVEALS, EXPOSES, DOCUMENTS, or INVESTIGATES a harm, even if its subject matter matches one of our categories exactly

THE CONCLUSION TEST — the single most reliable filter: What does this piece CONCLUDE? If its conclusion is "this is bad, harmful, unjust, or should change" → OMIT (it is on the side of accountability). If its conclusion is "this is good, natural, necessary, or justified" → INCLUDE (it normalizes harm).

ARTICLE TEXT GROUNDING — APPLY WHEN ARTICLE TEXT IS PROVIDED:
0. STUB / ERROR PAGE CHECK — BEFORE ANYTHING ELSE: Is the article text actually the article about the topic? If it is instead a "Page Not Found" / 404 page, an access-denied or login wall, a generic homepage, a subscribe prompt, or any content that clearly does not discuss the topic named in the title — OMIT this finding immediately. Do NOT fall back to the research context as a substitute. A finding whose live page is an error or stub cannot be verified and must be dropped, regardless of how compelling the research context looks.
1. DIRECTIONAL CHECK using the real article text: ask "whose side is this piece on?" If the article itself EXPOSES, CRITICIZES, or DOCUMENTS harm → OMIT immediately.
2. VERIFY THE QUOTE: if the summary contains text in quotation marks, confirm those exact words appear verbatim in the ARTICLE TEXT. If not: either replace with a real verbatim excerpt, or rephrase as a paraphrase without quotes. Never retain an unconfirmed quote.
3. VERIFY THE CLAIMS: check every claim in the analysis against the ARTICLE TEXT; remove or soften anything the article does not support.
4. VALIDITY: if the ARTICLE TEXT does NOT support this entry belonging on a Wall of Shame — it argues the opposite of harmful framing — OMIT.

ARTICLE TEXT UNAVAILABLE — APPLY WHEN ARTICLE TEXT IS UNAVAILABLE:
Apply the directional test to the DRAFT SUMMARY and DRAFT ANALYSIS. Default to OMIT — keep ONLY IF the draft clearly and unambiguously describes a piece that DEFENDS or NORMALIZES harm with a specific, non-circular argument AND the source is a recognizable advocacy outlet, think-tank, or partisan publisher (not an unknown or academic URL). If there is any doubt — if the draft reads like journalism, research, or criticism of harm, or the source is unfamiliar — OMIT.

FOR EACH candidate, apply this workflow:
1. SCOPE GATE — Apply the DIRECTIONAL TEST. MANDATORY: Can you complete "This piece CONCLUDES that [harmful thing] is [good/justified/necessary/natural]"? If you cannot write this sentence with a specific, non-circular claim → OMIT. Use this sentence as directionalBasis in output.
2. GROUNDING CHECK — Confirm every claim and quoted text is consistent with the ARTICLE TEXT (or RESEARCH CONTEXT when unavailable). Unverifiable quotes: remove marks and rephrase, or drop the finding.
3. PRESERVE-OR-STRENGTHEN whyBad (NEVER shorten):
   - PRESERVE if already rich (>=150 words, substantive claims, specific fallacies, numbered structure) — keep as-is or correct only factual inaccuracies.
   - STRENGTHEN if thin — expand to the full bar below.
   The bar: a numbered breakdown of AT LEAST 150 words (aim 180–280). Begin directly with "1." — no "Analysis:" label, no brackets. REQUIRED points 1–3, in order:
   1. cite a specific claim from the piece; verbatim quote ONLY if confirmed in ARTICLE TEXT — otherwise describe without quotes;
   2. name the manipulation tactic in EVERYDAY words in the SAME sentence (e.g. "presents only two options when others exist") — define ALL tactics present; never use a coined label without defining it;
   3. what the piece DOES to harm — sanitize / launder / excuse / rationalize / normalize / minimize / propagandize / advocate — plus the concrete real-world consequence. If a specific, well-established fact makes the harm concrete, state it plainly in your own words here (NO vague authority appeals: "studies show", "many experts agree", "critics note", "research finds" — state only concrete facts you know with certainty).
   OPTIONAL point 4 — "External Context:" — ENCOURAGED whenever a broad, common-sense real-world fact (something widely understood to be true, stated in general terms — NOT a precise statistic, study title, or citation) helps a general reader see why the harm matters. Add it when it genuinely deepens understanding; skip it only when nothing real comes to mind. Never invent specifics.
   OPTIONAL point 5 — "Conflict of interest:" — include ONLY when the source has a documented, specific financial or institutional stake in the position it advocates (e.g. industry funding, named funder, author is an executive of a beneficiary). Skip if speculative or generic.
   NEVER pad and NEVER write "No additional context", "None", "N/A". End at the last real point.
   WRITE FOR A LAYMAN: plain English, no academic jargon (define any technical term immediately). No markdown. No ALL-CAPS emphasis — write labels in sentence case (ordinary acronyms like ADA, OSHA, EPA are fine).
   NO FABRICATION: no statute/section numbers, no invented case names, no precise statistics or study titles unless they literally appear in the ARTICLE TEXT. Argue from the piece's own logic or state common facts in general terms.
4. STRUCTURE — "summary" MUST be a single flowing paragraph (3–5 sentences, no bullets, no line breaks). "whyBad" MUST be the numbered breakdown beginning at "1.". Strip any audit/verification metadata that leaked into whyBad. PLAIN TEXT ONLY.
5. SEVERITY — calibrate honestly:
   - high: actively dehumanizes a group, advocates for stripping rights, serves as explicit propaganda for extremist ideology, covers for documented atrocities, or spreads disinformation as a tool;
   - medium: sanitizes, rationalizes, or excuses regressive policy/exploitation — advances a harmful agenda without rising to outright dehumanization;
   - low: one-sided, subtly minimizes or excuses harm, but with some genuine good-faith basis; prefer "low" over omitting when the piece genuinely qualifies but is mild.

OUTPUT: Return ONLY a raw JSON array of APPROVED findings (no markdown, no preamble). Omit anything that fails the gate; an empty array [] is valid.
Each entry must include:
{
  "url": "...",
  "title": "...",
  "domain": "...",
  "summary": "Single flowing paragraph, no bullets, no line breaks. Verbatim quote only if confirmed in ARTICLE TEXT.",
  "category": "...",
  "whyBad": "1. specific claim. 2. manipulation tactic in everyday words. 3. harm done + real-world consequence. Optional: 4. External Context: [concrete fact]. Optional: 5. Conflict of interest: [documented stake]. 150–280 words total. No filler, no pads.",
  "severity": "low|medium|high",
  "directionalBasis": "One sentence: what does this piece CONCLUDE that makes it a bad actor?",
  "verificationLog": "Desk audit: article-grounded / unavailable-fallback — one-line reason."
}`;

const MAX_CONTEXT_CHARS = 24000;

function buildBatchUserText(
  items: { f: RawFinding; article: string | null }[],
  ctx: string,
): string {
  const contextBlock = ctx
    ? `RESEARCH CONTEXT (broader synthesis from the research team):\n${ctx.slice(0, MAX_CONTEXT_CHARS)}`
    : '(no separate research context supplied)';

  const entries = items.map((it, i) => {
    const art = it.article ? it.article : 'UNAVAILABLE';
    return [
      `[ENTRY ${i + 1}]`,
      `URL: ${it.f.url}`,
      `TITLE: ${it.f.title}`,
      `ARTICLE TEXT:\n${art}`,
      `CANDIDATE:\n${JSON.stringify(it.f, null, 2)}`,
    ].join('\n');
  });

  return `${contextBlock}\n\n${entries.join('\n\n---\n\n')}\n\nReturn ONLY the raw JSON array of approved findings.`;
}

// ── Batch processor ───────────────────────────────────────────────────────────

async function reviewBatch(
  items: { f: RawFinding; article: string | null }[],
  ctx: string,
  log: (m: string) => void,
): Promise<RawFinding[]> {
  const userText = buildBatchUserText(items, ctx);
  const modelId = pickModelForContext(userText);
  const model = await getOpenRouterModel(modelId, { reasoning: false });

  try {
    const text = await completeText(
      model,
      REVIEW_SYSTEM_PROMPT,
      userText,
      { reasoning: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 },
    );
    if (!text.trim()) {
      log('  [reviewer] empty response for batch — keeping desk audit for all');
      return items.map(it => it.f);
    }

    let reviewed: RawFinding[];
    try {
      reviewed = safeParseValidatedJson(ReviewerOutputSchema, text);
    } catch {
      const repaired = repairJson(text);
      if (repaired) {
        reviewed = safeParseValidatedJson(ReviewerOutputSchema, repaired);
      } else {
        log(`  [reviewer] batch parse failed — keeping desk audit`);
        return items.map(it => it.f);
      }
    }
    // Attach scraped article text so the verifier stage can reuse it without re-fetching.
    const articleByUrl = new Map(items.map(it => [it.f.url, it.article]));
    return reviewed.map(r => ({ ...r, _articleText: articleByUrl.get(r.url) ?? undefined }));
  } catch (err) {
    log(`  [reviewer] batch error (${String(err).slice(0, 60)}) — keeping desk audit for batch`);
    return items.map(it => it.f);
  }
}

// ── Raw-report path (fallback when extraction produces nothing) ───────────────

const REVIEW_PROMPT_RAWREPORT = `${REVIEW_SYSTEM_PROMPT}

RESEARCH CONTEXT (extract findings from this text):
<CONTEXT>

No pre-extracted candidate findings exist — extract any qualifying entries directly from the RESEARCH CONTEXT above, then audit each one against the same rules.

Return ONLY the raw JSON array.`;

const MAX_CONTEXT_CHARS_LEGACY = 16000;

async function reviewRawReport(
  report: string,
  log: (m: string) => void,
): Promise<RawFinding[]> {
  log('  [reviewer] desk audit of raw report...');
  const prompt = REVIEW_PROMPT_RAWREPORT
    .replace('<CONTEXT>', report.slice(0, MAX_CONTEXT_CHARS_LEGACY));

  const modelId = pickModelForContext(report);
  const model = await getOpenRouterModel(modelId, { reasoning: false });

  try {
    const text = await completeText(
      model,
      prompt,
      'Extract and audit findings from the report above. Return ONLY the JSON array.',
      { reasoning: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 },
    );
    if (!text.trim()) return [];

    let reviewed: RawFinding[];
    try {
      reviewed = safeParseValidatedJson(ReviewerOutputSchema, text);
    } catch {
      const repaired = repairJson(text);
      if (repaired) {
        reviewed = safeParseValidatedJson(ReviewerOutputSchema, repaired);
        log('  [reviewer] repaired JSON from raw report path.');
      } else {
        throw new Error('JSON parse + repair both failed');
      }
    }
    log(`  [reviewer] raw-report audit complete. ${reviewed.length} findings approved.`);
    return reviewed;
  } catch (err) {
    log(`  [reviewer] raw-report AUDIT FAILED: ${String(err)}`);
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Audit and sharpen candidate findings (or mine a raw report) with Qwen3.6.
 *
 * When input is a RawFinding array: scrapes each article URL first, then processes
 * in batches of REVIEWER_BATCH_SIZE, each batch getting its article texts inlined.
 * When input is a raw report string: falls back to the single-call legacy path.
 *
 * @param input    JSON-serializable array of candidate findings, OR a raw report string.
 * @param log      logger.
 * @param context  optional raw research report for desk-audit grounding when input is
 *                 a findings array (ignored when input is already the report).
 */
export async function runReview(
  input: RawFinding[] | string,
  log: (msg: string) => void,
  context?: string,
): Promise<RawFinding[]> {
  const isRawReport = typeof input === 'string';

  // Fallback path: no findings extracted → reviewer mines the raw report directly.
  if (isRawReport) {
    return reviewRawReport(input, log);
  }

  if (input.length === 0) return [];

  log(`  [reviewer] scraping ${input.length} article(s) before desk audit...`);

  // Phase 1: scrape every candidate's article URL in parallel.
  const scraped = await mapWithConcurrency(
    input,
    REVIEWER_SCRAPE_CONCURRENCY,
    async (f) => ({ f, article: await scrapeOneForReview(f.url) }),
  );
  const items = scraped.map((r, i) => (r.ok ? r.value : { f: input[i]!, article: null as string | null }));

  const scrapedCount = items.filter(it => it.article).length;
  log(`  [reviewer] scraped ${scrapedCount}/${items.length} article(s); auditing in batches of ${REVIEWER_BATCH_SIZE}...`);

  // Phase 2: review in batches, each batch = one Qwen3.6 call.
  const ctx = context ?? '';
  const batches = chunkFindings(items, REVIEWER_BATCH_SIZE);
  const allReviewed: RawFinding[] = [];

  for (const batch of batches) {
    const batchReviewed = await reviewBatch(batch, ctx, log);
    allReviewed.push(...batchReviewed);
  }

  log(`  [reviewer] audit complete. ${allReviewed.length}/${input.length} findings approved.`);
  return allReviewed;
}
