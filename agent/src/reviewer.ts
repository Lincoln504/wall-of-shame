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
import { Type } from 'typebox';
import type { RawFinding } from './findings.js';
import { safeParseJson, safeParseValidatedJson } from './utils.js';

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'google/gemma-4-26b-a4b-it';
const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');
const PI_RESEARCH_EXTENSION = join(PI_RESEARCH_HOME, 'src', 'index.ts');

// ── Reviewer schemas ─────────────────────────────────────────────────────────

const ReviewedFindingSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  domain: Type.String(),
  summary: Type.String(),
  category: Type.String(),
  whyBad: Type.String(),
  severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  verificationLog: Type.String(),
});

const ReviewerOutputSchema = Type.Array(ReviewedFindingSchema);

const REVIEW_PROMPT = `You are the Lead Adversarial Content Auditor for the "Wall of Shame."
Your mission is to rigorously vet the findings discovered by our research team.

MISSION CRITICAL: We only list content where the ARTICLE ITSELF is the bad actor. 
- If an article reports on a hate crime, it is NOT for the Wall of Shame.
- If an article ADVOCATES for, NORMALIZES, or MISLEADINGLY FRAMES harmful policy or ideology, it IS for the Wall of Shame.

YOUR WORKFLOW:
1. For every finding in the input:
   a. Use the 'research' tool with 'depth: 0' and the URL as the query to surgically verify the content.
   b. Confirm the title is exact and verify the domain.
   c. Verify the claims and quotes in the researcher's summary/analysis are accurate.
   d. EVALUATE ANALYSIS: Review the researcher's "whyBad" section. 
      - If it already correctly identifies the core manipulative framing, logical fallacies, and distortion, you may KEEP IT AS-IS.
      - If it is weak, inaccurate, or misses a key manipulative technique, you MUST EDIT it to be sharper and more accurate.
   e. CRITICAL PERSPECTIVE TEST: Is the author's primary goal to inform, or to advocate/manipulate/mislead? Only approve if it clearly fails this test.

2. OUTPUT FORMAT:
Return ONLY a raw JSON array of verified findings. If a finding fails verification or doesn't meet the quality bar, OMIT it entirely.

Each entry must follow this schema:
{
  "url": "...",
  "title": "...",
  "domain": "...",
  "summary": "...",
  "category": "...",
  "whyBad": "[The verified or improved analysis. Keep original if high quality, otherwise rewrite to identify specific fallacies/techniques.]",
  "severity": "low|medium|high",
  "verificationLog": "Surgically verified on [Date]. [Briefly note what you checked/changed, e.g. 'Researcher analysis was excellent, kept as-is' or 'Corrected misquoted text and sharpened the analysis.']"
}

INPUT FINDINGS:
<FINDINGS_JSON>

Return ONLY the raw JSON array. No markdown, no preamble.`;

export async function runReview(
  findings: RawFinding[],
  log: (msg: string) => void,
): Promise<RawFinding[]> {
  if (findings.length === 0) return [];

  log(`  [reviewer] starting adversarial audit of ${findings.length} findings...`);

  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');
  
  // Use a more surgical resource loader that doesn't bloat the context
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [PI_RESEARCH_HOME],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as any);
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(agentDir);
  const model = modelRegistry.find(OPENROUTER_PROVIDER, MODEL_ID);
  
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
    // Use medium reasoning for complex adversarial review
    thinkingLevel: 'medium',
  });

  session.extensionRunner.setUIContext({
    notify: (msg: string, type: string) => log(`  [reviewer] notification: [${type}] ${msg}`),
    setWidget: (id: string) => log(`  [reviewer] extension widget active: ${id}`),
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
    } else if (event.type === 'tool_execution_start') {
      log(`  [reviewer] using tool: ${event.toolName}`);
    }
  });

  try {
    log(`  [reviewer] analyzing and verifying sources...`);
    await session.prompt(prompt);
    
    const text = fullOutput;
    const reviewed = safeParseValidatedJson(ReviewerOutputSchema, text);
    log(`  [reviewer] audit complete. ${reviewed.length}/${findings.length} findings approved.`);
    return reviewed;
  } catch (err) {
    log(`  [reviewer] AUDIT FAILED: ${String(err)}`);
    throw err; // Do NOT fallback to unverified findings
  }
}
