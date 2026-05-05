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
import type { FindingsStore, RunState } from './types.js';

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

const EXTRACTION_PROMPT = `Analyze the research results and extract findings for the database.

CRITICAL GROUNDING & SYNTHESIS RULES:
1. ANALYTICAL SYNTHESIS: You are expected to synthesize the findings into a cohesive, analytical report. Every factual claim MUST be directly supported by a page you scraped in this session.
2. FAITHFUL REPRESENTATION: Summarize the article's actual core argument as the author intended it, without distortion.
3. NO HALLUCINATED CONTEXT: Do NOT bring in external statistics or legal precedents unless they are explicitly mentioned in the article. Never invent facts or attribute claims without evidence.
4. QUOTE REQUIREMENT: Every finding must include at least one direct, verbatim quote from the article that shows its primary argument or how it frames the issue.
5. SELECTIVITY: Include content where the piece itself acts as a way to normalize, justify, or hide the harm of regressive policies. Focus on op-eds, "alternative" news, and industry PR that uses biased framing. Omit neutral, fact-based reporting.

OUTPUT READABILITY:
The "summary" and "whyBad" fields must be written in plain, clear English that a common person can easily understand. Avoid academic jargon or ideological buzzwords in these fields. Use your internal analytical depth to identify the issues, but translate your findings into simple language.

RETURN ONLY A RAW JSON OBJECT:
{
  "queries": ["Extract the exact search queries used during research"],
  "findings": [
    {
      "url": "https://...",
      "title": "Exact Title",
      "domain": "...",
      "summary": "- Clearly summarize 3-5 main points in simple language.\\n- State the author's intended conclusion neutrally.",
      "category": "<CATEGORY_KEY>",
      "whyBad": "A comprehensive, multi-layered analysis: [1. Cite a specific claim or quote. 2. Explain in plain English the framing 'trick' or intent. 3. Detail how this justifies or normalizes harm. 4. Identify specific logical fallacies or significant omissions.]",
      "severity": "low|medium|high"
    }
  ]
}

If no articles qualify, return {"queries": [...], "findings": []}. Max 8 entries.`;

function buildExtractionPrompt(categoryKey: string, seenLinks: string[]): string {
  const seenBlock = seenLinks.length > 0 ? seenLinks.map(l => `- ${l}`).join('\n') : 'None';
  return EXTRACTION_PROMPT
    .replaceAll('<CATEGORY_KEY>', categoryKey)
    .replace('<SEEN_LINKS>', seenBlock);
}

export interface ResearchResult {
  findings: RawFinding[];
  queries: string[];
  rawReport?: string;
}

const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run research for a category using the pi-research programmatic API.
 */
export async function runResearch(
  query: string,
  categoryKey: string,
  label: string,
  queryHistory: Record<string, string>,
  findingsStore: FindingsStore,
  runState: RunState,
  log: (msg: string) => void,
): Promise<ResearchResult> {
  // env flags consumed by pi-research
  process.env['PI_RESEARCH_HOME'] = PI_RESEARCH_HOME;
  process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] = '1';
  process.env['PI_RESEARCH_BROWSER_HEADLESS'] = 'true';
  process.env['PI_RESEARCH_VERBOSE'] = '1';
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

  // Explicitly disable reasoning at the model level to prevent thinking
  model.reasoning = false;
  if ((model as any).thinkingLevelMap) {
    // Wipe thinking level map to avoid library-level defaults
    (model as any).thinkingLevelMap = { off: 'off' };
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

  let researchQueryStr = `Research task (Current Date: ${currentDate}): ${query}${avoidList}\n\n${researchStrategy}`;

  const sessionId = `shame-${Date.now()}`;
  const researchId = `research-${categoryKey}-${Date.now()}`;

  const mockCtx = {
    cwd: process.cwd(),
    model,
    modelRegistry,
    settingsManager,
    findingsStore,
    runState,
    ui: {
      notify: (msg: string) => log(`  [pi] ${msg}`),
      setStatus: (msg: string) => log(`  [pi] status: ${msg}`),
    }
  };

  let researchReport = '';
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
        TUI_REFRESH_DEBOUNCE_MS: 0,
        CONSOLE_RESTORE_DELAY_MS: 0,
    };

    researchReport = await piRunResearch({
      ctx: mockCtx as any,
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
  } catch (err) {
    log(`  [pi] CRITICAL ENGINE ERROR: ${String(err)}`);
    throw err;
  }

  log(`  [pi] research phase finished, starting extraction...`);

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

  // Get all seen URLs for this category from both store and state
  const existingInStore = findingsStore.findings.filter((f) => f.category === categoryKey).map((f) => f.url);
  const seenInCategory = runState.seenUrls[categoryKey] ?? [];
  const allSeen = Array.from(new Set([...existingInStore, ...seenInCategory]));

  const extractionPrompt = buildExtractionPrompt(categoryKey, allSeen);

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

  log(`  [pi] requesting extraction synthesis from model...`);
  const extractionResult = await completeSimple(model, {
    systemPrompt: extractionPrompt,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `RESEARCH DATA:\n\n${researchReport}` },
        ],
        timestamp: Date.now(),
      }
    ]
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    onPayload: (payload: any) => {
      if (payload.reasoning) delete payload.reasoning;
      if (payload.thinking) delete payload.thinking;
      payload.include_reasoning = false;
      return payload;
    }
  });

  const text = extractionResult.content.find((c): c is { type: 'text', text: string } => c.type === 'text')?.text ?? '';
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

    // Log failed response for debugging
    try {
      const failureDir = join(DATA_DIR, 'failures');
      if (!existsSync(failureDir)) mkdirSync(failureDir, { recursive: true });
      const failureFile = join(failureDir, `extraction-failure-${categoryKey}-${Date.now()}.txt`);
      writeFileSync(failureFile, text, 'utf-8');
      log(`  [debug] failed extraction response saved to: ${failureFile}`);
    } catch (logErr) {
      log(`  [warn] failed to save extraction failure log: ${String(logErr)}`);
    }

    // Attempt manual recovery of findings array if possible
    const findingsMatch = text.match(/"findings"\s*:\s*(\[[\s\S]*?\])/);
    if (findingsMatch && findingsMatch[1]) {
      try {
        const findings = safeParseJson<RawFinding[]>(findingsMatch[1]);
        log(`  [pi] recovered ${findings.length} findings from malformed JSON (bypassing full validation)`);
        result = { findings, queries: [] };
      } catch {
        log(`  [pi] manual recovery failed, falling back to raw report for next stage.`);
        return { findings: [], queries: [], rawReport: researchReport };
      }
    } else {
      log(`  [pi] extraction failed, falling back to raw report for next stage.`);
      return { findings: [], queries: [], rawReport: researchReport };
    }
  }

  return {
    findings: result.findings ?? [],
    queries: result.queries ?? [],
  };
}

/**
 * Clean up pi-research resources (e.g. browser pool).
 */
export async function shutdownResearch() {
  await shutdownManager.runCleanup('agent shutdown');
}
