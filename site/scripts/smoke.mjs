// smoke.mjs — production mount smoke test.
//
// Loads the freshly-built bundle into a DOM and asserts the app actually INITIALIZES and
// renders, with no uncaught error. This catches the class of bug that build/tsc cannot:
// runtime init crashes (e.g. a createMemo reading a signal before its declaration → temporal
// dead zone), which only surface when the page is actually executed. Cheap, no browser
// binary, runs after `vite build`. Run with: `npm run smoke` (or `npm run build:check`).
import { JSDOM } from 'jsdom';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'dist', 'assets');

let bundle;
try {
  bundle = readdirSync(assetsDir).find(f => /^index-.*\.js$/.test(f));
} catch {
  console.error('SMOKE FAIL: dist/ not built — run `vite build` first.');
  process.exit(1);
}
if (!bundle) { console.error('SMOKE FAIL: no index-*.js bundle in dist/assets.'); process.exit(1); }

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'https://wallofshame.io/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Minimal honest stubs for the few browser APIs jsdom lacks but the app touches at mount.
// (These are real no-ops, not fakes that hide bugs — the app's own guards handle absence too.)
window.matchMedia ||= (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
window.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver ||= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.scrollTo ||= () => {};

// Expose every DOM global the bundle might read as a bare identifier (document,
// MutationObserver, Node, Element, …). Copy whatever jsdom's window has that the Node
// global scope lacks — never overwrite an existing Node global (so fetch/setTimeout stay),
// and skip read-only getters (e.g. navigator in Node 25).
for (const k of Object.getOwnPropertyNames(window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = window[k]; } catch { /* read-only / non-configurable — leave it */ }
}
try { globalThis.requestAnimationFrame ||= (cb) => setTimeout(() => cb(Date.now()), 0); } catch {}
try { globalThis.cancelAnimationFrame ||= (id) => clearTimeout(id); } catch {}

// Node's fetch rejects relative URLs (e.g. '/findings.json') that a browser resolves against
// the origin. Stub it with a benign empty payload so the app's data resources resolve and it
// renders, instead of failing the smoke for a sandbox-only URL quirk. (Fields cover both the
// findings store and the embeddings meta.)
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ lastUpdated: '', totalFindings: 0, findings: [], dim: 384, ids: [] }),
  arrayBuffer: async () => new ArrayBuffer(0),
  text: async () => '',
});

let initError = null;
window.addEventListener('error', (e) => { initError ||= e.error || new Error(e.message); });
// (A failed relative findings.json fetch rejects a promise the app catches; we only fail on
//  thrown init errors and a missing render, not on expected network rejections in this sandbox.)

try {
  await import(pathToFileURL(join(assetsDir, bundle)).href);
} catch (e) {
  initError ||= e;
}

await new Promise((r) => setTimeout(r, 250)); // let mount + a rAF flush

const rootHtml = window.document.getElementById('root')?.innerHTML ?? '';

if (initError) {
  console.error(`SMOKE FAIL: app threw during initialization:\n  ${initError.stack || initError}`);
  process.exit(1);
}
if (!rootHtml.includes('Wall of Shame')) {
  console.error('SMOKE FAIL: app mounted without throwing but did not render the header (empty/blank app).');
  console.error('  #root length:', rootHtml.length);
  process.exit(1);
}
console.log(`SMOKE OK: ${bundle} mounted, header rendered, no init errors.`);
process.exit(0);
