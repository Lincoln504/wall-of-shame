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
- Brewminate or any outlet writing that "Trump uses dehumanizing language toward immigrants" — they are CRITICIZING that language
- NationOfChange writing that a law strips due process — they are CRITICIZING that law
- ANY university, policy center, or research institution report (Georgetown, Brookings, Pew, RAND, etc.) that CONCLUDES a policy is harmful or unjust — those are critics, not defenders
- ANY article that REVEALS, EXPOSES, DOCUMENTS, or INVESTIGATES a harm, even if its subject matter matches one of our categories exactly

THE CONCLUSION TEST — the single most reliable filter: What does this piece CONCLUDE? If its conclusion is "this is bad, harmful, unjust, or should change" → OMIT (it is on the side of accountability). If its conclusion is "this is good, natural, necessary, or justified" → INCLUDE (it normalizes harm). A research report finding that school vouchers mainly benefit the already-wealthy CONCLUDES that vouchers are a bad deal — it is a critic. An op-ed arguing vouchers expand parental freedom CONCLUDES vouchers are good — it is a defender.

CRITICAL FAILURE MODE: Do NOT include a piece just because its SUBJECT MATTER overlaps with a category. A piece ABOUT school vouchers funding religious schools does not qualify — only include it if the piece ARGUES that vouchers are good. A piece ABOUT police violence does not qualify — only include it if the piece ARGUES police violence is justified. Subject ≠ stance. You are looking for pieces that PERFORM the harm, not pieces that WITNESS or DOCUMENT it. The whyBad must describe harm committed by the PIECE ITSELF (i.e., "this piece argues X is justified") — not harm of the topic the piece covers.

THE DIRECTIONAL TEST: Ask "whose side is this piece on?" A piece is for the Wall of Shame only if it is ON THE SIDE of those who exploit, dehumanize, or obstruct accountability. If the piece is on the side of victims, critics, journalists, or reformers, OMIT IT — even if the subject matter overlaps exactly with our categories. An article about billionaire exploitation is not harmful if it argues that billionaires are the problem, not the solution.

INPUT may be either (A) a JSON array of candidate findings, or (B) a raw research report. If (B), first extract the qualifying findings, then audit them with the same rules.

FOR EACH candidate, apply this workflow:
1. SCOPE GATE — Apply the DIRECTIONAL TEST above. Ask: is this piece on the side of power (include) or on the side of accountability (omit)? OMIT it if it is neutral reporting, investigative journalism, or if it actually criticizes the harm. Also omit if it is off-topic for its category.
2. GROUNDING CHECK — The summary MUST contain at least one verbatim quote. Confirm the quote and the article's described argument are consistent with the RESEARCH CONTEXT. If a claim is NOT supported by the context, OMIT the finding — never invent support or fabricate quotes.
3. PRESERVE-OR-STRENGTHEN whyBad (NEVER oversimplify, NEVER shorten a good analysis):
   - PRESERVE: if the analysis is already rich (>=150 words, cites a verbatim quote, names specific fallacies, and supplies external context), KEEP IT AS-IS or only correct factual inaccuracies. Do not trim it.
   - STRENGTHEN: if it is thin, generic, or under-developed, EXPAND it to the full bar below. Adding depth is the goal; collapsing it into two or three sentences is a FAILURE of the audit.
   The bar — a scathing, evidence-grounded, plain-English breakdown of AT LEAST 150 words (aim 180–280). Begin the text directly with "1." — do NOT prepend an "Analysis:" label and do NOT wrap it in square brackets (the site adds its own "Analysis:" heading). Cover in order:
   1. cite a specific claim or verbatim quote from the piece (in quotation marks);
   2. describe the manipulation tactic in EVERYDAY words and explain what it means in the SAME sentence (e.g. "presents only two options when others exist", "stirs fear of an exaggerated threat", "quotes a sympathetic example to distract from the policy's real victims") — list MULTIPLE where present. Do NOT drop a bare coined/academic label (no lone "sympathetic-victim gambit", "race-to-the-bottom fallacy"); if any such term is used, define it in plain words immediately;
   3. name precisely what the piece does — pick language from the full spectrum, from mild to severe: does it sanitize (make the harmful look clean and acceptable), launder (make the harmful look respectable or mainstream), excuse (frame the harmful as unavoidable), rationalize (construct logic to make the harmful seem reasonable), normalize (present the harmful as natural or inevitable), minimize (make the harmful look minor or overstated), propagandize (mislead people on behalf of a power interest), or outright advocate (champion the harmful as good and deserved)? Then explain concretely what real-world harm this enables or protects;
   4. OPTIONAL — only if you genuinely have one: a sentence beginning "External Context:" with a real, well-established rebutting fact stated plainly in general terms (omit this point entirely if you have none);
   5. OPTIONAL — only where it genuinely applies: a sentence beginning "Conflict of interest:" (author/publisher funding or institutional stake) and/or "Timeliness note:" (a prediction that aged poorly).
   Write only as many numbered points as carry real substance (normally 3–5). NEVER pad to a fixed count and NEVER write a filler placeholder point such as "5. No additional context", "None", "N/A", or "Not applicable" — end at the last point of real substance, and DELETE any such filler you find in a candidate.
   WRITE FOR A LAYMAN: hard-hitting, common-person English. No academic jargon or empty buzzwords. If a precise technical or legal term is unavoidable, explain it in plain words in the same sentence — and rewrite any existing jargon in the candidate (e.g. "predator-prey dynamic", "sympathetic-victim gambit") into a plain-language description the first-time reader understands.
   NO FABRICATION / NO OVER-SPECIFICITY: external context must be genuinely well-established public knowledge, stated GENERALLY. Do NOT invent or include over-specific identifiers that are easily fabricated — no statute/section numbers (e.g. "18 U.S.C. § 611"), no specific case names, no precise statistics/percentages, no specific study titles or uncertain dates. Assert the fact generally ("long-standing federal law already prohibits this") instead of a precise citation. Name only extremely well-known institutions you are sure of (ADA, OSHA, Civil Rights Act). If a candidate's whyBad already contains such over-specific citations, GENERALIZE them. If unsure, argue from the piece's own logic.
   NO VAGUE AUTHORITIES: never support a point by gesturing at unnamed sources. Strip and rewrite any "multiple news outlets reported", "studies show", "many experts agree", "research finds", "researchers found", "critics note", "reports indicate", or "it is widely reported" phrasing — replace it with a plainly-stated common fact in your own words, or an argument from the piece's own logic. If a candidate leans on such an appeal and you have no real fact to substitute, delete that claim.
4. STRUCTURE & READABILITY — the "summary" MUST be a single flowing descriptive PARAGRAPH (3–5 sentences, no bullets, no line breaks) with at least one verbatim quote; reformat any bulleted summary into a paragraph. The "whyBad" MUST be the numbered breakdown beginning at "1."; renumber a prose analysis and DROP any filler placeholder point (e.g. "5. No additional context"). STRIP any verification/audit metadata that leaked into whyBad (e.g. "Audit VERIFIED", "URL accessible (200)", "Content confirmed", "PDF accessible") — that belongs in verificationLog, never in the analysis. PLAIN TEXT ONLY — no markdown: no asterisk bold or italics, no backtick code spans, no hash headers. NO ALL-CAPS words or labels in the output: write labels in sentence case ("External Context:", "Conflict of interest:", "Timeliness note:"), never shouting capitals, and rewrite any all-caps emphasis already in a candidate into normal case (ordinary acronyms like the ADA, OSHA, the EPA are fine).
5. SEVERITY (calibrate honestly — do not inflate):
   - high: the piece actively dehumanizes a group, outright argues for stripping rights or lives, serves as explicit propaganda for extremist ideology, provides cover for documented atrocities, or disseminates disinformation as a calculated tool of harm;
   - medium: the piece sanitizes, rationalizes, or excuses regressive policy, exploitation, or cruelty through biased framing — it advances a harmful agenda or legitimizes an unjust status quo without rising to outright dehumanization or disinformation;
   - low: the piece takes a one-sided position that subtly minimizes, excuses, or sugarcoats harm, but has some genuine legal, economic, or good-faith basis; prefer "low" over omitting when the piece genuinely qualifies but is mild.

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
