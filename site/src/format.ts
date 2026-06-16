/**
 * format.ts — presentation helpers shared by the page and the share image.
 */

/** Defensive: strip any markdown emphasis that slipped through (site renders plain text). */
export function stripMarkdown(s: string): string {
  return (s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Split a numbered analysis ("1. … 2. … 3. …") into its separate points so each
 * can render as its own paragraph. Splits only before a single-digit list marker
 * that follows whitespace, so figures like "2023." inside a sentence are left intact.
 * Falls back to a single block for un-numbered (older golden-prose) analyses.
 */
export function splitAnalysisPoints(text: string): string[] {
  const t = stripMarkdown((text || '').trim());
  if (!t) return [];
  return t
    .split(/\s+(?=[1-9]\.\s)/)
    .map(p => p.trim())
    .filter(Boolean);
}
