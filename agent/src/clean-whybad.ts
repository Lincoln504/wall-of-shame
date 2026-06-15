#!/usr/bin/env tsx
/**
 * clean-whybad.ts — one-off normalizer over EXISTING findings.
 *
 * Applies normalizeWhyBad() (the same sanitizer now wired into the write path) to
 * every stored entry, removing leaked raw-response wrappers (```json fences,
 * {"whyBad": ...} objects), leading "Analysis:" labels, and outer "[ ... ]"
 * brackets — all of which were rendering as "Analysis: Analysis: [...]" with
 * literal brackets on the live site.
 *
 * Safety: backs up findings.json before writing and writes atomically. Content is
 * only ever stripped of wrapper/label noise; the numbered analysis is preserved.
 *
 * Usage: npx tsx src/clean-whybad.ts [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './findings.js';
import { normalizeWhyBad } from './utils.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');

interface Finding { title?: string; category?: string; whyBad?: string; [k: string]: unknown }

function main() {
  const store = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8')) as { findings: Finding[] };
  let changed = 0;
  const samples: string[] = [];

  for (const f of store.findings) {
    const before = String(f.whyBad ?? '');
    const after = normalizeWhyBad(before);
    if (after !== before) {
      changed++;
      if (samples.length < 6) {
        samples.push(
          `  [${(f.category ?? '').padEnd(11)}] ${String(f.title ?? '').slice(0, 40)}\n` +
          `      before: ${JSON.stringify(before.slice(0, 60))}\n` +
          `      after:  ${JSON.stringify(after.slice(0, 60))}`,
        );
      }
      f.whyBad = after;
    }
  }

  console.log(`[clean-whybad] ${store.findings.length} entries; ${changed} normalized (dry-run=${DRY_RUN})`);
  samples.forEach(s => console.log(s));

  // Post-condition audit: confirm no entry still carries a label/bracket/fence.
  const residual = store.findings.filter(f => {
    const w = String(f.whyBad ?? '').trim();
    return /^Analysis:/i.test(w) || /```/.test(w) || /"whyBad"\s*:/.test(w) || (w.startsWith('[') && w.endsWith(']'));
  });
  console.log(`[clean-whybad] residual malformed after clean: ${residual.length}`);

  if (DRY_RUN) { console.log('[clean-whybad] dry-run: no file written.'); return; }
  if (changed > 0) {
    copyFileSync(FINDINGS_PATH, FINDINGS_PATH + `.bak-${Date.now()}`);
    const tmp = FINDINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    writeFileSync(FINDINGS_PATH, readFileSync(tmp, 'utf-8'), 'utf-8');
    try { unlinkSync(tmp); } catch { /* best effort */ }
    console.log(`[clean-whybad] wrote ${FINDINGS_PATH} (backup saved).`);
  }
}

main();
