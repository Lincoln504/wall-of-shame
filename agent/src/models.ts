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
 * Reasoning policy (per project direction): the RESEARCH stage runs reasoning OFF
 * (it drives the SDK's tool loop, where chain-of-thought adds latency without
 * improving the final report). The EXTRACTION and REVIEW stages run at MEDIUM
 * reasoning — that is what restores the golden-era analytical depth (the rich,
 * multi-point whyBad breakdowns with named fallacies + external context). Effort
 * is requested per-call via completeText({ reasoning: 'medium' }); when omitted,
 * reasoning is stripped at the payload level (the cheap/fast default).
 */

import { homedir } from 'os';
import { join } from 'path';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { completeSimple, type ThinkingLevel } from '@earendil-works/pi-ai';

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
 * Resolve an OpenRouter model from pi's real auth storage (~/.pi/agent/auth.json).
 * `reasoning` here is the model CAPABILITY flag (whether the provider should be
 * told this model can think); the per-call effort is requested separately in
 * completeText. Cached per (modelId, reasoning-capable).
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
 * Single-shot text completion. By default reasoning is stripped at the payload
 * level (cheap/fast). Pass `reasoning: 'medium'` (or any ThinkingLevel) to enable
 * chain-of-thought for the analytical stages (extraction/review) — pi-ai renders
 * it as OpenRouter's `reasoning: { effort }`. The returned value is always the
 * final TEXT content only; any reasoning/thinking blocks are never concatenated
 * into the result, so they cannot leak into a finding's whyBad.
 */
export async function completeText(
  resolved: ResolvedModel,
  systemPrompt: string,
  userText: string,
  opts: {
    reasoning?: ThinkingLevel | false;
    /** Sampling temperature. Lower (≈0.3) for structured/analytical stages reduces
     *  fabricated specifics; omit to use the model default. */
    temperature?: number;
    /** Nucleus sampling. ≈0.9 measurably cuts hallucinated named entities. */
    topP?: number;
    /** Request OpenRouter JSON-object mode (response_format) for OBJECT-returning
     *  stages. If the routed provider rejects it, we transparently retry without it,
     *  so it can never break the pipeline (safeParseJson remains the parser). */
    json?: boolean;
  } = {},
): Promise<string> {
  const reasoning = opts.reasoning ?? false;
  const extract = (res: any) =>
    res.content.find((c: any): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';

  // pi-ai forwards the onPayload result verbatim to OpenRouter (no key stripping), so
  // temperature/top_p/response_format can be injected directly into the request body.
  const run = (useJson: boolean) => completeSimple(
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
      ...(reasoning ? { reasoning } : {}),
      onPayload: (payload: any) => {
        delete payload.thinking;
        if (!reasoning) {
          // Cheap/fast default: fully suppress thinking.
          delete payload.reasoning;
          payload.include_reasoning = false;
        }
        if (opts.temperature !== undefined) payload.temperature = opts.temperature;
        if (opts.topP !== undefined) payload.top_p = opts.topP;
        if (useJson) payload.response_format = { type: 'json_object' };
        return payload;
      },
    },
  );

  try {
    return extract(await run(opts.json === true));
  } catch (err) {
    // response_format is provider-dependent for gemma; degrade gracefully to a plain
    // completion (prompt-driven JSON + safeParseJson) rather than failing the stage.
    if (opts.json === true) return extract(await run(false));
    throw err;
  }
}
