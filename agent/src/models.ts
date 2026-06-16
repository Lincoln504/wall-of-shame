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
 * Reasoning policy: ALL gemma stages (research, extraction, review) run reasoning
 * OFF. Measured on this model + provider, enabling reasoning on gemma-4-26b-a4b-it
 * makes it ~20× slower (≈37s for a trivial prompt, minutes-to-stall on a full
 * extraction) while returning the SAME text — fatal for unattended scale. The detailed
 * stage prompts carry the analytical depth on their own. Only the VERIFY stage
 * (DeepSeek V4 Pro, a model built for it) uses reasoning. Effort is requested per-call
 * via completeText({ reasoning }); when off, reasoning is stripped at the payload level.
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

/**
 * Verification/grounding stage = DeepSeek V4 Pro. The final pass before entry runs
 * a big-context model so a whole batch of entries (each with its scraped article
 * text) fits in one call, and because this correctness-critical step rewards a
 * stronger instruction-follower. 1.05M-token context, cheap on OpenRouter.
 * Overridable via WOS_VERIFY_MODEL.
 */
export const VERIFY_MODEL_ID = process.env['WOS_VERIFY_MODEL'] || 'deepseek/deepseek-v4-pro';

// ── Context-aware model routing ─────────────────────────────────────────────────
//
// Policy (per project direction): use cheap gemma for ordinary snippet/report-sized
// work, and only escalate to the 1M-context DeepSeek V4 Pro when a stage genuinely
// dumps a large amount of text at once (full-article batches). DeepSeek FLASH is
// intentionally not used anywhere — when we pay for DeepSeek it is for the big-context
// Pro window. The threshold is a rough token estimate (chars/4); above it, gemma's
// window would be overrun and the big-context model both fits and reads better.

/** Rough token estimate (≈ chars/4) used ONLY to choose a model tier, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Tokens of input above which a stage escalates from gemma to DeepSeek V4 Pro (1M ctx). */
export const CONTEXT_ESCALATION_TOKENS = Math.max(
  1000, Number(process.env['WOS_CONTEXT_ESCALATION_TOKENS']) || 100000,
);

/**
 * Pick the workhorse model for a stage from the size of its input. Snippet/report-sized
 * inputs (the normal case for extraction/review) stay on cheap gemma; a genuinely large
 * input (e.g. many full articles dumped together) routes to DeepSeek V4 Pro's 1M window.
 */
export function pickModelForContext(inputText: string): string {
  return estimateTokens(inputText) > CONTEXT_ESCALATION_TOKENS ? VERIFY_MODEL_ID : GEMMA_MODEL_ID;
}

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
    /** Hard per-call HTTP timeout (ms). A hung OpenRouter request must never stall an
     *  unattended round; past this the call aborts and the stage's own retry/skip logic
     *  takes over. Default 180000 (3 min); override via WOS_MODEL_TIMEOUT_MS. */
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const reasoning = opts.reasoning ?? false;
  const timeoutMs = opts.timeoutMs ?? Math.max(30000, Number(process.env['WOS_MODEL_TIMEOUT_MS']) || 180000);
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
      // Native client timeout + an AbortSignal belt-and-braces, so a stalled connection
      // can't wedge the round even if the provider ignores timeoutMs.
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
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
    // response_format (json_object) is provider-dependent for gemma and has been
    // observed to HANG the request on some OpenRouter providers (it times out via the
    // signal above). Degrade gracefully to a plain completion (prompt-driven JSON +
    // safeParseJson) — this also recovers when response_format itself was the stall.
    // Worst case is two bounded timeout windows, then the caller's retry/skip takes over;
    // it can never hang the round.
    if (opts.json === true) return extract(await run(false));
    throw err;
  }
}
