import { homedir } from 'os';
import { join } from 'path';
import { 
  runResearch as piRunResearch, 
  shutdownManager,
  resetConfig,
} from '@lincoln504/pi-research';
import {
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from '@mariozechner/pi-coding-agent';
import { completeSimple } from '@mariozechner/pi-ai';
import type { RawFinding } from './findings.js';
import { safeParseJson } from './utils.js';

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'google/gemma-4-26b-a4b-it';

// ── Extraction prompt template ────────────────────────────────────────────────
// Sent to the LLM after /research completes so it can analyze results and
// produce structured JSON findings.

const EXTRACTION_PROMPT = `Now analyze the research results above and extract findings.

CRITICAL GROUNDING RULES:
1. FAITHFUL REPRESENTATION: You must summarize the article's actual core argument as the author intended it, without distortion or straw-man framing. Do not attribute arguments to the piece that it does not explicitly make.
2. NO HALLUCINATED CONTEXT: Do NOT bring in external statistics, Supreme Court cases, or legal precedents unless they are specifically mentioned in the article. If you need to provide counter-evidence, clearly label it as "Context/Counter-evidence" and do not imply it is in the article.
3. QUOTE REQUIREMENT: Every finding must include at least one direct, verbatim quote from the article.

Return ONLY a raw JSON object (no markdown, no code blocks, no preamble):
{
  "queries": ["the exact search strings you used during the /research phase"],
  "findings": [
    {
      "url": "https://...",
      "title": "exact article title as it appeared on the page",
      "domain": "example.com",
      "summary": "- Faithfully summarize the article's 3-5 core points in a hyphenated bulleted list.\n- State the author's primary intended conclusion neutrally.\n- NO judgment or critical framing here.",
      "category": "<CATEGORY_KEY>",
      "whyBad": "Analysis: [1. Quote a specific claim. 2. Provide a reasoned political or logical critique that directly addresses that claim or its underlying assumptions. 3. Identify the rhetorical technique (e.g. straw man, ecological fallacy). 4. If using external context (e.g. CBO data, Brennan Center), clearly label it as 'External Context' and explain how it invalidates the author's specific logic.]",
      "severity": "low|medium|high"
    }
  ]
}

Severity guide:
- high: makes specific false or manipulative claims likely to directly inform harmful policy or behavior
- medium: uses misleading framing or omission that distorts public understanding
- low: relies on dog-whistles or subtle bias without outright fabrication

CRITICAL PERSPECTIVE TEST — before including any entry, ask: does this piece itself advance a harmful or misleading argument, or is it merely reporting on / criticizing someone else's harmful argument? Include only the former.
A piece qualifies only if its own framing, argument, or omissions are the problem — not the subject it covers.

Be selective: only include genuinely harmful content. Empty findings array [] is valid if nothing qualifies. Max 8 entries. Each entry must be a specific article, op-ed, report, or blog post — not a homepage or category listing.`;

function buildExtractionPrompt(categoryKey: string): string {
  return EXTRACTION_PROMPT.replaceAll('<CATEGORY_KEY>', categoryKey);
}

export interface ResearchResult {
  findings: RawFinding[];
  queries: string[];
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run research for a category using the pi-research programmatic API.
 *
 * @param query        The research query (e.g. what articles to find, angles to explore)
 * @param categoryKey  The category key to embed in the extraction prompt
 * @param label        Human-readable label for logging
 * @param queryHistory Recently used queries to avoid
 * @param log          Logging function
 */
export async function runResearch(
  query: string,
  categoryKey: string,
  label: string,
  queryHistory: Record<string, string>,
  log: (msg: string) => void,
): Promise<ResearchResult> {
  // env flags consumed by pi-research
  process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] = '1';
  process.env['PI_RESEARCH_BROWSER_HEADLESS'] = 'true';
  process.env['PI_RESEARCH_VERBOSE'] = '0';
  process.env['PI_RESEARCH_RESEARCHER_TIMEOUT_MS'] = '600000'; // 10 minutes

  const agentDir = join(homedir(), '.pi', 'agent');
  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(agentDir);

  // Resolve the model from the registry
  const model = modelRegistry.find(OPENROUTER_PROVIDER, MODEL_ID);
  if (!model) {
    throw new Error(
      `Model ${OPENROUTER_PROVIDER}/${MODEL_ID} not found in registry.`
    );
  }
  log(`  [pi] using model: ${model.provider}/${model.id}`);

  // Calculate forbidden queries (used in the last 7 days)
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const forbiddenEntries = Object.entries(queryHistory || {})
    .filter(([_, lastAt]) => now - new Date(lastAt).getTime() < ONE_WEEK_MS)
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, 15);

  const forbidden = forbiddenEntries.map(([q, _]) => q);
  const avoidList = forbidden.length > 0
    ? `\n\nAVOID THESE EXACT QUERIES (searched within the last week):\n${forbidden.join('\n')}\nYou must use SIGNIFICANTLY DIFFERENT phrasing and explore new angles.`
    : '';

  const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const currentYear = new Date().getFullYear();

  const researchStrategy = `
SEARCH STRATEGY — Be an investigative researcher. Do NOT just use the seed concepts; use them to generate 10-15 highly varied and creative search queries:

1. VARY PHRASING: Use synonyms, industry jargon vs. academic terms, and loaded vs. neutral language.
2. VARY SOURCE TYPES: Target a mix of mainstream media (op-eds, commentary, major news outlets), niche ideological blogs, "alternative" news sites, and industry association PR.
3. VARY TIMEFRAMES: Include the current year (${currentYear}) or the previous year (${currentYear - 1}) in many queries.
4. VARY ANGLES: Explore different facets of the category.
5. CROSS-REFERENCE: Use findings from one search to inform the next.

PERSPECTIVE TEST — only flag a page if its own argument or framing is harmful.`;

  let researchQueryStr = `Research task (Current Date: ${currentDate}): ${query}${avoidList}\n\n${researchStrategy}`;

  const sessionId = `shame-${Date.now()}`;
  const researchId = `research-${categoryKey}-${Date.now()}`;

  const mockCtx: any = {
    cwd: process.cwd(),
    model,
    modelRegistry,
    settingsManager,
    ui: {
      notify: (msg: string) => log(`  [pi] ${msg}`),
      setStatus: (msg: string) => log(`  [pi] status: ${msg}`),
    }
  };

  try {
    log(`  [pi] starting research for: ${label}`);
    
    // Force a fresh config with our desired timeout for programmatic usage
    resetConfig();
    const config = {
        RESEARCHER_TIMEOUT_MS: 600000, // 10 minutes
        MAX_CONCURRENT_RESEARCHERS: 3,
        RESEARCHER_MAX_RETRIES: 3,
        RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
        DEFAULT_RESEARCH_DEPTH: 0,
        MAX_SCRAPE_BATCHES: 2,
        WORKER_THREADS: 4,
        TUI_REFRESH_DEBOUNCE_MS: 10,
        CONSOLE_RESTORE_DELAY_MS: 15000,
    };

    const researchReport = await piRunResearch({
      ctx: mockCtx,
      query: researchQueryStr,
      depth: 0, // Quick research for batch processing
      model,
      sessionId,
      researchId,
      config: config as any,
      observer: {
        onResearcherStart: (id, name) => log(`  [pi] researcher ${id} started: ${name}`),
        onResearcherProgress: (id, msg) => { if (msg) log(`  [pi] researcher ${id}: ${msg}`); },
        onSearchStart: (queries) => log(`  [pi] search burst: ${queries.length} queries`),
        onSearchProgress: (links) => log(`  [pi] search: ${links} links found so far`),
        onComplete: (synthesis) => log(`  [pi] research complete (${synthesis.length} chars)`),
        onError: (err) => log(`  [pi] research error: ${err.message}`),
      }
    });

    log(`  [pi] research complete (${researchReport.length} chars)`);
    
    // Debug: save the raw research report
    try {
      const reportsDir = join(DATA_DIR, 'reports');
      if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
      const reportFile = join(reportsDir, `${categoryKey}-${Date.now()}.md`);
      writeFileSync(reportFile, researchReport, 'utf-8');
      log(`  [debug] research report saved to: ${reportFile}`);
    } catch (err) {
      log(`  [warn] failed to save debug report: ${String(err)}`);
    }

    log(`  [pi] extracting findings...`);
    const extractionPrompt = buildExtractionPrompt(categoryKey);
    
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    // Merge into a single message for better model compatibility (Gemma especially)
    const combinedInput = `RESEARCH RESULTS:\n\n${researchReport}\n\n---\n\n${extractionPrompt}`;

    const extractionResult = await completeSimple(model, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: combinedInput }], timestamp: Date.now() }
      ]
    }, { apiKey: auth.apiKey, headers: auth.headers });

    const text = extractionResult.content.find((c): c is { type: 'text', text: string } => c.type === 'text')?.text || "";
    if (!text) {
        log('  [pi] extraction failed: empty response from model');
        return { findings: [], queries: [] };
    }

    let result: { findings: RawFinding[]; queries: string[] };
    try {
      result = safeParseJson<{ findings: RawFinding[]; queries: string[] }>(text);
    } catch (err) {
      log(`  [pi] FAILED to parse extraction JSON. Raw response length: ${text.length}`);
      // Attempt manual recovery of findings array if possible
      const findingsMatch = text.match(/"findings"\s*:\s*(\[[\s\S]*?\])/);
      if (findingsMatch && findingsMatch[1]) {
        try {
          const findings = safeParseJson<RawFinding[]>(findingsMatch[1]);
          log(`  [pi] recovered ${findings.length} findings from malformed JSON`);
          result = { findings, queries: [] };
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }

    return {
      findings: result.findings || [],
      queries: result.queries || [],
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Clean up pi-research resources (e.g. browser pool).
 */
export async function shutdownResearch() {
  await shutdownManager.runCleanup('agent shutdown');
}
