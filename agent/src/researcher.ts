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

CRITICAL: Only include URLs that were actually visited and confirmed to contain the described content during this research session. Do NOT construct, guess, or infer URLs — if you did not browse to a URL and read it, omit it entirely. Also omit URLs from these domains — they are behind bot-protection or hard paywalls that make URLs unverifiable: wsj.com, ft.com, bloomberg.com, economist.com, cato.org.

Return ONLY a raw JSON array (no markdown, no code blocks, no preamble):
[
  {
    "url": "https://...",
    "title": "exact article title as it appeared on the page",
    "domain": "example.com",
    "summary": "2-3 sentences on what the article argues or normalizes",
    "category": "<CATEGORY_KEY>",
    "whyBad": "specific, precise explanation of what makes this harmful, biased, or maliciously ideological",
    "severity": "low|medium|high"
  }
]
Be selective: only include genuinely harmful content. Empty array [] is valid if nothing qualifies. Max 8 entries. Each entry must be a specific article, op-ed, report, or blog post — not a homepage, general advocacy page, category listing, or "about" page. The URL must lead directly to the specific content being criticized.`;

function buildExtractionPrompt(categoryKey: string): string {
  return EXTRACTION_PROMPT.replaceAll('<CATEGORY_KEY>', categoryKey);
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
 * @param log       Logging function
 */
export async function runResearch(
  query: string,
  categoryKey: string,
  label: string,
  log: (msg: string) => void,
): Promise<RawFinding[]> {
  // env flags consumed by pi-research
  process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] = '1';
  process.env['PI_RESEARCH_BROWSER_HEADLESS'] = 'true';
  process.env['PI_RESEARCH_VERBOSE'] = '0';

  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');

  // Load existing findings URLs to avoid duplicates
  const findingsPath = join(cwd, 'agent/data/findings.json');
  let existingUrls: string[] = [];
  if (existsSync(findingsPath)) {
    try {
      const data = JSON.parse(readFileSync(findingsPath, 'utf-8'));
      existingUrls = (data.findings || []).map((f: any) => f.url);
    } catch (err) {
      log(`  [warn] failed to read existing findings: ${String(err)}`);
    }
  }

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

    // Instruct the tool to avoid existing URLs and use grep to check findings.json
    const exclusionList = existingUrls.length > 0 
      ? `\n\nALREADY IN LIST (DO NOT RE-RESEARCH OR INCLUDE):\n${existingUrls.slice(0, 50).join('\n')}${existingUrls.length > 50 ? '\n...and others' : ''}`
      : '';
    
    const researchQuery = `Research task: ${query}${exclusionList}\n\nNote: Use the 'grep' tool to check agent/data/findings.json if you are unsure if a finding is already present.`;
    
    // Commands in the SDK are traditionally invoked via session.prompt('/command args')
    // which handles adding the command to session history. We'll use session.prompt
    // but ensured we have a good UI context above.
    await session.prompt(`/research ${researchQuery}`);

    // Step 2: Send extraction prompt so the LLM analyzes the research
    // results (now in context from step 1) and outputs structured JSON.
    log(`  [pi] sending extraction prompt...`);
    await session.prompt(buildExtractionPrompt(categoryKey));
  } finally {
    unsub();
    session.dispose();
  }

  process.stdout.write('\n');
  return extractFindings(fullOutput);
}

// ── JSON extraction ───────────────────────────────────────────────────────────

export function extractFindings(output: string): RawFinding[] {
  // Strip markdown code fences if present
  const stripped = output.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

  // Find the outermost JSON array
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RawFinding =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.url === 'string' &&
        item.url.startsWith('http'),
    );
  } catch {
    return [];
  }
}
