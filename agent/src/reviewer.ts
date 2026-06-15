/**
 * reviewer.ts — the audit/refinement stage (gemma, single completeSimple call).
 *
 * Design: a fast desk audit, NOT an agentic re-research. The earlier design gave
 * the reviewer the pi-research `research` tool and had it re-fetch every URL —
 * 7–9 minutes PER finding, which made scaling to thousands of entries impossible.
 *
 * Grounding is already supplied upstream:
 *   - the deepseek research stage actually scraped the pages,
 *   - the gemma extraction stage required verbatim quotes drawn from that report,
 *   - the merge stage (findings.ts) does a live stealth-browser existence check
 *     (verifyUrl) before anything is written to the wall.
 *
 * So the reviewer's job is a cheap, deterministic pass: scope-gate (drop neutral
 * reporting / off-topic), verify each quote/claim is consistent with the supplied
 * RESEARCH CONTEXT (no new network calls), and sharpen whyBad to the golden bar.
 */

import { Type } from 'typebox';
import { repairJson } from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { safeParseValidatedJson } from './utils.js';
import { GEMMA_MODEL_ID, getOpenRouterModel, completeText } from './models.js';

// ── Reviewer schemas ─────────────────────────────────────────────────────────

const ReviewedFindingSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  domain: Type.String(),
  summary: Type.String(),
  category: Type.String(),
  whyBad: Type.String(),
  severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  verificationLog: Type.String(),
});

const ReviewerOutputSchema = Type.Array(ReviewedFindingSchema);

const REVIEW_PROMPT = `You are the Lead Auditor for the Wall of Shame database. Rigorously vet the candidate findings produced by the research team.

You do NOT have web access. Judge each candidate using ONLY the candidate data and the RESEARCH CONTEXT supplied below (the context is the report our researcher produced after actually scraping the pages).

MISSION: We only list content where the PIECE ITSELF works to normalize, justify, or hide the harm of regressive policies (across class, labor, economics, race, democracy, policing, war, immigration, religion, climate, health, technology, disability, and patriarchy/misogyny). Neutral, factual reporting of a harmful event is NOT for this database — only biased framing that makes exploitation, discrimination, or cruelty seem acceptable, natural, or deserved.

INPUT may be either (A) a JSON array of candidate findings, or (B) a raw research report. If (B), first extract the qualifying findings, then audit them with the same rules.

FOR EACH candidate, apply this workflow:
1. SCOPE GATE — Confirm the source's net effect is to normalize/justify/hide harm. OMIT it if it is neutral reporting, if it actually criticizes the harm, or if it is off-topic for its category.
2. GROUNDING CHECK — The summary MUST contain at least one verbatim quote. Confirm the quote and the article's described argument are consistent with the RESEARCH CONTEXT. If a claim is NOT supported by the context, OMIT the finding — never invent support or fabricate quotes.
3. SHARPEN whyBad — Rewrite it into a scathing, evidence-grounded, plain-English numbered breakdown of AT LEAST 120 words:
   1. cite a specific claim or verbatim quote from the piece;
   2. name the precise framing technique or logical fallacy in plain English (e.g. "race-to-the-bottom fallacy", "sympathetic-victim gambit", "manufactured doubt", "cherry-picking");
   3. explain concretely how it normalizes, justifies, or hides real-world harm;
   4. supply well-established rebutting context (studies, law, outcomes) and flag any conflict of interest, funding bias, or predictions that aged poorly.
   No academic jargon or empty buzzwords — hard-hitting, common-person English.
4. READABILITY — summary and whyBad must be plain and clear.

OUTPUT FORMAT:
Return ONLY a raw JSON array of the APPROVED findings (no markdown, no preamble). Omit anything that fails the gate; an empty array [] is a valid answer.
Each entry must follow this schema exactly:
{
  "url": "...",
  "title": "...",
  "domain": "...",
  "summary": "- key points in plain language, including at least one verbatim quote.",
  "category": "...",
  "whyBad": "1. ... 2. ... 3. ... 4. ... (>=120 words, scathing, evidence-grounded)",
  "severity": "low|medium|high",
  "verificationLog": "Desk audit: kept/modified — one-line reason and what was checked against the context."
}

Severity scale: low | medium | high ONLY.

RESEARCH CONTEXT:
<CONTEXT>

CANDIDATE FINDINGS:
<FINDINGS_JSON>

Return ONLY the raw JSON array.`;

const MAX_CONTEXT_CHARS = 16000;

/**
 * Audit and sharpen candidate findings (or mine a raw report) with gemma.
 *
 * @param input    a JSON-serializable array of candidate findings, OR a raw report string.
 * @param log      logger.
 * @param context  optional raw research report used as desk-audit grounding when
 *                 `input` is a findings array (ignored when input is already the report).
 */
export async function runReview(
  input: RawFinding[] | string,
  log: (msg: string) => void,
  context?: string,
): Promise<RawFinding[]> {
  const isRawReport = typeof input === 'string';
  if (!isRawReport && input.length === 0) return [];

  const countLabel = isRawReport ? 'raw report' : `${input.length} findings`;
  log(`  [reviewer] desk audit (gemma) of ${countLabel}...`);

  const inputContent = isRawReport ? input : JSON.stringify(input, null, 2);
  // When auditing a findings array, ground the audit in the research report.
  // When the input already IS the report, it is its own context.
  const ctxSource = isRawReport ? input : (context ?? '');
  const ctx = ctxSource
    ? ctxSource.slice(0, MAX_CONTEXT_CHARS)
    : '(no separate context supplied — judge using the candidate data and your general knowledge; do not invent quotes.)';

  const prompt = REVIEW_PROMPT
    .replace('<CONTEXT>', ctx)
    .replace('<FINDINGS_JSON>', inputContent);

  const model = await getOpenRouterModel(GEMMA_MODEL_ID, { reasoning: false });

  try {
    const text = await completeText(model, prompt, 'Audit the candidates above and return ONLY the JSON array.');
    if (!text.trim()) {
      log('  [reviewer] empty response');
      return [];
    }

    let reviewed: RawFinding[];
    try {
      reviewed = safeParseValidatedJson(ReviewerOutputSchema, text);
    } catch (parseErr) {
      log(`  [reviewer] parse failed, attempting JSON repair...`);
      const repaired = repairJson(text);
      if (repaired) {
        reviewed = safeParseValidatedJson(ReviewerOutputSchema, repaired);
        log(`  [reviewer] repaired JSON successfully.`);
      } else {
        throw parseErr;
      }
    }

    const originalCount = isRawReport ? '(from report)' : String(input.length);
    log(`  [reviewer] audit complete. ${reviewed.length}/${originalCount} findings approved.`);
    return reviewed;
  } catch (err) {
    log(`  [reviewer] AUDIT FAILED: ${String(err)}`);
    throw err;
  }
}
