import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from '@mariozechner/pi-coding-agent';
import type { RawFinding } from './findings.js';

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const DEEPSEEK_MODEL_ID = 'deepseek/deepseek-v4-flash';

// Allow override via PI_RESEARCH_HOME env var (used in CI)
// Defaults to ~/Documents/pi-research for local development
const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');
const PI_RESEARCH_EXTENSION = join(PI_RESEARCH_HOME, 'src', 'index.ts');

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
 * Run research for a category.
 *
 * Sends `/research <query>` via the pi-research extension slash command to
 * perform the actual web research, then sends a second prompt instructing the
 * LLM to analyze the results and output a JSON array of findings.
 *
 * @param query     The research query (e.g. what articles to find, angles to explore)
 * @param categoryKey  The category key to embed in the extraction prompt
 * @param label     Human-readable label for logging
 * @param queryHistory Recently used queries to avoid
 * @param log       Logging function
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

  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');

  log(`  [pi] loading extension: ${PI_RESEARCH_EXTENSION}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [PI_RESEARCH_HOME],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(agentDir);

  // Resolve the DeepSeek model from the registry
  const model = modelRegistry.find(OPENROUTER_PROVIDER, DEEPSEEK_MODEL_ID);
  if (!model) {
    throw new Error(
      `Model ${OPENROUTER_PROVIDER}/${DEEPSEEK_MODEL_ID} not found in registry. ` +
      `Check ~/.pi/agent/models.json under the "${OPENROUTER_PROVIDER}" provider.`
    );
  }
  log(`  [pi] using model: ${model.provider}/${model.id}`);

  log(`  [pi] creating session for: ${label}`);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    model,
  });

  // Provide a non-blocking UI context to prevent hangs in extensions that use UI calls
  session.extensionRunner.setUIContext({
    notify: (msg: string, type: string) => log(`  [pi] notification: [${type}] ${msg}`),
    setWidget: (id: string, creator: any) => {
      if (creator) log(`  [pi] extension widget active: ${id}`);
    },
    setStatus: (msg: string) => log(`  [pi] status: ${msg}`),
    setWorkingIndicator: (msg: string) => log(`  [pi] working: ${msg}`),
    confirm: async (title: string, msg: string) => {
      log(`  [pi] auto-confirming extension dialog: ${title} - ${msg}`);
      return true;
    },
    select: async (title: string, options: any[]) => {
      log(`  [pi] auto-selecting first option for extension dialog: ${title}`);
      return options[0]?.value;
    },
  } as any);

  let fullOutput = '';
  let toolCount = 0;

  const unsub = session.subscribe((event) => {
    if (
      event.type === 'message_update' &&
      (event as any).assistantMessageEvent?.type === 'text_delta'
    ) {
      const delta = (event as any).assistantMessageEvent.delta as string;
      fullOutput += delta;
      // Silence individual deltas for cleaner logs unless we're in extraction phase
    } else if (event.type === 'tool_execution_start') {
      toolCount++;
      log(`  [pi] tool #${toolCount}: ${event.toolName}`);
    }
  });

  try {
    // Step 1: Run research via /research slash command.
    log(`  [pi] starting research...`);
    const researchCommand = session.extensionRunner.getCommand('research');
    if (!researchCommand) {
      throw new Error('Research command not found. Extension failed to load?');
    }

    // Calculate forbidden queries (used in the last 7 days)
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const forbidden = Object.entries(queryHistory || {})
      .filter(([_, lastAt]) => now - new Date(lastAt).getTime() < ONE_WEEK_MS)
      .map(([q, _]) => q);

    const avoidList = forbidden.length > 0
      ? `\n\nAVOID THESE EXACT QUERIES (searched within the last week):\n${forbidden.join('\n')}\nYou must use SIGNIFICANTLY DIFFERENT phrasing and explore new angles.`
      : '';

    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const currentYear = new Date().getFullYear();

    const researchStrategy = `
    SEARCH STRATEGY — Be an investigative researcher. Do NOT just use the seed concepts; use them to generate 10-15 highly varied and creative search queries:

1. VARY PHRASING: Use synonyms, industry jargon vs. academic terms, and loaded vs. neutral language.
2. VARY SOURCE TYPES: Target a mix of mainstream media (op-eds, commentary, major news outlets), niche ideological blogs, "alternative" news sites, and industry association PR. Mainstream sources are often the source of 'low' severity findings (subtle bias, misleading framing).
3. VARY TIMEFRAMES: 
   - Evergreen: Search for core ideological arguments without date constraints.
   - RECENT/UP-TO-DATE: Specifically include the current year (${currentYear}) or the previous year (${currentYear - 1}) in many queries to surface fresh content and breaking news framing.
   - Use search operators like "past month" or "past year" if your tool supports them.
4. VARY ANGLES: Explore different facets of the category (e.g., different industries or specific policies).
5. CROSS-REFERENCE: Use findings from one search to inform the next.

PERSPECTIVE TEST — only flag a page if its own argument or framing is harmful. Do NOT flag a page merely because its subject matter is bad. A news article reporting on a harmful act is not itself harmful. An investigative piece exposing corporate manipulation is not itself manipulative. Ask: is this piece advocating for, normalizing, or misleadingly framing the bad thing — or is it reporting on / criticizing it? Only the former belongs in findings.`;

    const researchQueryStr = `Research task (Current Date: ${currentDate}): ${query}${avoidList}\n\n${researchStrategy}`;

    // Execute the command directly via the handler
    await researchCommand.handler(researchQueryStr, session.extensionRunner.createCommandContext());

    // Step 2: Extraction
    log(`  [pi] extracting findings...`);
    const extractionPrompt = buildExtractionPrompt(categoryKey);
    // Use prompt() which is the supported way to send messages in AgentSession
    await session.prompt(extractionPrompt);
    
    // The subscriber above has been collecting the fullOutput
    const text = fullOutput;

    unsub();

    let result: { findings: import('./findings.js').RawFinding[]; queries: string[] };
    try {
      // Find the first { and last } to extract JSON from potential markdown/preamble
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON object found in response');
      const jsonText = text.slice(start, end + 1);
      result = JSON.parse(jsonText);
    } catch (err) {
      log(`  [pi] FAILED to parse extraction JSON. Raw response: ${text.slice(0, 500)}...`);
      throw new Error(`JSON extraction failed: ${String(err)}`);
    }

    return {
      findings: result.findings || [],
      queries: result.queries || [],
    };
  } catch (err) {
    unsub();
    throw err;
  }
}
