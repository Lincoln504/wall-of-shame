/**
 * researcher.ts
 *
 * Creates a pi SDK session with pi-research extension loaded, runs a research
 * prompt, and returns the structured JSON findings extracted from the response.
 *
 * Pi-research is loaded as an extension via additionalExtensionPaths — no
 * subprocess spawn needed. The session runs fully in-process.
 */

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

// ── Model config ──────────────────────────────────────────────────────────────

const OPENROUTER_PROVIDER = 'openrouter';
const DEEPSEEK_MODEL_ID = 'deepseek/deepseek-v4-flash';

const PI_RESEARCH_EXTENSION = join(
  homedir(),
  'Documents',
  'pi-research',
  'src',
  'index.ts',
);

export async function runResearch(
  prompt: string,
  label: string,
  log: (msg: string) => void,
): Promise<RawFinding[]> {
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
    additionalExtensionPaths: [PI_RESEARCH_EXTENSION],
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

  let fullOutput = '';
  let toolCount = 0;

  const unsub = session.subscribe((event) => {
    if (
      event.type === 'message_update' &&
      (event as any).assistantMessageEvent?.type === 'text_delta'
    ) {
      const delta = (event as any).assistantMessageEvent.delta as string;
      fullOutput += delta;
      process.stdout.write(delta);
    } else if (event.type === 'tool_execution_start') {
      toolCount++;
      log(`  [pi] tool #${toolCount}: ${event.toolName}`);
    }
  });

  try {
    await session.prompt(prompt);
  } finally {
    unsub();
    if (typeof (session as any).dispose === 'function') {
      (session as any).dispose();
    }
  }

  process.stdout.write('\n');
  return extractFindings(fullOutput);
}

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
