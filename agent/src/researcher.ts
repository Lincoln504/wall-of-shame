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
import { RESEARCH_MODEL_ID, GEMMA_MODEL_ID, OPENROUTER_PROVIDER, getOpenRouterModel, completeText } from './models.js';

// ── Model policy (see models.ts) ────────────────────────────────────────────────
//
// All-gemma three-stage pipeline (cheap enough to scale to thousands of entries):
//   1. RESEARCH   — gemma drives the pi-research SDK's multi-page synthesis. Big
//      scrapes are bounded by SDK config (MAX_SCRAPE_BATCHES + context-gating) so
//      the window is never overrun, rather than swapping in a larger model.
//   2. EXTRACTION — gemma turns the raw report into structured findings using
//      EXTRACTION_PROMPT (verbatim-quote requirement + the 4-part whyBad template
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
3. NO HALLUCINATED CONTEXT — STATE FACTS GENERALLY: You MAY cite well-established public context to rebut a claim, but do NOT invent or cite OVERLY SPECIFIC identifiers that are easily fabricated — no statute/section numbers (e.g. "18 U.S.C. § 611"), no specific case names, no precise statistics or percentages, no specific study titles or dates you are not certain of. Instead, assert that such laws/research/agencies/outcomes exist in GENERAL terms ("long-standing federal law already criminalizes this"; "extensive peer-reviewed research finds the opposite"; "the agency's own data contradicts this"). You may name only extremely well-known institutions you are sure of (e.g. the ADA, OSHA, the Civil Rights Act, the EPA). When unsure of a specific, argue from the piece's own logic instead.
4. QUOTE REQUIREMENT — ANCHOR IN THE RESEARCH DATA: Every finding MUST include at least one direct, verbatim quote (in the summary) showing the article's primary argument. That quote MUST be copied WORD-FOR-WORD from the RESEARCH DATA provided in the user message — never paraphrase it into quotation marks and never invent a quote. Every claim you make about an article must be supported by text that actually appears in the RESEARCH DATA; if the data does not contain it, do not assert it.
5. SELECTIVITY: Only include content where the piece itself acts to NORMALIZE, JUSTIFY, or HIDE the harm of regressive policies — op-eds, "alternative" news, think-tank reports, and industry PR that use biased framing. OMIT neutral, fact-based reporting.

WHYBAD QUALITY BAR (this is the heart of the entry — make it scathing and rigorous):
The whyBad field must be a comprehensive, multi-layered analysis of AT LEAST 150 words (aim for 180–280), written as an explicitly NUMBERED breakdown. Begin the text directly with "1." — do NOT prepend an "Analysis:" label and do NOT wrap the whole thing in square brackets (the site adds its own "Analysis:" heading). Cover, in order:
  1. Cite a specific claim or verbatim quote from the piece (use quotation marks).
  2. Name the manipulation tactic in EVERYDAY words and explain what it means in the SAME sentence, so a reader who has never heard the term still understands. Describe the move plainly (e.g. "presents only two options when others exist", "stirs fear of an exaggerated threat", "quotes a sympathetic example to distract from the policy's real victims", "treats an outcome as inevitable to discourage resistance"). Do NOT drop a coined or academic label on its own (no bare "sympathetic-victim gambit", "race-to-the-bottom fallacy", "historical determinism"); if you use any such term, immediately define it in plain language.
  3. Explain concretely how this normalizes, justifies, or hides real-world harm.
  4. Add a sentence that BEGINS with "External Context:" supplying well-established rebutting facts stated in GENERAL terms (NOT fabricated statute numbers, case names, exact statistics, or specific study titles — assert the well-known fact, not a precise citation you might be inventing).
  5. Where applicable, add a sentence beginning "CONFLICT OF INTEREST:" naming the author's/publisher's funding or institutional stake, and/or a sentence beginning "TIMELINESS NOTE:" if a prediction has aged poorly.

DEPTH DISCIPLINE — DO NOT OVERSIMPLIFY. A two- or three-sentence summary is a FAILURE. Match the rigor of a sharp investigative analyst: multiple distinct fallacies where present, concrete external facts, and named conflicts of interest. Never collapse the analysis into a single generic observation.

SUMMARY FORMAT (be consistent): the "summary" MUST be a single flowing descriptive PARAGRAPH (3–5 sentences) in plain language describing what the piece argues and its intended conclusion, and MUST include at least one verbatim quote (in quotation marks). Do NOT use "- " bullets, numbering, or line breaks in the summary — it is one paragraph. (Only the "whyBad" analysis is a numbered list.)

OUTPUT READABILITY (WRITE FOR A LAYMAN):
The "summary" and "whyBad" fields must be plain, clear English a common person understands on first read. Identify the issues with analytical depth, then translate into simple, hard-hitting language. Avoid academic jargon, rhetoric/debate terminology, and empty buzzwords. If a precise technical or legal term is genuinely needed, EXPLAIN it in plain words in the same sentence the first time it appears — never leave the reader to look it up. Write PLAIN TEXT ONLY — no markdown formatting whatsoever: no asterisk bold or italics, no backtick code spans, no hash headers. Emphasize with word choice, not symbols.

RETURN ONLY A RAW JSON OBJECT:
{
  "queries": ["the exact search queries used during research"],
  "findings": [
    {
      "url": "https://...",
      "title": "Exact Title",
      "domain": "example.com",
      "summary": "A flowing 3-5 sentence paragraph in plain language describing the piece and its intended conclusion, including at least one verbatim quote in quotation marks. Not a list.",
      "category": "<CATEGORY_KEY>",
      "whyBad": "1. Cite a verbatim quote. 2. Name the manipulation tactic in plain words and explain it in the same sentence. 3. Explain the concrete real-world harm it normalizes. 4. External Context: well-established rebutting facts stated generally (no fabricated statute numbers, case names, exact stats, or study titles/dates). 5. CONFLICT OF INTEREST: funding/institutional stake, and/or TIMELINESS NOTE: aged-poorly prediction. (>=150 words, scathing, evidence-grounded, layman-readable; no 'Analysis:' label, no surrounding brackets)",
      "severity": "low|medium|high"
    }
  ]
}

SEVERITY RUBRIC (calibrate honestly — do not inflate):
- high: actively dehumanizes a group, justifies stripping rights/safety/lives, promotes disinformation, or launders extremist ideology into the mainstream.
- medium: normalizes a regressive policy or economic harm through biased framing, but stops short of dehumanization or outright disinformation.
- low: a contestable position with genuine legal/constitutional or good-faith grounding, where the framing is still one-sided enough to qualify. Prefer "low" over omitting when the piece is real but mild.

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

  log('  [pi] initializing research SDK (all-gemma pipeline, knowledge_store=none)...');

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
  const model = await getOpenRouterModel(GEMMA_MODEL_ID, { reasoning: true });

  log(`  [pi] extracting structured findings (gemma, medium reasoning)...`);
  const text = await completeText(
    model,
    buildExtractionPrompt(categoryKey),
    `RESEARCH DATA:\n\n${researchReport}`,
    { reasoning: 'medium', temperature: 0.3, topP: 0.9, json: true },
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

PERSPECTIVE TEST — Look for content where the piece's net effect is to make harmful outcomes seem normal or acceptable within the category.`;

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
