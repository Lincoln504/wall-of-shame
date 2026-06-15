import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
  initResearchSDK,
  runQuickResearch,
  shutdownResearchSDK,
  type HeadlessObserverOptions,
} from '@lincoln504/pi-research';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { completeSimple } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { RawFinding } from './findings.js';
import { DATA_DIR } from './findings.js';
import type { FindingsStore, RunState } from './types.js';
import { getLegacyLinks } from './legacy.js';
import { safeParseJson, safeParseValidatedJson } from './utils.js';

// ── Model config ──────────────────────────────────────────────────────────────
//
// Quality pipeline (restored to the "golden era" 85-entry standard):
//   1. RESEARCH   — a strong model (deepseek) drives the pi-research SDK's
//      multi-source synthesis. Small models produced shallow reports; the golden
//      corpus used deepseek for the heavy analytical lifting.
//   2. EXTRACTION — the same strong model turns the raw report into structured
//      findings using EXTRACTION_PROMPT (verbatim-quote requirement + the 4-part
//      whyBad template that produced ~150-word scathing analyses).
//   3. REVIEW     — gemma (reviewer.ts) adversarially verifies/refines each
//      finding with reasoning on.

const OPENROUTER_PROVIDER = 'openrouter';
// Research + extraction model — strong frontier model (golden-era choice).
const RESEARCH_MODEL_ID = 'deepseek/deepseek-v4-flash';

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
3. NO HALLUCINATED CONTEXT: Do NOT invent external statistics or legal precedents. You MAY cite well-established public context to rebut a claim, but never fabricate facts or attribute claims without evidence.
4. QUOTE REQUIREMENT: Every finding MUST include at least one direct, verbatim quote (in the summary) showing the article's primary argument or how it frames the issue.
5. SELECTIVITY: Only include content where the piece itself acts to NORMALIZE, JUSTIFY, or HIDE the harm of regressive policies — op-eds, "alternative" news, think-tank reports, and industry PR that use biased framing. OMIT neutral, fact-based reporting.

WHYBAD QUALITY BAR (this is the heart of the entry — make it scathing and rigorous):
The whyBad field must be a comprehensive, multi-layered analysis of AT LEAST 120 words, written as a numbered breakdown:
  1. Cite a specific claim or verbatim quote from the piece.
  2. Name the precise rhetorical/framing technique or logical fallacy in plain English (e.g. "race-to-the-top fallacy", "sympathetic-victim gambit", "manufactured doubt", "cherry-picking", "historical determinism").
  3. Explain concretely how this normalizes, justifies, or hides real-world harm.
  4. Supply external rebutting context where well-established (studies, law, outcomes) and flag any conflict of interest or funding (e.g. "the author is a trade-group vendor for the very thing it defends") and any timeliness problem (predictions that aged poorly).

OUTPUT READABILITY:
The "summary" and "whyBad" fields must be plain, clear English a common person understands. Identify the issues with analytical depth, then translate into simple, hard-hitting language. No academic jargon or empty buzzwords.

RETURN ONLY A RAW JSON OBJECT:
{
  "queries": ["the exact search queries used during research"],
  "findings": [
    {
      "url": "https://...",
      "title": "Exact Title",
      "domain": "example.com",
      "summary": "- 3-5 main points in simple language, including at least one verbatim quote.\\n- The author's intended conclusion, stated neutrally.",
      "category": "<CATEGORY_KEY>",
      "whyBad": "1. ... 2. ... 3. ... 4. ... (>=120 words, scathing, evidence-grounded)",
      "severity": "low|medium|high"
    }
  ]
}

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

  log('  [pi] initializing research SDK (deepseek research, knowledge_store=none)...');

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
    },
    verbose: false,
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

// ── Extraction model (deepseek), resolved once and cached ───────────────────────

let cachedExtractionModel: { model: any; apiKey?: string; headers?: Record<string, string> } | null = null;

async function getExtractionModel() {
  if (cachedExtractionModel) return cachedExtractionModel;
  const agentDir = join(homedir(), '.pi', 'agent');
  const registry = ModelRegistry.create(AuthStorage.create(join(agentDir, 'auth.json')));
  const model = registry.find(OPENROUTER_PROVIDER, RESEARCH_MODEL_ID);
  if (!model) throw new Error(`Extraction model ${OPENROUTER_PROVIDER}/${RESEARCH_MODEL_ID} not found in registry.`);
  // Extraction is a direct, non-thinking synthesis call (golden behavior).
  (model as any).reasoning = false;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Extraction model auth failed: ${auth.error}`);
  cachedExtractionModel = { model, apiKey: auth.apiKey, headers: auth.headers };
  return cachedExtractionModel;
}

/**
 * Turn a raw research report into structured findings using the golden
 * EXTRACTION_PROMPT. Returns [] (and leaves rawReport as a fallback) on failure.
 */
async function extractFindings(
  categoryKey: string,
  researchReport: string,
  log: (msg: string) => void,
): Promise<{ findings: RawFinding[]; queries: string[] }> {
  const { model, apiKey, headers } = await getExtractionModel();

  log(`  [pi] extracting structured findings (deepseek)...`);
  const extraction = await completeSimple(model, {
    systemPrompt: buildExtractionPrompt(categoryKey),
    messages: [
      { role: 'user', content: [{ type: 'text', text: `RESEARCH DATA:\n\n${researchReport}` }], timestamp: Date.now() },
    ],
  }, {
    apiKey,
    headers,
    onPayload: (payload: any) => {
      delete payload.reasoning;
      delete payload.thinking;
      payload.include_reasoning = false;
      return payload;
    },
  });

  const text = extraction.content.find((c: any): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';
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
