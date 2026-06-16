/**
 * query-embedder.ts — the ML half of semantic search (transformers.js + ONNX WASM).
 *
 * Imported DYNAMICALLY (only when the visitor searches) so the ~900 KB of JS and the
 * ONNX WASM runtime never load for visitors who never use search.
 *
 * Embeds ONLY the short query, on the CPU (WASM, single thread): one short embedding is
 * fast on WASM and avoids all WebGPU device-loss/out-of-memory fragility; single-thread
 * avoids the SharedArrayBuffer/COOP-COEP headers GitHub Pages cannot send. Uses the same
 * model + dtype (granite-r2, q8) as the precomputed document vectors so the two are
 * directly comparable by cosine similarity.
 *
 * granite-embedding-small-english-r2 is CLS-pooled: AutoModel + its own
 * `sentence_embedding` output + L2 normalize (NOT mean-pooling feature-extraction).
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { MODEL_ID } from './semantic.js';

const DTYPE = 'q8';

// Minimal, header-free, leak-free runtime configuration.
env.allowLocalModels = false;
env.useBrowserCache = true; // cache weights in Cache Storage so repeat visits are instant
try {
  const wasm = (env.backends as any).onnx.wasm;
  wasm.numThreads = 1;   // no SharedArrayBuffer → no COOP/COEP requirement on GitHub Pages
  wasm.proxy = false;    // run in-thread; nothing to terminate later
  (env.backends as any).onnx.logLevel = 'error'; // silence benign EP-assignment warnings
} catch { /* backends not ready yet; applied on load */ }

export class QueryEmbedder {
  private tokenizer: any = null;
  private model: any = null;
  private loadPromise: Promise<void> | null = null;

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        this.tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
        this.model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'wasm' } as any);
      })();
    }
    return this.loadPromise;
  }

  get ready(): boolean { return !!this.model; }

  async embed(query: string): Promise<Float32Array> {
    await this.load();
    const inputs = await this.tokenizer(query, { padding: true, truncation: true });
    const out = await this.model(inputs);
    const emb = out.sentence_embedding.normalize(2, -1);
    return Float32Array.from(emb.tolist()[0] as number[]);
  }

  dispose(): void {
    try { this.model?.dispose?.(); } catch { /* best effort */ }
    this.model = null; this.tokenizer = null; this.loadPromise = null;
  }
}
