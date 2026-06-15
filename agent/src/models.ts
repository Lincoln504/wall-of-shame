/**
 * models.ts — central model policy for the Wall of Shame agent.
 *
 * Policy (per project direction): use the cheap gemma model for EVERY stage —
 * research, extraction, and review alike. Gemma is cheap, which is what makes
 * scaling to thousands of entries (many concurrent rounds) affordable.
 *
 *   RESEARCH   → gemma   (drives the pi-research SDK's multi-source synthesis)
 *   EXTRACTION → gemma   (report → structured findings)
 *   REVIEW     → gemma   (scope-gate + sharpen)
 *
 * Big-context needs are handled HIGHER UP in this project, not by swapping in a
 * larger model: the SDK is configured to bound how much scraped text reaches the
 * model per round (MAX_SCRAPE_BATCHES + the SDK's own context-gating), so gemma's
 * window is never overrun. DEEPSEEK_MODEL_ID is kept only as a documented manual
 * escalation lever; nothing uses it by default.
 *
 * Reasoning is forced OFF at the payload level for every call (cheap + fast at
 * scale; the analytical quality comes from the prompts, not from chain-of-thought).
 */

import { homedir } from 'os';
import { join } from 'path';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { completeSimple } from '@earendil-works/pi-ai';

export const OPENROUTER_PROVIDER = 'openrouter';

/** The single cheap workhorse model used by EVERY stage. */
export const GEMMA_MODEL_ID = 'google/gemma-4-26b-a4b-it';

/** Research stage = gemma (same as everything else). */
export const RESEARCH_MODEL_ID = GEMMA_MODEL_ID;

/** Documented manual escalation lever only — not used by default. */
export const DEEPSEEK_MODEL_ID = 'deepseek/deepseek-v4-flash';

export interface ResolvedModel {
  model: any;
  apiKey?: string;
  headers?: Record<string, string>;
}

// Resolved models are cached for the lifetime of the process (keyed by id+reasoning)
// so concurrent categories share one registry/auth resolution.
const cache = new Map<string, ResolvedModel>();

/**
 * Resolve an OpenRouter model from pi's real auth storage (~/.pi/agent/auth.json),
 * with reasoning forced off by default. Cached per (modelId, reasoning).
 */
export async function getOpenRouterModel(
  modelId: string,
  opts: { reasoning?: boolean } = {},
): Promise<ResolvedModel> {
  const reasoning = opts.reasoning ?? false;
  const key = `${modelId}|${reasoning}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const agentDir = join(homedir(), '.pi', 'agent');
  const registry = ModelRegistry.create(AuthStorage.create(join(agentDir, 'auth.json')));
  const model = registry.find(OPENROUTER_PROVIDER, modelId);
  if (!model) throw new Error(`Model ${OPENROUTER_PROVIDER}/${modelId} not found in registry.`);
  (model as any).reasoning = reasoning;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Model auth failed for ${modelId}: ${auth.error}`);

  const resolved: ResolvedModel = { model, apiKey: auth.apiKey, headers: auth.headers };
  cache.set(key, resolved);
  return resolved;
}

/**
 * Single-shot text completion with reasoning stripped at the payload level.
 * Returns the concatenated text content (empty string if none).
 */
export async function completeText(
  resolved: ResolvedModel,
  systemPrompt: string,
  userText: string,
): Promise<string> {
  const res = await completeSimple(
    resolved.model,
    {
      systemPrompt,
      messages: [
        { role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() },
      ],
    },
    {
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      onPayload: (payload: any) => {
        delete payload.reasoning;
        delete payload.thinking;
        payload.include_reasoning = false;
        return payload;
      },
    },
  );
  return res.content.find((c: any): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';
}
