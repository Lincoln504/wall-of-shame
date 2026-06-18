import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  initResearchSDK,
  runQuickResearch,
  shutdownResearchSDK,
  type HeadlessObserverOptions,
} from '@lincoln504/pi-research';
import { Type } from 'typebox';
import type { RawFinding } from './findings.js';
import { DATA_DIR } from './findings.js';
import type { FindingsStore, RunState } from './types.js';
import { getLegacyLinks } from './legacy.js';
import { safeParseJson, safeParseValidatedJson } from './utils.js';
import { RESEARCH_MODEL_ID, OPENROUTER_PROVIDER, getOpenRouterModel, completeText, pickModelForContext } from './models.js';

// ── Model policy (see models.ts) ────────────────────────────────────────────────
//
// All-gemma three-stage pipeline (cheap enough to scale to thousands of entries):
//   1. RESEARCH   — gemma drives the pi-research SDK's multi-page synthesis. Big
//      scrapes are bounded by SDK config (MAX_SCRAPE_BATCHES + context-gating) so
//      the window is never overrun, rather than swapping in a larger model.
//   2. EXTRACTION — gemma turns the raw report into structured findings using
//      EXTRACTION_PROMPT (verbatim-or-none quote rule + the 4-part whyBad template
//      that produced ~150-word scathing analyses).
//   3. REVIEW     — gemma (reviewer.ts) scope-gates and sharpens each finding.

// ── Extraction schemas ────────────────────────────────────────────────────────

const RawFindingSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  domain: Type.Optional(Type.String()),
  summary: Type.String(),
  category: Type.String(),
  whyBad: Type.String(),
  severity: Type.Optional(Type.String()),
  directionalBasis: Type.Optional(Type.String()),
});

const ExtractionResultSchema = Type.Object({
  queries: Type.Array(Type.String()),
  findings: Type.Array(RawFindingSchema),
});

// ── Extraction prompt (golden-era quality bar) ─────────────────────────────────

const EXTRACTION_PROMPT = `Analyze the research results and extract findings for the Wall of Shame database.

CRITICAL GROUNDING & SYNTHESIS RULES:
1. ANALYTICAL SYNTHESIS: Synthesize the findings into a cohesive, analytical report. Every factual claim MUST be directly supported by a page scraped in this research session.
2. FAITHFUL REPRESENTATION: Summarize the article's actual core argument as the author intended it, without distortion.
3. NO HALLUCINATED CONTEXT, NO VAGUE AUTHORITIES — ARGUE FROM THE PIECE ITSELF: Do NOT invent specifics that are easily fabricated — no statute/section numbers (e.g. "18 U.S.C. § 611"), no specific case names, no precise statistics or percentages, no specific study titles or dates you are not certain of. JUST AS IMPORTANT: never support a point by gesturing at unnamed sources — do NOT write "multiple news outlets reported", "many experts agree", "studies show", "research finds", "researchers found", "critics note", "reports indicate", "it is widely reported", "observers say", or any similar appeal to an unnamed authority. Those read as invented and cannot be checked. Rebut a claim using ONLY (a) genuinely common public knowledge stated plainly as a fact in your own words ("the same tax cuts were tried before and the promised growth never arrived"), or (b) the piece's OWN internal logic and contradictions. You may name only extremely well-known institutions you are sure of (e.g. the ADA, OSHA, the Civil Rights Act, the EPA). When you cannot point to something real and well-established, say less — never manufacture a consensus or an attribution.
4. QUOTES — VERBATIM OR NONE: If the RESEARCH DATA contains text that is clearly a direct, word-for-word excerpt from the source article, you MAY copy it verbatim into the summary using quotation marks. If the research data paraphrases or summarizes the article rather than quoting it directly, do NOT put any text in quotation marks — write the claim as your own paraphrase without quotes. A summary with no quotation marks is acceptable and correct. A fabricated quote — any text placed inside quotation marks that is not copied exactly from the RESEARCH DATA — is a critical failure that disqualifies the entire entry immediately. When in doubt, paraphrase without quotes rather than guess. Every claim you make about an article must be supported by text that actually appears in the RESEARCH DATA; if the data does not contain it, do not assert it.
5. DIRECTIONAL GATE — THE MOST CRITICAL RULE. Before including any entry, answer: whose side is this piece ON? This database targets content that in any way props up, excuses, advances, legitimizes, launders, or defends harmful power — whether mildly (treating exploitation as natural or inevitable) or aggressively (actively arguing it is just and deserved). It does NOT target content that EXPOSES, CRITICIZES, DOCUMENTS, or REPORTS ON harm. These are fundamentally opposite things.

   INCLUDE — piece is complicit in, defending, or advancing harm in any of these ways:
   - Actively argues (outright advocacy): "billionaires earned their wealth," "police force was justified," "immigration is an invasion"
   - Normalizes (treats as natural/inevitable): presents inequality or exploitation as just how things work, "both sides" of a scientifically settled question, or frames resistance as naive
   - Sanitizes/launders (makes the harmful look reasonable): industry PR dressing up union-busting as "worker freedom," greenwashing fossil fuel companies, military euphemisms hiding civilian death tolls
   - Legitimizes by association (giving harmful ideas a platform and credibility they don't deserve): quoting a fringe "expert" to manufacture doubt about climate science, treating white nationalist talking points as legitimate policy debate
   - Serves as propaganda or cover: a think-tank brief that defends wage suppression as market economics, industry-funded "research" attacking safety regulation
   - A news outlet presenting anti-immigrant rhetoric as mainstream policy debate
   - A blog excusing monopoly power as "efficiency"

   DO NOT INCLUDE — these are ALLIES of accountability, not targets:
   - Jacobin / The Nation / DeSmog / InfluenceMap exposing corporate or government misconduct
   - The Guardian / AP / Reuters / NPR reporting on harmful rhetoric or policy (journalism is not advocacy)
   - A Harvard or academic study documenting how fossil fuel companies obstruct climate action
   - A progressive op-ed ARGUING that billionaires are exploiters (that argues FOR accountability)
   - An article ANALYZING military euphemisms to expose how they hide civilian deaths
   - An investigative piece exposing the revolving door between Pentagon and defense contractors
   - A Substack CRITICIZING inequality or wealth concentration
   - ANY university, policy center, or research institution report that DOCUMENTS problems with a policy (Georgetown, Brookings, Pew, RAND, etc. — if the report concludes the policy is harmful, it is a CRITIC of harm, not a defender)
   - ANY journalism that REVEALS, EXPOSES, or DOCUMENTS a harm, even if the subject matter matches a category exactly

   THE CONCLUSION TEST — the single most reliable filter: What does this piece CONCLUDE? If its conclusion is "this policy/practice is bad, harmful, unjust, or should change" → OMIT IT (it is criticism). If its conclusion is "this policy/practice is good, natural, necessary, or justified" → INCLUDE IT (it normalizes harm). A research report finding that school vouchers mainly benefit the already-wealthy CONCLUDES that vouchers are a bad deal — it is a critic, not a defender. An op-ed arguing that vouchers empower parental choice CONCLUDES vouchers are good — it is a defender.

   CRITICAL FAILURE MODE TO AVOID: Do NOT include a piece just because its SUBJECT MATTER overlaps with a category. A piece ABOUT school vouchers funding religious schools is not automatically in the Wall of Shame — only include it if the piece ARGUES that vouchers are good. A piece ABOUT police violence is not automatically in scope — only include it if the piece ARGUES that police violence is justified. Subject ≠ stance. The confusion is this: you are looking for pieces that PERFORM the harm, not pieces that WITNESS or DOCUMENT it.

   THE TEST: Ask "what does this piece want readers to believe?" If the answer makes the world more just, more accountable, or more aware of exploitation — OMIT IT. If the answer makes exploitation seem normal, natural, or deserved — INCLUDE IT. When in doubt, ask: would the editors of the New York Times op-ed page or Heritage Foundation be COMFORTABLE with this piece? If yes, it may qualify. Would DeSmog or Jacobin be comfortable running it? If yes, almost certainly do not include it.

WHYBAD QUALITY BAR (this is the heart of the entry — make it scathing and rigorous):
The whyBad field must be a comprehensive, multi-layered analysis of AT LEAST 150 words (aim for 180–280), written as an explicitly NUMBERED breakdown. Begin the text directly with "1." — do NOT prepend an "Analysis:" label and do NOT wrap the whole thing in square brackets (the site adds its own "Analysis:" heading). Write ONLY as many numbered points as you have REAL substance for — normally 3 to 5. Points 1–3 are required; cover, in order:
  1. Cite a specific claim from the piece. If the RESEARCH DATA contains the exact wording as a direct excerpt, put it in quotation marks. If the research data only paraphrases it, describe the claim in your own words WITHOUT quotation marks. Never fabricate quoted text.
  2. Name the manipulation tactic in EVERYDAY words and explain what it means in the SAME sentence, so a reader who has never heard the term still understands. Describe the move plainly (e.g. "presents only two options when others exist", "stirs fear of an exaggerated threat", "quotes a sympathetic example to distract from the policy's real victims", "treats an outcome as inevitable to discourage resistance"). Do NOT drop a coined or academic label on its own (no bare "sympathetic-victim gambit", "race-to-the-bottom fallacy", "historical determinism"); if you use any such term, immediately define it in plain language.
  3. Explain concretely what this piece does to harm — pick from the full range: does it sanitize (make the harmful look clean), launder (make the harmful look respectable), justify (make the harmful look earned or necessary), excuse (make the harmful look unavoidable), normalize (make the harmful look like the natural order), minimize (make the harmful look trivial), propagandize (mislead people on behalf of power), or actively advocate (champion the harmful as good)? Name the specific mechanism and its real-world consequence.
  4. OPTIONAL — include ONLY if you genuinely have a real, well-established rebutting fact: a sentence beginning "External Context:" stating it plainly in your own words and in general terms (no fabricated statute numbers, case names, exact statistics, or study titles, and NO vague "studies show" / "experts say" / "multiple outlets" appeals). If you have no such concrete fact, OMIT this point entirely.
  5. OPTIONAL — include ONLY where it genuinely applies: a sentence beginning "Conflict of interest:" naming the author's/publisher's funding or institutional stake, and/or a sentence beginning "Timeliness note:" if a prediction has aged poorly.
NEVER pad to a fixed number of points, and NEVER write a filler placeholder point such as "5. No additional context", "None", "N/A", or "Not applicable" — simply end at your last point of real substance.

DEPTH DISCIPLINE — DO NOT OVERSIMPLIFY. A two- or three-sentence analysis is a FAILURE. Match the rigor of a sharp investigative analyst: name multiple distinct fallacies where present, supply concrete external facts where they genuinely exist, and name conflicts of interest where they are real. Never collapse the analysis into a single generic observation.

SUMMARY FORMAT (be consistent): the "summary" MUST be a single flowing descriptive PARAGRAPH (3–5 sentences) in plain language describing what the piece argues and its intended conclusion. Do NOT use "- " bullets, numbering, or line breaks in the summary — it is one paragraph. (Only the "whyBad" analysis is a numbered list.) A summary with no quotation marks is acceptable and correct. Only include a verbatim quote if the RESEARCH DATA contains the exact wording as a direct excerpt — do not add quotes to satisfy a formatting rule.

OUTPUT READABILITY (WRITE FOR A LAYMAN):
The "summary" and "whyBad" fields must be plain, clear English a common person understands on first read. Identify the issues with analytical depth, then translate into simple, hard-hitting language. Avoid academic jargon, rhetoric/debate terminology, and empty buzzwords. If a precise technical or legal term is genuinely needed, EXPLAIN it in plain words in the same sentence the first time it appears — never leave the reader to look it up. Write PLAIN TEXT ONLY — no markdown formatting whatsoever: no asterisk bold or italics, no backtick code spans, no hash headers. Emphasize with word choice, not symbols. NO ALL-CAPS words or labels in the output — it reads as shouting. Write labels in sentence case ("External Context:", "Conflict of interest:", "Timeliness note:"), never in capitals. (Ordinary acronyms you are sure of — the ADA, OSHA, the EPA — are fine.)

RETURN ONLY A RAW JSON OBJECT:
{
  "queries": ["the exact search queries used during research"],
  "findings": [
    {
      "url": "https://...",
      "title": "Exact Title",
      "domain": "example.com",
      "summary": "A flowing 3-5 sentence paragraph in plain language describing the piece and its intended conclusion. Include a verbatim quote ONLY if the RESEARCH DATA contains the exact wording as a direct excerpt from the source — otherwise paraphrase without quotes. Never fabricate a quoted string. Not a list.",
      "category": "<CATEGORY_KEY>",
      "directionalBasis": "One sentence: what does this piece CONCLUDE that makes it a bad actor? E.g. 'Concludes that billionaire wealth is earned and deserved, not extracted.' or 'Concludes that immigration is an invasion threatening public safety.' If you cannot write this sentence, the piece fails the Conclusion Test and must be omitted.",
      "whyBad": "1. Cite a specific claim from the piece; quote verbatim ONLY if the exact wording appears in the RESEARCH DATA as a direct excerpt — otherwise describe in your own words without quotes. 2. Name the manipulation tactic in plain words and explain it in the same sentence. 3. Explain the concrete real-world harm it normalizes. (Then OPTIONALLY: 4. External Context: a real rebutting fact in your own words, no unnamed-authority appeals — omit if you have none. 5. Conflict of interest / Timeliness note where it genuinely applies.) End at your last real point — never pad or write 'No additional context'. (>=150 words, scathing, evidence-grounded, layman-readable; no 'Analysis:' label, no surrounding brackets)",
      "severity": "low|medium|high"
    }
  ]
}

SEVERITY RUBRIC (calibrate honestly — do not inflate):
- high: the piece actively dehumanizes a group, argues for stripping rights or lives, promotes or launders outright disinformation, serves as explicit propaganda for extremist ideology, or provides direct cover for atrocities.
- medium: the piece sanitizes, rationalizes, or excuses regressive policy or economic exploitation through biased framing — stops short of dehumanization or disinformation, but meaningfully advances a harmful agenda or normalizes an unjust status quo.
- low: the piece takes a contestable or one-sided position with some genuine legal, economic, or good-faith grounding, where the framing subtly tilts toward excusing or minimizing harm. Prefer "low" over omitting when the piece is real but mild.

Severity scale: low | medium | high ONLY. If no articles qualify, return {"queries": [...], "findings": []}. Max 8 entries.`;

function buildExtractionPrompt(categoryKey: string): string {
  return EXTRACTION_PROMPT.replaceAll('<CATEGORY_KEY>', categoryKey);
}

export interface ResearchResult {
  findings: RawFinding[];
  queries: string[];
  rawReport?: string;
}

// ── SDK lifecycle ───────────────────────────────────────────────────────────

let isSDKInitialized = false;

/**
 * Initialize the Pi Research SDK for Wall of Shame.
 *
 * The knowledge store is explicitly disabled (KNOWLEDGE_STORE_MODE: 'none') —
 * Wall of Shame is a stateless re-discovery pipeline that keeps its own dedup
 * state in run-state.json, so no vector store is wanted. These config overrides
 * are forwarded to every downstream service by the SDK (initResearchSDK ->
 * runDeepResearch -> runResearch).
 */
export async function initializeResearch(log: (msg: string) => void) {
  if (isSDKInitialized) return;

  // Verbose SDK debug logging is OPT-IN (WOS_PI_DEBUG=1) and OFF by default.
  // It was previously forced on, streaming INFO+DEBUG to /tmp/pi-research.log — but
  // /tmp is tmpfs (RAM) on this host, so during a sustained high-concurrency loop
  // that log grew in RAM and helped push the machine into a memory-pressure freeze.
  // Keep it off for scaling; enable it only when actively diagnosing the SDK.
  const debug = process.env['WOS_PI_DEBUG'] === '1';
  if (debug) {
    process.env['PI_RESEARCH_DEBUG'] = 'true';
    log(`  [pi] SDK debug logging ON → ${join(tmpdir(), 'pi-research.log')} (WOS_PI_DEBUG=1)`);
  }

  log('  [pi] initializing research SDK (gemma research + Qwen3.6-35B-A3B extraction/review, knowledge_store=none)...');

  await initResearchSDK({
    model: `${OPENROUTER_PROVIDER}/${RESEARCH_MODEL_ID}`,
    cwd: process.cwd(),
    config: {
      // No knowledge/vector store — Wall of Shame manages its own dedup state.
      KNOWLEDGE_STORE_MODE: 'none',
      // Aggressive, thorough scraping for hard-hitting source discovery.
      MAX_SCRAPE_BATCHES: 4,
      // Generous per-researcher budget (config range is 180000–1800000 ms).
      RESEARCHER_TIMEOUT_MS: 900000,
      DEBUG: debug,
    },
    verbose: debug,
  });

  isSDKInitialized = true;
}

/**
 * Shutdown the Pi Research SDK and release all background resources.
 */
export async function shutdownResearch() {
  if (!isSDKInitialized) return;
  await shutdownResearchSDK();
  isSDKInitialized = false;
}

// ── Extraction (gemma — small context, cheap), resolved once and cached ─────────

/**
 * Turn a raw research report into structured findings using the golden
 * EXTRACTION_PROMPT. Returns [] (and leaves rawReport as a fallback) on failure.
 */
async function extractFindings(
  categoryKey: string,
  researchReport: string,
  log: (msg: string) => void,
): Promise<{ findings: RawFinding[]; queries: string[] }> {
  // Context-aware routing: a normal research report is snippet-sized → the Qwen3.6-35B-A3B
  // workhorse; an unusually large report escalates to DeepSeek V4 Pro's 1M window (models.ts).
  const modelId = pickModelForContext(researchReport);
  const model = await getOpenRouterModel(modelId, { reasoning: false });

  // NON-THINKING (instruct) mode (per project direction): Qwen3.6-35B-A3B runs with thinking
  // disabled — fastest path, and the detailed extraction prompt carries the analytical depth
  // on its own. Sampling follows Qwen's OFFICIAL instruct-mode profile (temp 0.7, top_p 0.80,
  // top_k 20, min_p 0, presence_penalty 1.5); the vendor specifically warns against very-low
  // temperature in this family (repetition/quality loss), so we use 0.7, not 0.3. json mode
  // is on, with completeText's automatic no-response_format fallback.
  log(`  [pi] extracting structured findings (${modelId}, non-thinking)...`);
  const text = await completeText(
    model,
    buildExtractionPrompt(categoryKey),
    `RESEARCH DATA:\n\n${researchReport}`,
    { reasoning: false, temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, json: true },
  );

  if (!text) {
    log('  [pi] extraction returned empty response');
    return { findings: [], queries: [] };
  }

  try {
    const result = safeParseValidatedJson(ExtractionResultSchema, text);
    log(`  [pi] extracted ${result.findings.length} candidate findings`);
    return { findings: result.findings as RawFinding[], queries: result.queries };
  } catch (err) {
    log(`  [pi] extraction JSON validation failed: ${String(err).slice(0, 120)}`);
    // Save the failed response for debugging.
    try {
      const failureDir = join(DATA_DIR, 'failures');
      if (!existsSync(failureDir)) mkdirSync(failureDir, { recursive: true });
      writeFileSync(join(failureDir, `extraction-failure-${categoryKey}-${Date.now()}.txt`), text, 'utf-8');
    } catch { /* best effort */ }
    // Best-effort recovery of just the findings array.
    const m = text.match(/"findings"\s*:\s*(\[[\s\S]*?\])/);
    if (m && m[1]) {
      try {
        const findings = safeParseJson<RawFinding[]>(m[1]);
        log(`  [pi] recovered ${findings.length} findings from malformed JSON`);
        return { findings, queries: [] };
      } catch { /* fall through */ }
    }
    return { findings: [], queries: [] };
  }
}

// ── Research Execution ────────────────────────────────────────────────────────

/**
 * Run research + extraction for a category. Returns structured findings (golden
 * quality) for the reviewer to verify; rawReport is kept as a fallback.
 */
export async function runResearch(
  query: string,
  categoryKey: string,
  label: string,
  queryHistory: Record<string, string>,
  _findingsStore: FindingsStore,
  _runState: RunState,
  log: (msg: string) => void,
): Promise<ResearchResult> {
  await initializeResearch(log);

  // 1. Get legacy links for this category to seed research
  const legacyLinks = getLegacyLinks(categoryKey);
  if (legacyLinks.length > 0) {
    log(`  [pi] found ${legacyLinks.length} legacy links for category: ${categoryKey}`);
  }

  // Calculate forbidden queries (used in the last 7 days)
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const forbiddenEntries = Object.entries(queryHistory || {})
    .filter(([_, lastAt]) => now - new Date(lastAt).getTime() < ONE_WEEK_MS)
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, 15);

  const forbidden = forbiddenEntries.map(([q, _]) => q);
  const avoidList = forbidden.length > 0
    ? `\n\nAVOID THESE EXACT QUERIES (searched within the last week):\n${forbidden.join('\n')}\nYou must use DIFFERENT phrasing and explore new angles.`
    : '';

  const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const researchStrategy = `
SEARCH STRATEGY — Be an investigative researcher focusing on how issues are framed:

1. TARGETED EVIDENCE: Queries must be specific and designed to surface high-quality results. Prioritize queries that lead to primary sources and technical documentation.
2. DESCRIPTIVE PHRASING: Look for how people justify or hide issues (e.g., "blaming workers," "ignoring risks," "pretending it's free"). Use exact terms, dates, names, and events.
3. VARY SOURCE TYPES: Target a mix of mainstream media op-eds, niche blogs, and industry PR where specific viewpoints are strongest.
4. VARY TIMEFRAMES: Include relevant years to see how arguments have changed over time.
5. FOCUS ON INTENT: Explore the goal behind how a piece is written and what effect it tries to have on the reader. Focus on analytical synthesis rather than simple fact-dumping.
6. CROSS-REFERENCE: Use findings from one search to spot similar patterns in others.

DIRECTIONAL GATE — This is the most important filter. You are looking for content that in any way props up, defends, sanitizes, launders, rationalizes, or normalizes harmful power — NOT content that EXPOSES, CRITICIZES, DOCUMENTS, or REPORTS ON it. Ask: whose side is this piece on, and what does it do to harm?

TARGET — pieces that are complicit in harm, across the full spectrum (the Wall of Shame):
- Outright advocacy: op-eds arguing immigrants are criminals, editorials defending police brutality, manifestos that union-busting protects workers
- Sanitizing and laundering: industry PR greenwashing fossil fuel companies, think-tank briefs dressing up exploitation as economics, military euphemisms hiding civilian casualties
- Normalizing: articles that treat inequality as natural, frame austerity as inevitable, or present rights rollbacks as common sense
- Rationalizing and excusing: content that explains away discrimination as policy, defends denied healthcare as "cost control," excuses surveillance as necessary trade-offs
- Legitimizing fringe harm: giving extremist, racist, or anti-democratic positions a mainstream platform and credibility they don't deserve
- Propagandizing for power: corporate PR posing as news, advocacy dressed as neutral analysis, "research" funded to attack public protections

DO NOT TARGET — pieces that hold power to account (these are allies, not targets):
- Journalism REPORTING on harmful rhetoric or events (Guardian, AP, NPR, Reuters — they cover the harm, they don't advance it)
- Investigative journalism EXPOSING corporate wrongdoing (Jacobin, DeSmog, InfluenceMap, The Nation)
- Academic research DOCUMENTING how bad actors obstruct climate, labor, or democracy
- Policy reports CONCLUDING that a policy is harmful, unjust, or should change (Georgetown, Brookings, Pew, RAND, academic journals)
- Progressive op-eds ARGUING AGAINST oligarchy, racism, exploitation, or abuse of power
- Articles that ANALYZE or EXPOSE manipulative language, framing, or propaganda techniques

The confusion to avoid: an article ABOUT harmful rhetoric is not itself harmful rhetoric. An article ABOUT greenwashing is not itself greenwashing. An article ABOUT billionaire exploitation is not itself defending exploitation. Before flagging any page, confirm that the page's own argument — not just its subject matter — is the problem.

THE CONCLUSION TEST: What does this piece CONCLUDE? If it concludes "this is bad, harmful, unjust, or should change" → it is an ally, OMIT IT. If it concludes "this is good, natural, necessary, or deserved" → it normalizes harm, INCLUDE IT. A Georgetown policy report finding that vouchers mainly benefit the already-wealthy CONCLUDES vouchers are a problem; do not include it. An industry brief arguing vouchers expand parental freedom CONCLUDES vouchers are good; include it.

ALSO: Any university, think-tank-for-accountability, or policy research report (Georgetown, Brookings, Pew, RAND, academic journals) that DOCUMENTS problems with a policy is NOT a target — those are critics of harm. Only include think-tank reports where the think tank is DEFENDING power (e.g., Heritage Foundation, Cato, AEI arguing against regulation, for privatization, for union-busting).`;

  const researchQueryStr = `Research task (Current Date: ${currentDate}): ${query}${avoidList}\n\n${researchStrategy}`;

  let researchReport = '';
  const capturedQueries: string[] = [];
  try {
    log(`  [pi] starting research for: ${label}`);

    const observer: HeadlessObserverOptions = {
      onProgress: (event, data) => {
        if (event === 'researcher_start') log(`  [pi] researcher ${data?.id} started: ${data?.name}`);
        else if (event === 'researcher_progress' && data?.status) log(`  [pi] researcher ${data.id}: ${data.status}`);
        else if (event === 'search_start') {
          log(`  [pi] search burst: ${data?.queries?.length ?? 0} queries`);
          if (data?.queries) capturedQueries.push(...data.queries);
        }
        else if (event === 'search_progress') log(`  [pi] search: ${data?.resultsCount ?? 0} links found so far`);
        else if (event === 'complete') log(`  [pi] research complete (${(data?.result ?? '').length} chars)`);
        else if (event === 'error') log(`  [pi] research error: ${data?.message}`);
      },
    };

    researchReport = await runQuickResearch(researchQueryStr, {
      observer,
      // Pass historical links as seeds for research
      initialLinks: legacyLinks,
    });
  } catch (err) {
    log(`  [pi] CRITICAL ENGINE ERROR: ${String(err)}`);
    throw err;
  }

  log(`  [pi] research phase finished, extracting findings...`);

  // Save the raw research report for debugging
  try {
    const reportsDir = join(DATA_DIR, 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    const reportFile = join(reportsDir, `${categoryKey}-${Date.now()}.md`);
    writeFileSync(reportFile, researchReport, 'utf-8');
    log(`  [debug] research report saved to: ${reportFile}`);
  } catch (err) {
    log(`  [warn] failed to save debug report: ${String(err)}`);
  }

  if (!researchReport.trim()) {
    return { findings: [], queries: capturedQueries, rawReport: researchReport };
  }

  // 2. EXTRACTION — structured, golden-quality findings from the raw report.
  let extracted: { findings: RawFinding[]; queries: string[] } = { findings: [], queries: [] };
  try {
    extracted = await extractFindings(categoryKey, researchReport, log);
  } catch (err) {
    log(`  [pi] extraction step failed, falling back to raw report: ${String(err).slice(0, 120)}`);
  }

  const queries = [...new Set([...capturedQueries, ...extracted.queries])];
  // If extraction yielded findings, the reviewer audits those; otherwise it
  // extracts from the raw report itself (fallback path).
  return { findings: extracted.findings, queries, rawReport: researchReport };
}
