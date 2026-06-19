/**
 * semantic.ts — lightweight half of client-side semantic search (NO ML dependency).
 *
 * Document vectors are PRECOMPUTED offline (scripts/embed.mjs, granite-r2 q8) and
 * shipped as a static artifact, so the browser never batch-embeds the corpus — that
 * batch-on-WebGPU path was the cause of the "Out of memory / Buffer invalid" cascade.
 *
 * This module only fetches + decodes those vectors, so it carries no transformers.js
 * import and stays in the main bundle. The query embedder (which DOES pull in
 * transformers.js + the ONNX WASM runtime) lives in ./query-embedder and is loaded
 * lazily, only when the visitor actually searches.
 */
export const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';

// ── Query-model cache management (Cache Storage) ─────────────────────────────────
// transformers.js stores model weights in the 'transformers-cache' Cache Storage bucket
// (env.useBrowserCache). These helpers inspect/clear ONLY this model's entries WITHOUT
// importing the heavy ML bundle, so the search-bar "cached" indicator and the
// "clear model" button stay cheap (no 900 KB download just to check a checkbox).
const TRANSFORMERS_CACHE = 'transformers-cache';

/** True if the query model's weights are already in the browser cache (instant load). */
export async function isModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    const keys = await cache.keys();
    return keys.some(req => req.url.includes(MODEL_ID));
  } catch { return false; }
}

/** Delete this model's cached weights. Returns how many cache entries were removed.
 *  The in-memory model (if already loaded this session) keeps working; only the on-disk
 *  copy is removed, so a future cold load re-downloads it. */
export async function clearModelCache(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    const keys = await cache.keys();
    const mine = keys.filter(req => req.url.includes(MODEL_ID));
    await Promise.all(mine.map(req => cache.delete(req)));
    return mine.length;
  } catch { return 0; }
}

// ── Hybrid scoring (keyword + semantic), mirroring pi-research's retrieval ────────
// pi-research fuses a BM25 lexical list and a cosine vector list with Reciprocal Rank
// Fusion (k=60), ranks-not-scores. We do the same client-side over precomputed vectors,
// add a lightweight substring/token-coverage lexical signal (no BM25 index needed), and
// layer an exactness override so an exact keyword hit surfaces as a 100% match while
// semantic-only hits show a graded percentage. Works lexical-only before the query model
// loads, then upgrades to full hybrid once a query vector is available.
const RRF_K = 60;

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g)) ?? [];
}

export interface HybridDoc { id: string; text: string }

function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d;
}

/**
 * Returns id → display score in [0,1]. `queryVector` may be null (lexical-only, used
 * before the model loads). Only docs with any signal are included.
 */
export function computeHybridScores(
  docs: HybridDoc[],
  query: string,
  queryVector: Float32Array | null,
  docVectors: Map<string, Float32Array>,
): Map<string, number> {
  const q = query.trim().toLowerCase();
  const qTokens = [...new Set(tokenize(q))];
  const out = new Map<string, number>();
  if (!q) return out;

  // Lexical signals per doc.
  const lex = docs.map(d => {
    const text = d.text.toLowerCase();
    const exact = q.length >= 2 && text.includes(q);
    const docTokens = new Set(tokenize(text));
    const hit = qTokens.filter(t => docTokens.has(t)).length;
    const coverage = qTokens.length ? hit / qTokens.length : 0;
    return { id: d.id, exact, coverage };
  });

  // Lexical-only mode (query model not ready yet): instant keyword search.
  if (!queryVector || docVectors.size === 0) {
    for (const l of lex) {
      const score = l.exact ? 1 : l.coverage * 0.9;
      if (score > 0) out.set(l.id, score);
    }
    return out;
  }

  // Vector cosine (vectors are L2-normalized, so dot == cosine).
  const cos = new Map<string, number>();
  for (const d of docs) { const v = docVectors.get(d.id); cos.set(d.id, v ? dot(queryVector, v) : 0); }

  // RRF: rank by cosine desc and by lexical (coverage, then exact) desc.
  const byCos = [...docs].sort((a, b) => (cos.get(b.id)! - cos.get(a.id)!));
  const byLex = [...lex].sort((a, b) => (b.coverage - a.coverage) || (Number(b.exact) - Number(a.exact)));
  const rankCos = new Map<string, number>(); byCos.forEach((d, i) => rankCos.set(d.id, i));
  const rankLex = new Map<string, number>(); byLex.forEach((d, i) => rankLex.set(d.id, i));

  const rrf = new Map<string, number>();
  let rMin = Infinity, rMax = -Infinity;
  for (const d of docs) {
    const r = 1 / (RRF_K + rankCos.get(d.id)!) + 1 / (RRF_K + rankLex.get(d.id)!);
    rrf.set(d.id, r); if (r < rMin) rMin = r; if (r > rMax) rMax = r;
  }
  const span = rMax - rMin || 1;
  const lexById = new Map(lex.map(l => [l.id, l]));

  for (const d of docs) {
    const l = lexById.get(d.id)!;
    const rrfNorm = (rrf.get(d.id)! - rMin) / span;
    let display: number;
    if (l.exact) display = 1;                                   // exact keyword hit → 100%
    else if (l.coverage === 1) display = 0.9 + 0.1 * cos.get(d.id)!; // all query terms present
    else display = 0.85 * rrfNorm + 0.15 * l.coverage;          // semantic-led, graded
    out.set(d.id, Math.max(0, Math.min(1, display)));
  }
  return out;
}

/** Load the precomputed document vectors. Returns id → normalized Float32 vector. */
export async function loadDocVectors(base: string): Promise<Map<string, Float32Array>> {
  const [meta, buf] = await Promise.all([
    fetch(`${base}embeddings.meta.json`, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`meta ${r.status}`); return r.json(); }),
    fetch(`${base}embeddings.bin`, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`bin ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const dim: number = meta.dim;
  const ids: string[] = meta.ids;
  const flat = new Float32Array(buf);
  const map = new Map<string, Float32Array>();
  ids.forEach((id, i) => map.set(id, flat.subarray(i * dim, (i + 1) * dim)));
  return map;
}
