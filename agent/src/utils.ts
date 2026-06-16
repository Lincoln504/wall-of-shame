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
 * Normalize a whyBad analysis string for STORAGE/DISPLAY.
 *
 * Defense-in-depth against three malformations the models have produced:
 *   1. The whole raw response leaking in (```json fences and/or a {"whyBad": "..."}
 *      JSON object) instead of just the analysis text.
 *   2. A leading "Analysis:" label (one or more) — the site renders its own
 *      "Analysis:" heading, so a stored label produces "Analysis: Analysis: ...".
 *   3. The analysis wrapped in an outer "[ ... ]" pair (the old golden-format token),
 *      which then shows literal brackets in the UI.
 *
 * The numbered "1. … 5. …" structure is preserved verbatim. If normalization would
 * empty the string, the trimmed original is returned (never destroy content).
 */
export function normalizeWhyBad(input: unknown): string {
  let s = (input == null ? '' : String(input)).trim();
  if (!s) return '';
  const original = s;

  // 1a. Unwrap a markdown code fence if the value is fenced.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 1b. If the value is (or contains) a JSON object carrying a whyBad key, pull it out.
  if (/"whyBad"\s*:/.test(s)) {
    // Models sometimes emit prose-style escapes (e.g. \') that are INVALID JSON and
    // make JSON.parse throw. Strip backslashes that don't begin a legal JSON escape
    // so the object parses; this never touches valid \\ \" \/ \b \f \n \r \t \uXXXX.
    const dropBadEscapes = (t: string) => t.replace(/\\(?!["\\/bfnrtu])/g, '');
    try {
      const objMatch = s.match(/\{[\s\S]*\}/);
      if (objMatch) {
        const obj = JSON.parse(dropBadEscapes(objMatch[0])) as { whyBad?: unknown };
        if (obj && typeof obj.whyBad === 'string') s = obj.whyBad.trim();
      }
    } catch {
      const m = s.match(/"whyBad"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try { s = JSON.parse(`"${dropBadEscapes(m[1])}"`); } catch { /* keep s */ }
        s = s.trim();
      }
    }
  }

  // 2. Strip one or more leading "Analysis:" labels.
  s = s.replace(/^(?:Analysis:\s*)+/i, '').trim();

  // 3. Strip a single outer [ ... ] wrapper (the old golden-format token).
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner) s = inner;
  }

  // A second label can hide behind the bracket ("[Analysis: ...]").
  s = s.replace(/^(?:Analysis:\s*)+/i, '').trim();

  // Strip leading verification/audit metadata that an older reviewer leaked into
  // whyBad — it belongs in verificationLog, not the analysis. Only removes whole
  // leading sentences that BEGIN with an audit phrase, so real analysis is untouched.
  {
    const parts = s.split(/(?<=[.!?])\s+/);
    let removed = 0;
    while (
      parts.length > 1 && removed < 6 &&
      /^(Audit VERIFIED|URL\b|PDF\b|Content confirmed|Verified\b|Text extraction confirms|Accessible\b)/i.test(parts[0].trim())
    ) {
      parts.shift();
      removed++;
    }
    if (removed) s = parts.join(' ').trim();
  }

  // Strip markdown formatting — the site renders whyBad as PLAIN TEXT, so any
  // **bold**, *italic*, `code`, or # headers the model emits would show literally.
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold**
    .replace(/__([^_]+)__/g, '$1')       // __bold__
    .replace(/\*([^*\n]+)\*/g, '$1')     // *italic* (after bold removal)
    .replace(/`([^`]+)`/g, '$1')         // `code`
    .replace(/^\s{0,3}#{1,6}\s+/gm, ''); // # headings

  // Normalize line endings; do not otherwise reflow the analysis.
  s = s.replace(/\r\n?/g, '\n').trim();

  return s || original;
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
