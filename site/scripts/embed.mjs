#!/usr/bin/env node
/**
 * embed.mjs — precompute document embeddings for the Wall of Shame semantic search.
 *
 * Runs OFFLINE (Node) so the browser never has to batch-embed the whole corpus
 * (that batch-on-WebGPU path was the source of the "Out of memory / Buffer invalid"
 * cascade). The browser only embeds the single short query at runtime.
 *
 * Model: onnx-community/granite-embedding-small-english-r2-ONNX (IBM Granite, 384-dim,
 * Apache-2.0). Per the model card this is CLS-pooled: use AutoModel + the model's own
 * `sentence_embedding` output + L2 normalize — NOT the mean-pooling feature-extraction
 * pipeline. The browser query path MUST use the identical model + dtype (fp32) so the
 * query and document vectors are directly comparable by cosine similarity.
 *
 * Each document embeds title + summary + analysis together, so a query matches against
 * any of the three. Output: public/embeddings.bin (raw row-major Float32, N x dim) and
 * public/embeddings.meta.json ({ model, dim, count, ids }).
 *
 * Usage: node scripts/embed.mjs
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const DTYPE = 'q8'; // ~47 MB in-browser download for the matching query model (fp32 would be ~190 MB)
const BATCH = 16;

env.allowLocalModels = false; // fetch from the HF hub

function docText(f) {
  const base = `${f.title}. ${f.summary} ${f.whyBad}`;
  const extra = f.directionalBasis ? ` ${f.directionalBasis}` : '';
  return (base + extra).replace(/\s+/g, ' ').trim();
}

async function main() {
  const store = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'findings.json'), 'utf8'));
  const findings = store.findings;
  console.log(`[embed] ${findings.length} findings; loading ${MODEL_ID} (${DTYPE})…`);

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE });

  const vectors = [];
  let dim = 0;
  for (let i = 0; i < findings.length; i += BATCH) {
    const batch = findings.slice(i, i + BATCH);
    const inputs = await tokenizer(batch.map(docText), { padding: true, truncation: true });
    const out = await model(inputs);
    let emb = out.sentence_embedding;
    if (!emb) throw new Error('model output has no `sentence_embedding`; keys=' + Object.keys(out).join(','));
    emb = emb.normalize(2, -1);
    const data = emb.tolist(); // [batchSize][dim]
    for (const row of data) {
      if (!dim) dim = row.length;
      vectors.push(Float32Array.from(row));
    }
    console.log(`[embed]   ${Math.min(i + BATCH, findings.length)}/${findings.length}`);
  }

  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => flat.set(v, i * dim));
  fs.writeFileSync(path.join(PUBLIC, 'embeddings.bin'), Buffer.from(flat.buffer));
  fs.writeFileSync(
    path.join(PUBLIC, 'embeddings.meta.json'),
    JSON.stringify({ model: MODEL_ID, dtype: DTYPE, dim, count: vectors.length, ids: findings.map(f => f.id) }) + '\n',
  );
  console.log(`[embed] wrote embeddings.bin (${vectors.length}×${dim}, ${(flat.byteLength / 1024).toFixed(0)} KB) + embeddings.meta.json`);
}

main().catch(e => { console.error('[embed] FATAL', e); process.exit(1); });
