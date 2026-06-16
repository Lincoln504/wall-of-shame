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

/** Load the precomputed document vectors. Returns id → normalized Float32 vector. */
export async function loadDocVectors(base: string): Promise<Map<string, Float32Array>> {
  const [meta, buf] = await Promise.all([
    fetch(`${base}embeddings.meta.json`).then(r => { if (!r.ok) throw new Error(`meta ${r.status}`); return r.json(); }),
    fetch(`${base}embeddings.bin`).then(r => { if (!r.ok) throw new Error(`bin ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const dim: number = meta.dim;
  const ids: string[] = meta.ids;
  const flat = new Float32Array(buf);
  const map = new Map<string, Float32Array>();
  ids.forEach((id, i) => map.set(id, flat.subarray(i * dim, (i + 1) * dim)));
  return map;
}
