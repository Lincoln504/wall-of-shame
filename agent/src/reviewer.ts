import { homedir } from 'os';
import { join } from 'path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from '@mariozechner/pi-coding-agent';
import type { RawFinding } from './findings.js';

const OPENROUTER_PROVIDER = 'openrouter';
const DEEPSEEK_MODEL_ID = 'deepseek/deepseek-v4-flash';
const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');
const PI_RESEARCH_EXTENSION = join(PI_RESEARCH_HOME, 'src', 'index.ts');

const REVIEW_PROMPT = `You are the Senior Editorial Reviewer for the "Wall of Shame."
Below is a list of findings discovered by a research agent.

YOUR TASK:
1. VERIFY SOURCES: Use the /research tool to browse each URL.
2. VALIDATE CLAIMS: Ensure the quotes provided are verbatim and the analysis correctly identifies a harmful/misleading argument in the article's own framing (not just reporting on a bad thing).
3. FILTER/AMEND:
   - If a finding is poor quality, inaccurate, or unreachable, REMOVE it (omit from JSON).
   - If the analysis or severity is slightly off, AMEND it.
   - Ensure the "whyBad" section specifically names the rhetorical technique or logical fallacy.

INPUT FINDINGS:
<FINDINGS_JSON>

CRITICAL QUALITY BAR: 
We only include pieces that ADVANCE or NORMALIZE harm. 
If in doubt, be critical and remove the entry.

Return ONLY a raw JSON array of the reviewed/verified findings (no markdown, no preamble):
[
  {
    "url": "...",
    "title": "...",
    "domain": "...",
    "summary": "...",
    "category": "...",
    "whyBad": "...",
    "severity": "low|medium|high"
  }
]`;

export async function runReview(
  findings: RawFinding[],
  log: (msg: string) => void,
): Promise<RawFinding[]> {
  if (findings.length === 0) return [];

  log(`  [reviewer] starting review of ${findings.length} findings...`);

  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [PI_RESEARCH_HOME],
    noExtensions: false, // Must be false to load the research extension
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as any);
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(agentDir);
  const model = modelRegistry.find(OPENROUTER_PROVIDER, DEEPSEEK_MODEL_ID);
  
  if (!model) throw new Error('Reviewer model not found');

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

  // Provide UI context for headless extension operation
  session.extensionRunner.setUIContext({
    notify: (msg: string, type: string) => log(`  [reviewer] notification: [${type}] ${msg}`),
    setWidget: (id: string, creator: any) => {
      if (creator) log(`  [reviewer] extension widget active: ${id}`);
    },
    setStatus: (msg: string) => log(`  [reviewer] status: ${msg}`),
    setWorkingIndicator: (msg: string) => log(`  [reviewer] working: ${msg}`),
    confirm: async () => true,
    select: async (_title: string, options: any[]) => options[0]?.value,
  } as any);

  const prompt = REVIEW_PROMPT.replace('<FINDINGS_JSON>', JSON.stringify(findings, null, 2));
  
  let fullOutput = '';
  session.subscribe((event) => {
    if (event.type === 'message_update' && (event as any).assistantMessageEvent?.type === 'text_delta') {
      fullOutput += (event as any).assistantMessageEvent.delta;
    }
  });

  try {
    log(`  [reviewer] analyzing and verifying sources...`);
    await session.prompt(prompt);
    
    const text = fullOutput;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    
    if (start === -1 || end === -1) {
      log(`  [reviewer] FAILED to get JSON array. Raw response: ${text.slice(0, 200)}...`);
      return findings; // Fallback to original if review fails
    }

    const reviewed = JSON.parse(text.slice(start, end + 1));
    log(`  [reviewer] review complete. ${reviewed.length} findings approved.`);
    return reviewed;
  } catch (err) {
    log(`  [reviewer] ERROR during review: ${String(err)}`);
    return findings; // Fallback
  }
}
