import { Value } from 'typebox/value';
import type { TSchema, Static } from 'typebox';

function findMatchingClose(text: string, openPos: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openPos; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Robustly extract and parse a JSON object or array from a potentially noisy LLM response.
 * Handles markdown code fences, trailing commas, and conversational preamble/postamble.
 */
export function safeParseJson<T>(text: string): T {
  // 1. Try to find a JSON block inside markdown fences first
  const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let target = markdownMatch ? markdownMatch[1] : text;

  // 2. Locate the outermost structure ([...] or {...})
  const startObj = target.indexOf('{');
  const startArr = target.indexOf('[');

  let start = -1;
  let end = -1;

  if (startObj !== -1 && (startArr === -1 || startObj < startArr)) {
    start = startObj;
    end = findMatchingClose(target, startObj, '{', '}');
  } else if (startArr !== -1) {
    start = startArr;
    end = findMatchingClose(target, startArr, '[', ']');
  }

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No valid JSON structure ({...} or [...]) found in response');
  }

  let jsonText = target.slice(start, end + 1);

  // 3. Clean up common LLM syntax errors
  jsonText = jsonText
    .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
    .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1'); // Remove potential JS comments

  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    // 4. Attempt to fix unescaped newlines in strings
    // This is a common issue where LLMs put real newlines inside "..."
    try {
      const fixedNewlines = jsonText.replace(/:\s*"([\s\S]*?)"(?=\s*[,}])/g, (match, p1) => {
        return ': "' + p1.replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
      });
      return JSON.parse(fixedNewlines) as T;
    } catch {
      // 5. Final attempt: brute-force cleanup of control characters
      try {
        const bruteClean = jsonText
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, (match) => (match === '\n' || match === '\r' || match === '\t') ? match : ' ')
          .trim();
        return JSON.parse(bruteClean) as T;
      } catch {
        // One last try: very aggressive cleanup
        try {
           const veryAggressive = jsonText
             .replace(/\n/g, ' ')
             .replace(/\r/g, ' ')
             .replace(/\t/g, ' ');
           return JSON.parse(veryAggressive) as T;
        } catch {
           throw new Error(`JSON parse failed: ${String(err)}\nSnippet: ${jsonText.slice(0, 100)}...`);
        }
      }
    }
  }
}

/**
 * Parses JSON robustly and validates it against a TypeBox schema.
 */
export function safeParseValidatedJson<T extends TSchema>(schema: T, text: string): Static<T> {
  const data = safeParseJson<unknown>(text);
  if (Value.Check(schema, data)) {
    return data as Static<T>;
  }
  
  const errors = [...Value.Errors(schema, data)];
  const errorMsg = errors.map((e: any) => `${e.path || 'root'}: ${e.message}`).join(', ');
  throw new Error(`Schema validation failed: ${errorMsg}`);
}

/**
 * Robust URL canonicalization for deduplication.
 * - Removes protocol (http/https)
 * - Removes 'www.' prefix
 * - Removes trailing slashes
 * - Strips common tracking parameters (utm_*, ref, source, etc.)
 */
export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    
    let path = parsed.pathname;
    if (path.endsWith('/')) path = path.slice(0, -1);
    
    // Strip common tracking/query parameters
    const searchParams = new URLSearchParams(parsed.search);
    const toDelete: string[] = [];
    for (const key of searchParams.keys()) {
      if (
        key.startsWith('utm_') || 
        ['ref', 'source', 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase())
      ) {
        toDelete.push(key);
      }
    }
    toDelete.forEach(key => searchParams.delete(key));
    
    const search = searchParams.toString();
    return `${host}${path}${search ? '?' + search : ''}${parsed.hash}`;
  } catch {
    // Fallback for malformed URLs: just lowercase and trim
    return url.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  }
}

/**
 * Robust title normalization for deduplication.
 * Removes non-alphanumeric chars, lowercases, and collapses whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Keep spaces initially
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim()
    .replace(/\s/g, '');        // Final removal of spaces
}

/**
 * Run an async mapper over `items` with a bounded number of concurrent workers.
 *
 * Results are returned in the original item order. Each item is settled
 * independently: a rejected mapper does NOT cancel the others — its slot in the
 * results array is an { error } sentinel so the caller can decide per item.
 * This is the failure-isolation primitive behind concurrent research rounds.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await mapper(items[i]!, i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
