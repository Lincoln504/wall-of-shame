/**
 * classify.ts — assign each finding the SINGLE best canonical category from its OWN text.
 *
 * Why this exists: the research pipeline force-stamps every finding with the category of the
 * round that found it (findings.ts sets `category: categoryKey`, and the extraction prompt is
 * fed a fixed <CATEGORY_KEY>). When a category's researcher drifts and surfaces an off-topic
 * piece (e.g. the "media" round finding an anti-wealth-tax op-ed), it is mislabeled. This
 * classifier re-derives the category from the entry's title/source/summary/analysis — content,
 * not the bucket it arrived in — choosing only from the canonical key list.
 *
 * Shared by scripts/recategorize.ts (one-off corpus repair) and run.ts (per-round, going
 * forward). Uses DeepSeek V4 Pro (the project's instruction-following grader).
 */
import { CATEGORIES } from './categories.js';
import { getOpenRouterModel, completeText, VERIFY_MODEL_ID } from './models.js';

export interface ClassifiableEntry {
  id: string;
  title: string;
  domain: string;
  summary: string;
  whyBad: string;
  category: string;
}

const CAT_REF = CATEGORIES.map(c => `- ${c.key}: ${c.name} — ${c.description}`).join('\n');

const SYSTEM = `You are a precise taxonomy classifier for the Wall of Shame, a library of web content judged harmful (propaganda and op-eds that normalize, justify, or hide the harm of regressive policy).

You are given the canonical category list and a batch of entries. For EACH entry, choose the SINGLE best-fitting category KEY based ONLY on the entry's own text — judge what the piece is actually ABOUT and what harm it performs, NOT the type of outlet that published it (an economics op-ed in a media outlet is "economics", not "media"; "media" is only for pieces whose harm IS the journalism itself — access journalism, false balance, manufactured consensus).

Canonical categories:
${CAT_REF}

Return ONLY compact JSON, no prose, no code fences:
{"assignments":[{"id":"<id>","category":"<key>"}]}
One object per entry, the exact id given, and a category that is EXACTLY one of the keys above.`;

/** Strip code fences / surrounding prose and parse the first JSON object. */
function safeParse(raw: string): any {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* nope */ } }
  return null;
}

/**
 * Returns id → best category key, ONLY for ids the model classified to a valid key.
 * Entries are batched and graded with bounded concurrency; a failed batch is skipped
 * (those ids simply keep their current category), so this can never throw mid-run.
 */
export async function classifyCategories(
  entries: ClassifiableEntry[],
  opts: { batchSize?: number; concurrency?: number; log?: (m: string) => void } = {},
): Promise<Map<string, string>> {
  const batchSize = opts.batchSize ?? 20;
  const concurrency = opts.concurrency ?? 4;
  const log = opts.log ?? (() => {});
  const validKeys = new Set(CATEGORIES.map(c => c.key));
  const out = new Map<string, string>();
  if (entries.length === 0) return out;

  const resolved = await getOpenRouterModel(VERIFY_MODEL_ID, { reasoning: false });

  const batches: ClassifiableEntry[][] = [];
  for (let i = 0; i < entries.length; i += batchSize) batches.push(entries.slice(i, i + batchSize));

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const b = batches[next++];
      const userText = b.map(e =>
        `id: ${e.id}\ntitle: ${e.title}\nsource: ${e.domain}\nsummary: ${e.summary}\nanalysis: ${(e.whyBad || '').slice(0, 800)}`,
      ).join('\n\n---\n\n');
      try {
        const raw = await completeText(resolved, SYSTEM, userText, {
          json: true, reasoning: false, temperature: 0.2, timeoutMs: 120000,
        });
        const parsed = safeParse(raw);
        for (const a of (parsed?.assignments ?? [])) {
          if (a && typeof a.id === 'string' && validKeys.has(a.category)) out.set(a.id, a.category);
        }
      } catch (err) {
        log(`  [classify] batch skipped: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return out;
}
