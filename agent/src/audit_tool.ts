import { readFileSync, writeFileSync } from 'fs';
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
import { safeParseJson } from './utils.js';

const OPENROUTER_PROVIDER = 'openrouter';
const MODEL_ID = 'google/gemma-4-26b-a4b-it';
const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');

const AUDIT_PROMPT = `You are a Senior Adversarial Auditor for the "Wall of Shame" database.
Your goal is to perform a DEEP audit of the following findings.

PROCEDURE:
1. For every finding:
   a. Use the /research tool to visit the URL.
   b. Verify if the quote or summary points are verbatim/accurate.
   c. CRITICAL PERSPECTIVE TEST: Verify if the piece itself ADVANCES or NORMALIZES harm (e.g., uses logical fallacies, manipulative framing, or misinformation to promote harmful policies or ideologies). It must NOT just be "reporting" on bad things.

   d. Check for: 404, broken links, paywalls (unverifiable), or weak analysis.

2. FILTER & AMEND:
   - REMOVE entries that are 404, broken, paywalled, or don't meet the Critical Perspective Test.
   - AMEND entries for better clarity, logical analysis, or to name specific fallacies.

INPUT FINDINGS:
<FINDINGS_JSON>

Return a JSON object with two fields:
{
  "approved": [ ... array of verified/amended findings ... ],
  "removed": [ { "url": "...", "reason": "..." }, ... ]
}

Return ONLY the raw JSON object. No markdown, no preamble.`;

async function main() {
  const findingsPath = join(process.cwd(), 'data', 'findings.json');
  const rawData = readFileSync(findingsPath, 'utf-8');
  const data = JSON.parse(rawData);
  const allFindings = data.findings;
  
  const approvedFindings: any[] = [];
  const removedFindings: any[] = [];

  const chunkSize = 5;
  for (let i = 0; i < allFindings.length; i += chunkSize) {
    const chunk = allFindings.slice(i, i + chunkSize);
    console.log(`Processing chunk ${i / chunkSize + 1} of ${Math.ceil(allFindings.length / chunkSize)} (${chunk.length} findings)...`);
    
    try {
      const result = await runAudit(chunk);
      approvedFindings.push(...result.approved);
      removedFindings.push(...result.removed);
      console.log(`  Chunk complete: ${result.approved.length} approved, ${result.removed.length} removed.`);
    } catch (err) {
      console.error(`  Error processing chunk: ${err}`);
      // On error, we keep the original findings for this chunk to avoid data loss
      approvedFindings.push(...chunk);
    }
  }

  const finalData = {
    ...data,
    lastUpdated: new Date().toISOString(),
    totalFindings: approvedFindings.length,
    findings: approvedFindings,
  };

  writeFileSync(findingsPath, JSON.stringify(finalData, null, 2));
  
  console.log('\n--- AUDIT SUMMARY ---');
  console.log(`Total initial findings: ${allFindings.length}`);
  console.log(`Total approved: ${approvedFindings.length}`);
  console.log(`Total removed: ${removedFindings.length}`);
  console.log('\nReasons for removal:');
  removedFindings.forEach(f => {
    console.log(`- ${f.url}: ${f.reason}`);
  });
}

async function runAudit(findings: any[]): Promise<{ approved: any[], removed: any[] }> {
  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [PI_RESEARCH_HOME],
    noExtensions: false,
    noSkills: true,
  } as any);
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(agentDir);
  const model = modelRegistry.find(OPENROUTER_PROVIDER, MODEL_ID);
  
  if (!model) throw new Error('Model not found');

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

  session.extensionRunner.setUIContext({
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    setWorkingIndicator: () => {},
    confirm: async () => true,
    select: async (_title: string, options: any[]) => options[0]?.value,
  } as any);

  const prompt = AUDIT_PROMPT.replace('<FINDINGS_JSON>', JSON.stringify(findings, null, 2));
  
  let fullOutput = '';
  session.subscribe((event) => {
    if (event.type === 'message_update' && (event as any).assistantMessageEvent?.type === 'text_delta') {
      const delta = (event as any).assistantMessageEvent.delta;
      fullOutput += delta;
      process.stdout.write(delta); // Log progress to stdout
    }
  });

  await session.prompt(prompt);
  
  return safeParseJson<{ approved: any[], removed: any[] }>(fullOutput);
}

main().catch(console.error);
