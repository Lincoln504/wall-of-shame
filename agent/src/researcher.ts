import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
import { Type } from 'typebox';
import type { RawFinding } from './findings.js';
import { DATA_DIR } from './findings.js';
import { safeParseJson, safeParseValidatedJson } from './utils.js';

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'deepseek/deepseek-v4-flash';

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

// ── Extraction prompt template ────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Analyze the research results and extract findings for the "Wall of Shame."

CRITICAL GROUNDING RULES:
1. FAITHFUL REPRESENTATION: Summarize the article's actual core argument as the author intended it, without distortion.
2. NO HALLUCINATED CONTEXT: Do NOT bring in external statistics or legal precedents unless they are explicitly mentioned in the article.
3. QUOTE REQUIREMENT: Every finding must include at least one direct, verbatim quote from the article.
4. SELECTIVITY: Only include pieces where the author ADVOCATES for or NORMALIZES harmful policy/ideology. Omit neutral reporting.

RETURN ONLY A RAW JSON OBJECT:
{
  "queries": ["Extract the exact search queries used during research"],
  "findings": [
    {
      "url": "https://...",
      "title": "Exact Title",
      "domain": "...",
      "summary": "- Neutrally summarize 3-5 core points.\n- State intended conclusion neutrally.",
      "category": "<CATEGORY_KEY>",
      "whyBad": "Analysis: [1. Quote a specific claim. 2. Provide a reasoned political/logical critique of that claim. 3. Identify the logical fallacy or manipulative framing.]",
      "severity": "low|medium|high"
    }
  ]
}

If no articles qualify, return {"queries": [...], "findings": []}. Max 8 entries.`;

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

  // Resolve models from the registry
  const model = modelRegistry.find(OPENROUTER_PROVIDER, MODEL_ID);
  if (!model) {
    throw new Error(`Model ${OPENROUTER_PROVIDER}/${MODEL_ID} not found in registry.`);
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
        MAX_SCRAPE_BATCHES: 4,
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

    const extractionResult = await completeSimple(model, {
      systemPrompt: extractionPrompt,
      messages: [
        { 
          role: 'user', 
          content: [
            { type: 'text', text: `RESEARCH DATA:\n\n${researchReport}` },
          ], 
          timestamp: Date.now() 
        }
      ]
    }, { 
      apiKey: auth.apiKey, 
      headers: auth.headers,
      onPayload: (payload: any) => {
        // Explicitly disable thinking for DeepSeek
        if (payload.reasoning) delete payload.reasoning;
        if (payload.thinking) delete payload.thinking;
        payload.include_reasoning = false;
        return payload;
      }
    });

    const text = extractionResult.content.find((c): c is { type: 'text', text: string } => c.type === 'text')?.text || "";
    log(`  [debug] extraction raw response length: ${text.length}`);
    if (text.length < 500) log(`  [debug] extraction raw response: ${text}`);
    if (!text) {
        log('  [pi] extraction failed: empty response from model');
        return { findings: [], queries: [] };
    }

    let result: { findings: RawFinding[]; queries: string[] };
    try {
      result = safeParseValidatedJson(ExtractionResultSchema, text);
    } catch (err) {
      log(`  [pi] FAILED to parse or validate extraction JSON. Raw response length: ${text.length}`);
      // Attempt manual recovery of findings array if possible
      const findingsMatch = text.match(/"findings"\s*:\s*(\[[\s\S]*?\])/);
      if (findingsMatch && findingsMatch[1]) {
        try {
          const findings = safeParseJson<RawFinding[]>(findingsMatch[1]);
          log(`  [pi] recovered ${findings.length} findings from malformed JSON (bypassing full validation)`);
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
