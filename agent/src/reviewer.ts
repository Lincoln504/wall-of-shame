/**
 * reviewer.ts — the audit/refinement stage (gemma, single completeSimple call).
 *
 * Design: a fast desk audit, NOT an agentic re-research. The earlier design gave
 * the reviewer the pi-research `research` tool and had it re-fetch every URL —
 * 7–9 minutes PER finding, which made scaling to thousands of entries impossible.
 *
 * Grounding is already supplied upstream:
 *   - the gemma research stage actually scraped the pages (via the pi-research SDK),
 *   - the gemma extraction stage (medium reasoning) required verbatim quotes drawn
 *     from that report and produced the rich multi-point whyBad,
 *   - the merge stage (findings.ts) does a live existence check (verifyUrl) before
 *     anything is written to the wall.
 *
 * So the reviewer's job (gemma, medium reasoning, NO web access) is a deterministic
 * desk audit: scope-gate (drop neutral reporting / off-topic), verify each
 * quote/claim is consistent with the supplied RESEARCH CONTEXT (no new network
 * calls), and PRESERVE-or-STRENGTHEN whyBad to the golden bar — never oversimplify.
 */

import { Type } from 'typebox';
import { repairJson } from '@lincoln504/pi-research';
import type { RawFinding } from './findings.js';
import { safeParseValidatedJson } from './utils.js';
import { getOpenRouterModel, completeText, pickModelForContext } from './models.js';

// ── Reviewer schemas ─────────────────────────────────────────────────────────

// Only the fields a finding genuinely cannot exist without are required. domain is
// derived from the URL downstream (addFindings), severity defaults to 'medium', and
// verificationLog is informational — making them required caused the reviewer to throw
// and drop EVERY finding whenever gemma (reasoning-off) omitted one of them.
const ReviewedFindingSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  category: Type.String(),
  whyBad: Type.String(),
  domain: Type.Optional(Type.String()),
  severity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  verificationLog: Type.Optional(Type.String()),
});

const ReviewerOutputSchema = Type.Array(ReviewedFindingSchema);

const REVIEW_PROMPT = `You are the Lead Auditor for the Wall of Shame database. Rigorously vet the candidate findings produced by the research team.

You do NOT have web access. Judge each candidate using ONLY the candidate data and the RESEARCH CONTEXT supplied below (the context is the report our researcher produced after actually scraping the pages).

MISSION: We only list content where the PIECE ITSELF works to normalize, justify, or hide the harm of regressive policies (across class, labor, economics, race, democracy, policing, war, immigration, religion, climate, health, technology, disability, and patriarchy/misogyny). Neutral, factual reporting of a harmful event is NOT for this database — only biased framing that makes exploitation, discrimination, or cruelty seem acceptable, natural, or deserved.

INPUT may be either (A) a JSON array of candidate findings, or (B) a raw research report. If (B), first extract the qualifying findings, then audit them with the same rules.

FOR EACH candidate, apply this workflow:
1. SCOPE GATE — Confirm the source's net effect is to normalize/justify/hide harm. OMIT it if it is neutral reporting, if it actually criticizes the harm, or if it is off-topic for its category.
2. GROUNDING CHECK — The summary MUST contain at least one verbatim quote. Confirm the quote and the article's described argument are consistent with the RESEARCH CONTEXT. If a claim is NOT supported by the context, OMIT the finding — never invent support or fabricate quotes.
3. PRESERVE-OR-STRENGTHEN whyBad (NEVER oversimplify, NEVER shorten a good analysis):
   - PRESERVE: if the analysis is already rich (>=150 words, cites a verbatim quote, names specific fallacies, and supplies external context), KEEP IT AS-IS or only correct factual inaccuracies. Do not trim it.
   - STRENGTHEN: if it is thin, generic, or under-developed, EXPAND it to the full bar below. Adding depth is the goal; collapsing it into two or three sentences is a FAILURE of the audit.
   The bar — a scathing, evidence-grounded, plain-English breakdown of AT LEAST 150 words (aim 180–280). Begin the text directly with "1." — do NOT prepend an "Analysis:" label and do NOT wrap it in square brackets (the site adds its own "Analysis:" heading). Cover in order:
   1. cite a specific claim or verbatim quote from the piece (in quotation marks);
   2. describe the manipulation tactic in EVERYDAY words and explain what it means in the SAME sentence (e.g. "presents only two options when others exist", "stirs fear of an exaggerated threat", "quotes a sympathetic example to distract from the policy's real victims") — list MULTIPLE where present. Do NOT drop a bare coined/academic label (no lone "sympathetic-victim gambit", "race-to-the-bottom fallacy"); if any such term is used, define it in plain words immediately;
   3. explain concretely how it normalizes, justifies, or hides real-world harm;
   4. OPTIONAL — only if you genuinely have one: a sentence beginning "External Context:" with a real, well-established rebutting fact stated plainly in general terms (omit this point entirely if you have none);
   5. OPTIONAL — only where it genuinely applies: a sentence beginning "Conflict of interest:" (author/publisher funding or institutional stake) and/or "Timeliness note:" (a prediction that aged poorly).
   Write only as many numbered points as carry real substance (normally 3–5). NEVER pad to a fixed count and NEVER write a filler placeholder point such as "5. No additional context", "None", "N/A", or "Not applicable" — end at the last point of real substance, and DELETE any such filler you find in a candidate.
   WRITE FOR A LAYMAN: hard-hitting, common-person English. No academic jargon or empty buzzwords. If a precise technical or legal term is unavoidable, explain it in plain words in the same sentence — and rewrite any existing jargon in the candidate (e.g. "predator-prey dynamic", "sympathetic-victim gambit") into a plain-language description the first-time reader understands.
   NO FABRICATION / NO OVER-SPECIFICITY: external context must be genuinely well-established public knowledge, stated GENERALLY. Do NOT invent or include over-specific identifiers that are easily fabricated — no statute/section numbers (e.g. "18 U.S.C. § 611"), no specific case names, no precise statistics/percentages, no specific study titles or uncertain dates. Assert the fact generally ("long-standing federal law already prohibits this") instead of a precise citation. Name only extremely well-known institutions you are sure of (ADA, OSHA, Civil Rights Act). If a candidate's whyBad already contains such over-specific citations, GENERALIZE them. If unsure, argue from the piece's own logic.
   NO VAGUE AUTHORITIES: never support a point by gesturing at unnamed sources. Strip and rewrite any "multiple news outlets reported", "studies show", "many experts agree", "research finds", "researchers found", "critics note", "reports indicate", or "it is widely reported" phrasing — replace it with a plainly-stated common fact in your own words, or an argument from the piece's own logic. If a candidate leans on such an appeal and you have no real fact to substitute, delete that claim.
4. STRUCTURE & READABILITY — the "summary" MUST be a single flowing descriptive PARAGRAPH (3–5 sentences, no bullets, no line breaks) with at least one verbatim quote; reformat any bulleted summary into a paragraph. The "whyBad" MUST be the numbered breakdown beginning at "1."; renumber a prose analysis and DROP any filler placeholder point (e.g. "5. No additional context"). STRIP any verification/audit metadata that leaked into whyBad (e.g. "Audit VERIFIED", "URL accessible (200)", "Content confirmed", "PDF accessible") — that belongs in verificationLog, never in the analysis. PLAIN TEXT ONLY — no markdown: no asterisk bold or italics, no backtick code spans, no hash headers. NO ALL-CAPS words or labels in the output: write labels in sentence case ("External Context:", "Conflict of interest:", "Timeliness note:"), never shouting capitals, and rewrite any all-caps emphasis already in a candidate into normal case (ordinary acronyms like the ADA, OSHA, the EPA are fine).
5. SEVERITY (calibrate honestly — do not inflate):
   - high: actively dehumanizes a group, justifies stripping rights/safety/lives, promotes disinformation, or launders extremist ideology into the mainstream;
   - medium: normalizes regressive policy or economic harm through biased framing, short of dehumanization or disinformation;
   - low: a contestable position with genuine legal/constitutional or good-faith grounding, but still one-sided enough to qualify (prefer low over omitting when real but mild).

OUTPUT FORMAT:
Return ONLY a raw JSON array of the APPROVED findings (no markdown, no preamble). Omit anything that fails the gate; an empty array [] is a valid answer.
Each entry must follow this schema exactly:
{
  "url": "...",
  "title": "...",
  "domain": "...",
  "summary": "A flowing 3-5 sentence paragraph in plain language, including at least one verbatim quote in quotation marks. Not a list.",
  "category": "...",
  "whyBad": "1. verbatim quote. 2. named fallacy/framing technique(s) in plain words. 3. concrete real-world harm. (Then OPTIONALLY: 4. External Context: a real rebutting fact in your own words, no unnamed-authority appeals — omit if you have none. 5. Conflict of interest / Timeliness note where it genuinely applies.) End at the last real point — never pad or write 'No additional context'. (>=150 words; preserve rich researcher analysis, never shorten it; no 'Analysis:' label, no brackets, no audit metadata)",
  "severity": "low|medium|high",
  "verificationLog": "Desk audit: preserved/strengthened — one-line reason and what was checked against the context."
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
  log(`  [reviewer] desk audit of ${countLabel}...`);

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

  // Context-aware routing: the candidates + report context are normally snippet-sized →
  // the Qwen3.6-35B-A3B workhorse; an unusually large audit input escalates to DeepSeek
  // V4 Pro (see models.ts).
  const modelId = pickModelForContext(inputContent + (context ?? ''));
  const model = await getOpenRouterModel(modelId, { reasoning: false });

  try {
    // Review returns a JSON ARRAY, so json-object mode is not used here (it requires an
    // object root). NON-THINKING (instruct) mode like extraction: Qwen3.6-35B-A3B with
    // thinking disabled, on Qwen's official instruct sampling profile (temp 0.7, top_p 0.80,
    // top_k 20, min_p 0, presence_penalty 1.5 — vendor-recommended, and not below temp 0.6).
    const text = await completeText(model, prompt, 'Audit the candidates above and return ONLY the JSON array.', { reasoning: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 });
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
