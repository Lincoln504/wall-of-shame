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
import { loadFindings, saveFindings } from './findings.js';
import type { Finding } from './types.js';
import { isGitRepo, remoteExists, hasDataChanges, commitAndPush } from './git.js';

const OPENROUTER_PROVIDER = 'openrouter';
const DEEPSEEK_MODEL_ID = 'deepseek/deepseek-v4-flash';
const PI_RESEARCH_HOME = process.env['PI_RESEARCH_HOME'] ?? join(homedir(), 'Documents', 'pi-research');
const PI_RESEARCH_EXTENSION = join(PI_RESEARCH_HOME, 'src', 'index.ts');

const AUDIT_PROMPT = `You are the Lead Auditor for the "Wall of Shame." 
Your mission is to perform a high-stakes, adversarial investigation of the existing database entries below.

CORE OBJECTIVES:
1. SOURCE VERIFICATION: Use the /research tool to visit the URL for every single entry.
2. ADVERSARIAL VALIDATION: 
   - Is the "whyBad" analysis logically sound? 
   - Is the quote 100% verbatim? 
   - Does the article actually advocate for/normalize the harm, or is it just reporting?
3. CLEANUP:
   - REMOVE entries that are broken links, 404s, or paywalled (if you can't verify).
   - REMOVE entries that don't meet the "Critical Perspective Test" (reporting vs. advocating).
   - AMEND entries to improve the analysis or correct the title/summary.

INPUT ENTRIES:
<ENTRIES_JSON>

Return ONLY a raw JSON array of the verified/amended findings (no markdown, no preamble). 
If an entry is invalid, omit it.
[
  {
    "id": "...", 
    "url": "...",
    "title": "...",
    "domain": "...",
    "summary": "...",
    "category": "...",
    "whyBad": "...",
    "severity": "...",
    "foundAt": "...",
    "researchQuery": "..."
  }
]`;

export async function runDeepAudit(
  batchSize: number = 5,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const store = loadFindings();
  if (store.findings.length === 0) {
    log('No findings to audit.');
    return;
  }

  log(`🚀 Starting Deep Audit of ${store.findings.length} findings (batch size: ${batchSize})...`);

  const cwd = process.cwd();
  const agentDir = join(homedir(), '.pi', 'agent');
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [PI_RESEARCH_HOME],
    noExtensions: false,
  } as any);
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(OPENROUTER_PROVIDER, DEEPSEEK_MODEL_ID);
  if (!model) throw new Error('Auditor model not found');

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    authStorage,
    modelRegistry,
    settingsManager: SettingsManager.create(agentDir),
    sessionManager: SessionManager.inMemory(),
    model,
  });

  session.extensionRunner.setUIContext({
    notify: (msg: string, type: string) => log(`  [audit] notification: [${type}] ${msg}`),
    setWidget: (id: string) => log(`  [audit] widget active: ${id}`),
    setStatus: (msg: string) => log(`  [audit] status: ${msg}`),
    setWorkingIndicator: (msg: string) => log(`  [audit] working: ${msg}`),
    confirm: async () => true,
    select: async (_title: string, options: any[]) => options[0]?.value,
  } as any);

  const auditedFindings: Finding[] = [];
  let processedCount = 0;

  // Process in small batches to stay within LLM context and tool execution limits
  for (let i = 0; i < store.findings.length; i += batchSize) {
    const currentBatch = store.findings.slice(i, i + batchSize);
    log(`\n🔍 Auditing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(store.findings.length / batchSize)}...`);

    const prompt = AUDIT_PROMPT.replace('<ENTRIES_JSON>', JSON.stringify(currentBatch, null, 2));
    let fullOutput = '';
    const unsub = session.subscribe((event) => {
      if (event.type === 'message_update' && (event as any).assistantMessageEvent?.type === 'text_delta') {
        fullOutput += (event as any).assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(prompt);
      unsub();

      const text = fullOutput;
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');

      if (start !== -1 && end !== -1) {
        const batchAudited: Finding[] = JSON.parse(text.slice(start, end + 1));
        auditedFindings.push(...batchAudited);
        log(`  ✅ Batch complete. ${batchAudited.length}/${currentBatch.length} findings retained/amended.`);
      } else {
        log(`  ⚠️ Failed to extract JSON from batch. Retaining original ${currentBatch.length} findings as fallback.`);
        auditedFindings.push(...currentBatch);
      }
    } catch (err) {
      unsub();
      log(`  ❌ ERROR auditing batch: ${String(err)}`);
      auditedFindings.push(...currentBatch);
    }

    processedCount += currentBatch.length;
  }

  // Update store with audited results
  const removedCount = store.findings.length - auditedFindings.length;
  store.findings = auditedFindings;
  saveFindings(store);

  log(`\n✨ Deep Audit Finished!`);
  log(`   Processed: ${processedCount}`);
  log(`   Retained:  ${auditedFindings.length}`);
  log(`   Removed:   ${removedCount}`);

  if (isGitRepo() && remoteExists() && hasDataChanges()) {
    log('🚀 Pushing audit results to GitHub...');
    commitAndPush(0); // Note: addedCount 0 since this is a cleanup run
  }
}

// ── Standalone CLI Entry ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const size = parseInt(args[0] || '5', 10);
  runDeepAudit(size).catch(err => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
