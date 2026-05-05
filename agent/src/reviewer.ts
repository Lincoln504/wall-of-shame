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

const REVIEW_PROMPT = `You are the Lead Auditor for the database.
Your mission is to rigorously vet the findings discovered by our research team.

MISSION CRITICAL: We only list content where the piece itself acts as a way to normalize, justify, or hide the harm of regressive policies.

INPUT DATA TYPE:
The input may be a JSON array of pre-extracted findings OR a raw research report.
- IF JSON: Audit the findings as normal.
- IF RAW REPORT: Extract qualify findings FIRST, then perform the audit. Follow the exact same output schema.
- If an article neutrally reports on a harmful event, it is NOT for this database.
- If an article uses biased framing to make exploitation or discrimination seem acceptable, it IS for this database.

READABILITY REQUIREMENT:
The final "summary" and "whyBad" fields must be written in plain, clear English that a common person can understand. Avoid academic or ideological jargon.

YOUR WORKFLOW:
1. For every finding in the input:
   a. Use the 'research' tool with 'depth: 0' and the URL as the query to surgically verify the content.
   b. Verify the claims and quotes in the researcher's summary are accurate.
   c. EVALUATE ANALYSIS: Review the researcher's "Why this is included" section. 
      - PRESERVE: If the analysis clearly explains the harm and the intent in simple language, keep it.
      - MODIFY: If it uses too many buzzwords or is unclear, rewrite it to be sharper and more readable while identifying the trick used to mislead.
      - DISAPPROVE: If the article is not actually a way to justify harm (e.g., it is just reporting facts), OMIT the finding entirely.
   d. CRITICAL PERSPECTIVE TEST: Is the author's goal to inform, or to make something harmful seem normal? Only approve if it clearly fails this test.

2. OUTPUT FORMAT:
Return ONLY a raw JSON array of verified findings. If a finding fails verification or doesn't meet the quality bar, OMIT it entirely.

Each entry must follow this schema:
{
  "url": "...",
  "title": "...",
  "domain": "...",
  "summary": "...",
  "category": "...",
  "whyBad": "[A comprehensive and detailed analysis. Ensure it provides a multi-layered breakdown of the framing, its intended effect, and why the content qualifies as harmful normalized content.]",
  "severity": "low|medium|high",
  "verificationLog": "Audit completed on [Date]. [Note if analysis was preserved, modified, or why it was kept.]"
}

INPUT FINDINGS:
<FINDINGS_JSON>

Return ONLY the raw JSON array. No markdown, no preamble.`;

export async function runReview(
  input: RawFinding[] | string,
  log: (msg: string) => void,
): Promise<RawFinding[]> {
  const isRawReport = typeof input === 'string';
  if (!isRawReport && input.length === 0) return [];

  const countLabel = isRawReport ? 'raw report' : `${input.length} findings`;
  log(`  [reviewer] starting audit and verification of ${countLabel}...`);

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
    // Allow ONLY the research tool (from pi-research extension)
    tools: ['research'],
  });

  session.extensionRunner.setUIContext({
    notify: (msg: string, type: string) => log(`  [reviewer] notification: [${type}] ${msg}`),
    setWidget: (id: string) => log(`  [reviewer] extension widget active: ${id}`),
    setStatus: (msg: string) => log(`  [reviewer] status: ${msg}`),
    setWorkingIndicator: (msg: string) => log(`  [reviewer] working: ${msg}`),
    confirm: async () => true,
    select: async (_title: string, options: any[]) => options[0]?.value,
    onTerminalInput: () => ({ unsubscribe: () => {} }),
  } as any);

  const inputContent = isRawReport ? input : JSON.stringify(input, null, 2);
  const prompt = REVIEW_PROMPT.replace('<FINDINGS_JSON>', inputContent);
  
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
    const originalCount = isRawReport ? '(from report)' : String(input.length);
    log(`  [reviewer] audit complete. ${reviewed.length}/${originalCount} findings approved.`);
    return reviewed;
  } catch (err) {
    log(`  [reviewer] AUDIT FAILED: ${String(err)}`);
    throw err; // Do NOT fallback to unverified findings
  }
}
