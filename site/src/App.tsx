import { createSignal, createResource, For, Show, createMemo, onCleanup, createEffect, onMount, on, ErrorBoundary } from 'solid-js';
import type { FindingsStore, Finding } from './types.js';
import { justifyElements, onResizeRejustify } from './justify.js';
import ShareModal from './ShareModal.js';
import FindingCard from './FindingCard.js';
import Feed from './Feed.js';
import { useVisitCounts, counterEnabled, formatCount } from './counter.js';
import { useInputClass } from './device.js';
import { loadDocVectors, computeHybridScores, isModelCached, clearModelCache } from './semantic.js';
import type { QueryEmbedder } from './query-embedder.js';
import { s, categoryLabel } from './styles.js';

const BASE = import.meta.env.BASE_URL;

// Search shows a single relevance-ranked list capped at this many results (no page-clicking).
// Beyond this, a note invites the reader to refine — nobody scans past the top of a ranked search.
const SEARCH_LIMIT = 50;

async function fetchFindings(): Promise<FindingsStore> {
  // 'no-cache' = always revalidate with the server (cheap 304 when unchanged), so new
  // entries appear on refresh instead of waiting out GitHub Pages' 10-min asset cache.
  const res = await fetch(`${BASE}findings.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load findings: ${res.status}`);
  return res.json() as Promise<FindingsStore>;
}

// "Updated today" / "Updated yesterday" / "Updated M/D/YYYY". Computed in the browser at
// render time against the visitor's local clock, so it stays correct on a static site
// (no server, no rebuild needed) as days pass after the last data push.
function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Updated recently';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86400000;
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / dayMs);
  if (diffDays <= 0) return 'Updated today';
  if (diffDays === 1) return 'Updated yesterday';
  return `Updated ${d.toLocaleDateString()}`;
}

function downloadFile(content: string, fileName: string, contentType: string) {
  const a = document.createElement('a');
  const file = new Blob([content], { type: contentType });
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function jsonToCsv(findings: Finding[]) {
  const headers = ['Title', 'URL', 'Domain', 'Category', 'Severity', 'Found At', 'Summary', 'Why Bad'];
  const rows = findings.map(f => [
    f.title, f.url, f.domain, f.category, f.severity, f.foundAt, f.summary, f.whyBad,
  ].map(val => `"${(val || '').toString().replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export default function App() {
  const [data] = createResource(fetchFindings);
  const [docVectors, setDocVectors] = createSignal<Map<string, Float32Array>>(new Map());
  const [search, setSearch] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [severity, setSeverity] = createSignal('');
  const [showDownload, setShowDownload] = createSignal(false);
  const [modelState, setModelState] = createSignal<'idle' | 'loading' | 'ready'>('idle');
  const [dlProgress, setDlProgress] = createSignal<number | null>(null); // 0–100 while downloading, else null
  const [modelCached, setModelCached] = createSignal(false);             // weights present in Cache Storage
  const [justCleared, setJustCleared] = createSignal(false);             // transient "cleared" confirmation
  const [queryVector, setQueryVector] = createSignal<Float32Array | null>(null);
  const [shareTarget, setShareTarget] = createSignal<{ finding: Finding; page: number; pageUrl: string } | null>(null);

  const counts = useVisitCounts();
  const inputClass = useInputClass(); // 'touch' on mobile → show the swipe affordance hint

  // ── Semantic search ──────────────────────────────────────────────────────────
  // Document vectors are PRECOMPUTED (scripts/embed.mjs, granite-r2 q8) and shipped as
  // a static artifact — the browser never embeds the corpus, only the short query. This
  // is what removes the WebGPU out-of-memory cascade entirely.
  let embedder: QueryEmbedder | null = null;
  onCleanup(() => embedder?.dispose());

  onMount(() => {
    loadDocVectors(BASE)
      .then(setDocVectors)
      .catch(err => console.error('Failed to load precomputed embeddings:', err));
    // Cheap cache probe (no ML bundle) so the "cached" tick shows immediately on load.
    isModelCached().then(setModelCached).catch(() => {});
  });

  // Load the (small, q8, CPU/WASM) query model on first intent to search. The whole ML
  // bundle is dynamically imported here, so visitors who never search never download it —
  // keeping the footprint minimal and the placeholder honest. A progress callback drives
  // the download bar; a fully-cached load jumps straight to 100 and shows no bar.
  // loadGen invalidates an in-flight load if the user clears mid-download: a stale completion
  // must NOT flip the UI back to "ready"/"cached" after a clear (that desync was the source of
  // the post-clear confusion). Every clear bumps the generation; a load only commits if its
  // generation is still current.
  let loadGen = 0;
  const ensureModel = () => {
    if (modelState() !== 'idle') return;
    const gen = ++loadGen;
    setModelState('loading');
    setDlProgress(modelCached() ? null : 0);
    import('./query-embedder.js')
      .then(async m => {
        const inst = new m.QueryEmbedder();
        await inst.load(p => { if (gen === loadGen && p < 100) setDlProgress(p); });
        if (gen !== loadGen) { inst.dispose(); return; } // cleared mid-load → discard
        embedder = inst;
      })
      .then(() => { if (gen !== loadGen) return; setModelState('ready'); setDlProgress(null); setModelCached(true); })
      .catch(err => { if (gen !== loadGen) return; console.error('Query model load failed:', err); setModelState('idle'); setDlProgress(null); });
  };

  // Clear means CLEAR: drop the on-disk weights AND tear down the in-memory model + reset
  // state to idle, so the UI honestly reflects an uncached, unloaded model (no lingering
  // "ready" that reads as "nothing happened"). A future search re-downloads cold. Shows a
  // brief confirmation so the action is legible.
  const clearModel = async () => {
    loadGen++; // invalidate any in-flight load so it can't resurrect "ready"/"cached" after this clear
    await clearModelCache();
    embedder?.dispose();
    embedder = null;
    setModelState('idle');
    setModelCached(false);
    setDlProgress(null);
    setQueryVector(null);
    setJustCleared(true);
    clearTimeout(clearedTimer);
    clearedTimer = setTimeout(() => setJustCleared(false), 2600);
  };
  let clearedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(clearedTimer));

  // Embed the live query (debounced) whenever it or model readiness changes. Keyword
  // results render instantly and un-debounced via hybridScores; only the semantic
  // embedding is debounced so fast typing doesn't queue many embeddings.
  createEffect(() => {
    const q = search().trim();
    const ready = modelState() === 'ready';
    if (q.length > 2) ensureModel();
    if (q.length <= 2) { setQueryVector(null); return; }
    if (!ready || !embedder) return;
    const handle = setTimeout(async () => {
      try { setQueryVector(await embedder!.embed(q)); }
      catch (err) { console.error('Query embedding failed:', err); }
    }, 180);
    onCleanup(() => clearTimeout(handle));
  });

  const hasQuery = createMemo(() => search().trim().length > 2);

  const categories = createMemo(() => {
    const d = data();
    if (!d) return [];
    return [...new Set(d.findings.map(f => f.category))].sort();
  });

  // Hybrid keyword + semantic relevance (RRF k=60, exact keyword → 100%). Works
  // lexical-only before the query model loads, then upgrades to full hybrid.
  const hybridScores = createMemo(() => {
    const d = data();
    if (!d || !hasQuery()) return new Map<string, number>();
    const docs = d.findings.map(f => ({ id: keyOf(f), text: `${f.title} ${f.summary} ${f.whyBad} ${f.domain}` }));
    return computeHybridScores(docs, search(), queryVector(), docVectors());
  });

  const keyOf = (f: Finding) => f.id || f.url;

  // ── View mode ───────────────────────────────────────────────────────────────────
  // Three mutually-exclusive views, mapped from just two routes + a transient query:
  //   feed   — the default (route `/`): a one-card-at-a-time weighted-random feed (Feed.tsx).
  //   search — a query is active: a single relevance-ranked, capped results list (no route).
  //   entry  — route `/<id>`: a single-card permalink, the share-link target.
  // Search replaces the feed in place; clearing the query returns to the feed.
  // NOTE: the `viewMode` memo lives below, AFTER focusId() is declared — createMemo runs its
  // body eagerly on creation, so referencing focusId before its declaration would TDZ-crash.
  type ViewMode = 'feed' | 'search' | 'entry';

  // The feed's candidate pool: the full corpus, narrowed by the category/severity filters
  // (the sequencer handles ordering, so no sort here).
  const feedPool = createMemo<Finding[]>(() => {
    const d = data();
    if (!d) return [];
    const cat = category(), sev = severity();
    let list = d.findings;
    if (cat) list = list.filter(f => f.category === cat);
    if (sev) list = list.filter(f => f.severity === sev);
    return list;
  });

  // ── Search results (only consumed in search mode) ───────────────────────────────
  // One relevance-ranked list (hybrid keyword + semantic, high→low), narrowed by the
  // category/severity filters. cappedResults is what renders; searchResults().length is
  // kept for the "showing top N of M" note.
  const searchResults = createMemo(() => {
    const d = data();
    if (!d || !hasQuery()) return [] as (Finding & { score?: number })[];
    const cat = category();
    const sev = severity();
    const scores = hybridScores();
    let list: (Finding & { score?: number })[] = d.findings
      .map(f => ({ ...f, score: scores.get(keyOf(f)) }))
      .filter(f => f.score !== undefined);
    if (cat) list = list.filter(f => f.category === cat);
    if (sev) list = list.filter(f => f.severity === sev);
    return list.sort((a, b) => (b.score! - a.score!));
  });
  const cappedResults = createMemo(() => searchResults().slice(0, SEARCH_LIMIT));

  // ── Routing via History API (no hash) ─────────────────────────────────────────
  // Two routes only:
  //   /       — the feed (default browsing).
  //   /<id>   — STABLE single-entry permalink at the TOP LEVEL (no /entry/ prefix), resolved by
  //             exact-or-prefix id — the share-link target; id-based so a saved link never rots.
  // Search is a transient query state, never a URL. Real static assets (favicon.svg, qr.svg,
  // assets/, findings.json, …) are served by GitHub Pages directly and never reach this parser;
  // only an unknown path hits 404.html → the SPA, where its first segment is read as an entry id.
  const parseFocus = (): string | null => {
    const rest = location.pathname.slice(BASE.length).replace(/^\/+/, '').split(/[?#]/)[0];
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) return null;          // "/" → feed
    let seg = parts[0];
    if (seg === 'entry') seg = parts[1] ?? '';    // back-compat: old /entry/<id>
    if (!seg || seg === 'page') return null;      // retired /page/N → feed
    return decodeURIComponent(seg);
  };
  const [focusId, setFocusId] = createSignal<string | null>(parseFocus());
  // Declared here (not in the View-mode section above) because createMemo evaluates eagerly
  // and this reads focusId() — it must run after focusId's declaration or it TDZ-crashes.
  const viewMode = createMemo<ViewMode>(() => (focusId() ? 'entry' : hasQuery() ? 'search' : 'feed'));
  // Push a new history entry and sync state immediately (pushState never fires popstate).
  const navigate = (path: string) => {
    history.pushState(null, '', path);
    setFocusId(parseFocus());
  };
  onMount(() => {
    // Normalize links saved under older routing to the clean top-level form: hash share links
    // (#/f/<id>) and the old /entry/<id> path both become /<id>; the retired pagination URLs
    // (/page/N and #/page/N) resolve to the feed.
    const h = window.location.hash;
    const oldHashFocus = /#\/f\/([^/?#]+)/.exec(h);
    const entryPath = /\/entry\/([^/?#]+)/.exec(location.pathname);
    if (oldHashFocus) {
      history.replaceState(null, '', `${BASE}${oldHashFocus[1]}`);
      setFocusId(oldHashFocus[1]);
    } else if (entryPath) {
      history.replaceState(null, '', `${BASE}${entryPath[1]}`);
      setFocusId(entryPath[1]);
    } else if (/#\/page\/\d+/.test(h) || /\/page\/\d+/.test(location.pathname)) {
      history.replaceState(null, '', `${BASE}`);
    }
    const onPop = () => setFocusId(parseFocus());
    window.addEventListener('popstate', onPop);
    onCleanup(() => window.removeEventListener('popstate', onPop));
  });

  // Resolve the focused permalink to a finding (exact id, else short-prefix match).
  const focusedFinding = createMemo<Finding | null>(() => {
    const id = focusId(); const d = data();
    if (!id || !d) return null;
    return d.findings.find(f => f.id === id) ?? d.findings.find(f => (f.id || '').startsWith(id)) ?? null;
  });
  // Jump to the top whenever a permalink is opened.
  createEffect(on(focusId, (id) => { if (id) window.scrollTo({ top: 0 }); }, { defer: true }));
  // Leaving an entry returns to the feed (clearing any query so the feed, not results, shows).
  const clearFocus = () => { setSearch(''); navigate(`${BASE}`); window.scrollTo({ top: 0 }); };
  // Home: clear search + filters and return to the feed.
  const goHome = () => { setSearch(''); setCategory(''); setSeverity(''); navigate(`${BASE}`); window.scrollTo({ top: 0 }); };

  // ── Knuth-Plass justification of the analysis text on each rendered card ───────
  const collectJustifyEls = () => Array.from(document.querySelectorAll('.wos-justify')) as HTMLElement[];
  createEffect(() => {
    cappedResults(); focusedFinding(); // re-run whenever the visible results (or focused entry) change
    requestAnimationFrame(() => void justifyElements(collectJustifyEls()));
  });
  onMount(() => { const dispose = onResizeRejustify(collectJustifyEls); onCleanup(dispose); });

  // ── Share ─────────────────────────────────────────────────────────────────────
  // The shared link is a STABLE per-entry permalink at the TOP LEVEL — /<short id> — short and
  // clean (no /entry/ prefix). The id is assigned once and never changes, so a saved image's link
  // resolves to the same article forever. The ids are UUIDv4; a 6-hex-char prefix is the shortest
  // that stays collision-free past a few thousand entries (measured), and the focused view resolves
  // it by exact-or-prefix match. Older /entry/<id> links still resolve (parseFocus handles them).
  const handleShare = (f: Finding) => {
    const shortId = (f.id || '').slice(0, 6) || encodeURIComponent(keyOf(f));
    const pageUrl = `${location.origin}${BASE}${shortId}`;
    setShareTarget({ finding: f, page: 1, pageUrl });
  };

  // ── Downloads ───────────────────────────────────────────────────────────────
  const downloadJSON = () => { const d = data(); if (!d) return; downloadFile(JSON.stringify(d, null, 2), 'wall-of-shame.json', 'application/json'); setShowDownload(false); };
  const downloadCSV = () => { const d = data(); if (!d) return; downloadFile(jsonToCsv(d.findings), 'wall-of-shame.csv', 'text/csv;charset=utf-8;'); setShowDownload(false); };

  const clickOutside = (e: MouseEvent) => {
    if (showDownload() && !(e.target as HTMLElement).closest('.download-container')) setShowDownload(false);
  };
  window.addEventListener('click', clickOutside);
  onCleanup(() => window.removeEventListener('click', clickOutside));

  return (
    <div style={s.root}>
      <header style={s.header}>
        <a href={`${BASE}page/1`} onClick={e => { e.preventDefault(); goHome(); }} class="wos-home" style={s.homeLink} aria-label="Wall of Shame — home">
          <h1 class="wos-title" style={s.title}>Wall of Shame</h1>
          <img src={`${BASE}favicon.svg?v=17`} alt="" aria-hidden="true" style={s.titleLogo} />
        </a>
        <p style={s.subtitle}>
          Search engine of harmful English language web content.<br />Share what makes you mad!
          <span style={s.subMeta}>
            Information gathered with <span style={s.nowrap}>gemma-4-26b-a4b-it</span> and <span style={s.nowrap}>deepseek-v4-pro</span>.
            <br />
            Made with <a href="https://github.com/Lincoln504/pi-research" style={s.inlineLink} target="_blank" rel="noopener noreferrer">pi-research</a>.
          </span>
        </p>
        <Show when={data()}>
          <div style={s.stats}>
            <span style={s.stat}>{data()!.totalFindings} Entries</span>
            <span style={s.stat}>{formatUpdated(data()!.lastUpdated)}</span>
            <Show when={counterEnabled() && counts()}>
              <span style={s.stat}>{formatCount(counts()!.today)} visits today</span>
            </Show>
          </div>
        </Show>
      </header>

      <Show when={!focusId()}>
      <div style={s.controls}>
        <div style={s.searchRow}>
          <input type="search"
            placeholder={modelState() === 'loading' ? 'Loading…' : 'Search by idea or keyword'}
            value={search()} onInput={e => setSearch(e.currentTarget.value)} style={s.searchInput} />
        </div>
        <Show when={dlProgress() !== null}>
          <div style={s.modelStatusRow}>
            <div style={s.progressTrack}><div style={{ ...s.progressFill, width: `${dlProgress()}%` }} /></div>
            <span style={s.progressPct}>Downloading embedding model… {dlProgress()}%</span>
          </div>
        </Show>
        <Show when={dlProgress() === null && (justCleared() || modelCached() || modelState() === 'ready')}>
          <div style={s.modelStatusRow}>
            <Show
              when={justCleared()}
              fallback={
                <>
                  <span style={s.cacheTick}>Embedding model {modelCached() ? 'cached' : 'ready'}</span>
                  <Show when={modelCached()}>
                    <button type="button" style={s.clearModelBtn} onClick={clearModel}
                      title="Delete the cached model from this browser">Clear</button>
                  </Show>
                </>
              }
            >
              <span style={s.clearedTick}>Embedding model cleared from this browser</span>
            </Show>
          </div>
        </Show>
        <div style={s.filterRow}>
          {/* blur after change so focus leaves the <select> — otherwise the feed's arrow-key
              navigation is suppressed (it ignores keys while a SELECT is focused) and the feed
              feels stuck right after picking a filter. */}
          <select value={category()} onChange={e => { setCategory(e.currentTarget.value); e.currentTarget.blur(); }} style={s.select}>
            <option value="">All categories</option>
            <For each={categories()}>{cat => <option value={cat}>{categoryLabel(cat)}</option>}</For>
          </select>
          <select value={severity()} onChange={e => { setSeverity(e.currentTarget.value); e.currentTarget.blur(); }} style={s.select}>
            <option value="">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      </Show>

      <Show when={data.loading}><div style={s.loading}>Loading…</div></Show>
      <Show when={data.error}><div style={s.error}>Failed to load findings.</div></Show>

      {/* Backstop: any render error in the content area degrades to a graceful inline
          message + manual reload — it never blanks the page or auto-refreshes. */}
      <ErrorBoundary fallback={(_err, reset) => (
        <div style={s.empty}>
          Something went wrong displaying this view.
          <div style={{ 'margin-top': '1rem', display: 'flex', gap: '0.6rem', 'justify-content': 'center' }}>
            <button style={s.backLink} onClick={() => { clearFocus(); reset(); }}>← Back to feed</button>
            <button style={s.backLink} onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      )}>
      <Show when={data()}>
        {/* ── Entry permalink ── */}
        <Show when={viewMode() === 'entry'}>
          {/* keyed: remount on entry change so justify never desyncs a reused card (see Feed.tsx). */}
          <Show
            when={focusedFinding()}
            keyed
            fallback={
              <div style={s.empty}>
                That entry could not be found — it may have been removed.
                <div style={{ 'margin-top': '1rem' }}><button style={s.backLink} onClick={clearFocus}>← All entries</button></div>
              </div>
            }
          >
            {(f) => (
              <>
                <div style={s.backRow}><button style={s.backLink} onClick={clearFocus}>← All entries</button></div>
                <main style={s.grid}>
                  <FindingCard finding={f} onShare={handleShare} variant="feed" />
                </main>
              </>
            )}
          </Show>
        </Show>

        {/* ── Search results (single relevance-ranked, capped list) ── */}
        <Show when={viewMode() === 'search'}>
          <div style={s.sectionLabel}>Results</div>
          <Show when={searchResults().length === 0}>
            <div style={s.empty}>{modelState() === 'loading' ? 'Loading semantic search…' : 'No entries found.'}</div>
          </Show>
          <main style={s.grid}>
            <For each={cappedResults()}>
              {item => <FindingCard finding={item} score={item.score} onShare={handleShare} variant="list" />}
            </For>
          </main>
          <Show when={searchResults().length > SEARCH_LIMIT}>
            <div style={s.resultsNote}>Showing the top {SEARCH_LIMIT} of {searchResults().length} matches — refine your search to narrow it.</div>
          </Show>
        </Show>

        {/* ── Feed (default) ── */}
        <Show when={viewMode() === 'feed'}>
          {/* Mobile has no side arrows, so the section label doubles as the swipe affordance. */}
          <div style={s.sectionLabel}>{inputClass() === 'touch' ? 'Feed — swipe to browse' : 'Feed'}</div>
          <Show
            when={feedPool().length > 0}
            fallback={<div style={s.empty}>No entries found.</div>}
          >
            <Feed findings={feedPool()} onShare={handleShare} />
          </Show>
        </Show>
      </Show>
      </ErrorBoundary>

      {/* The footer (download / QR / "You're reading" / feedback) shows on every view. */}
      <footer style={s.footer}>
        <div style={s.downloadArea} class="download-container">
          <button onClick={() => setShowDownload(!showDownload())} style={s.downloadAreaBtn}>Download all content ↓</button>
          <Show when={showDownload()}>
            <div style={s.dropdown}>
              <button onClick={downloadCSV} style={s.dropdownItem}>CSV</button>
              <button onClick={downloadJSON} style={s.dropdownItem}>JSON</button>
            </div>
          </Show>
        </div>
        <div style={s.footerMain}>
          <img src={`${BASE}favicon.svg?v=17`} alt="" aria-hidden="true" style={s.footerMark} />
          <a href="https://wallofshame.io/" target="_blank" rel="noopener noreferrer" style={s.qrLink} aria-label="Scan to open Wall of Shame">
            <img src={`${BASE}qr.svg`} alt="QR code linking to Wall of Shame" width="72" height="72" style={s.qr} />
          </a>
          <div style={s.footerCta}>
            <span style={s.footerCtaLabel}>You're reading</span>
            <a href="https://wallofshame.io/" style={s.footerUrl}>wallofshame.io</a>
          </div>
        </div>
        <div style={s.feedbackLine}>
          <span>Thoughts? Article review suggestions?</span>
          <span style={s.feedbackArrow} aria-hidden="true">→</span>
          <a href="mailto:feedback@wallofshame.io" style={s.feedbackEmail}>feedback@wallofshame.io</a>
        </div>
      </footer>

      {/* The modal isolates its own errors; this boundary is a final backstop so a share
          failure can never propagate to (and blank) the rest of the page. */}
      <ErrorBoundary fallback={null}>
        <ShareModal
          finding={shareTarget()?.finding ?? null}
          page={shareTarget()?.page ?? 1}
          pageUrl={shareTarget()?.pageUrl ?? ''}
          onClose={() => setShareTarget(null)}
        />
      </ErrorBoundary>
    </div>
  );
}
