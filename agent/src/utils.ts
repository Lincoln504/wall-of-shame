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
    end = target.lastIndexOf('}');
  } else if (startArr !== -1) {
    start = startArr;
    end = target.lastIndexOf(']');
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
    // 4. Final attempt: brute-force cleanup of control characters that often break JSON.parse
    // but preserve actual newlines in strings if they are escaped (\n)
    try {
      const bruteClean = jsonText
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ') // Remove non-printable control chars
        .trim();
      return JSON.parse(bruteClean) as T;
    } catch {
      throw new Error(`JSON parse failed: ${String(err)}\nSnippet: ${jsonText.slice(0, 100)}...`);
    }
  }
}
