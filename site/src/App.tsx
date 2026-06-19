import { createSignal, createResource, For, Show, createMemo, onCleanup, createEffect, onMount, on } from 'solid-js';
import type { FindingsStore, Finding } from './types.js';
import { canonicalOrder, pageForIndex, totalPages, clampPage, pageSlice } from './order.js';
import { justifyElements, onResizeRejustify } from './justify.js';
import { splitAnalysisPoints } from './format.js';
import ShareModal from './ShareModal.js';
import { useVisitCounts, counterEnabled, formatCount } from './counter.js';
import { loadDocVectors, computeHybridScores } from './semantic.js';
import type { QueryEmbedder } from './query-embedder.js';

const BASE = import.meta.env.BASE_URL;

async function fetchFindings(): Promise<FindingsStore> {
  const res = await fetch(`${BASE}findings.json`);
  if (!res.ok) throw new Error(`Failed to load findings: ${res.status}`);
  return res.json() as Promise<FindingsStore>;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: '#d32f2f',
  medium: '#ef6c00',
  low: '#c79a00',
};

function categoryLabel(key: string): string {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

function FindingCard(props: { finding: Finding; score?: number; onShare: (f: Finding) => void }) {
  const f = props.finding;
  const color = SEVERITY_COLOR[f.severity] ?? '#757575';
  const date = f.foundAt ? new Date(f.foundAt).toLocaleDateString() : '';

  return (
    <article style={s.card}>
      <div style={s.cardHeader}>
        <span style={{ ...s.badge, background: color }}>{f.severity}</span>
        <span style={s.categoryBadge}>{categoryLabel(f.category)}</span>
        <Show when={props.score !== undefined}>
          <span style={s.scoreBadge}>Match {Math.round(props.score! * 100)}%</span>
        </Show>
        <span style={s.date}>{date}</span>
      </div>
      <h3 style={s.cardTitle}>
        <a href={f.url} target="_blank" rel="noopener noreferrer" style={s.titleLink}>{f.title}</a>
      </h3>
      <div style={s.domain}>{f.domain}</div>
      <p class="wos-justify" style={s.summaryText}>{f.summary}</p>
      <div style={s.whyBadBox}>
        <div style={s.whyBadLabel}>Analysis</div>
        <For each={splitAnalysisPoints(f.whyBad)}>
          {pt => <p style={s.whyBadText}>{pt}</p>}
        </For>
      </div>
      <div style={s.actions}>
        <button style={s.shareBtn} onClick={() => props.onShare(f)} title="Share this entry as an image">
          Share ↗
        </button>
      </div>
    </article>
  );
}

export default function App() {
  const [data] = createResource(fetchFindings);
  const [docVectors, setDocVectors] = createSignal<Map<string, Float32Array>>(new Map());
  const [search, setSearch] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [severity, setSeverity] = createSignal('');
  // Sorting controls the order ONLY when there is no search query; search is always semantic.
  // The default ('newest') IS the canonical order: newest arrival batch on top, de-clustered
  // within each batch, every entry locked in place (see order.ts). 'oldest' is that same order
  // reversed; 'severity' groups by severity. There is no separate "shuffled" mode — the shuffle
  // is baked into the default so latest entries always stack on top without same-category runs.
  const [sortOrder, setSortOrder] = createSignal<'newest' | 'oldest' | 'severity'>('newest');
  const [showDownload, setShowDownload] = createSignal(false);
  const [modelState, setModelState] = createSignal<'idle' | 'loading' | 'ready'>('idle');
  const [queryVector, setQueryVector] = createSignal<Float32Array | null>(null);
  const [shareTarget, setShareTarget] = createSignal<{ finding: Finding; page: number; pageUrl: string } | null>(null);

  const counts = useVisitCounts();

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
  });

  // Load the (small, q8, CPU/WASM) query model on first intent to search. The whole ML
  // bundle is dynamically imported here, so visitors who never search never download it —
  // keeping the footprint minimal and the placeholder honest.
  const ensureModel = () => {
    if (modelState() !== 'idle') return;
    setModelState('loading');
    import('./query-embedder.js')
      .then(async m => { embedder = new m.QueryEmbedder(); await embedder.load(); })
      .then(() => setModelState('ready'))
      .catch(err => { console.error('Query model load failed:', err); setModelState('idle'); });
  };

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

  // ── Canonical deterministic order (for default view + stable share-page links) ─
  const canonical = createMemo(() => canonicalOrder(data()?.findings ?? []));
  const canonicalIndex = createMemo(() => {
    const m = new Map<string, number>();
    canonical().forEach((f, i) => m.set(f.id || f.url, i));
    return m;
  });
  const canonicalPage = createMemo(() => {
    const m = new Map<string, number>();
    canonical().forEach((f, i) => m.set(f.id || f.url, pageForIndex(i)));
    return m;
  });

  const keyOf = (f: Finding) => f.id || f.url;

  // ── Filter + order ────────────────────────────────────────────────────────────
  const filteredList = createMemo(() => {
    const d = data();
    if (!d) return [] as (Finding & { score?: number })[];
    const cat = category();
    const sev = severity();
    const scores = hybridScores();
    const order = sortOrder();

    let list: (Finding & { score?: number })[] = d.findings.map(f => ({ ...f, score: scores.get(keyOf(f)) }));
    if (cat) list = list.filter(f => f.category === cat);
    if (sev) list = list.filter(f => f.severity === sev);

    // Hybrid search: keep only entries with a relevance score, ranked high→low. Before
    // the model loads this is keyword-only (exact/partial matches); once it loads, every
    // entry gets a semantic score so the full corpus ranks.
    if (hasQuery()) {
      return list.filter(f => f.score !== undefined).sort((a, b) => (b.score! - a.score!));
    }
    if (order === 'severity') {
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return [...list].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    }
    // 'newest' (default) = canonical order (newest batch on top, de-clustered, locked).
    // 'oldest' = that same canonical order reversed (oldest batch on top, still de-clustered).
    const ci = canonicalIndex();
    const dir = order === 'oldest' ? -1 : 1;
    return [...list].sort((a, b) => dir * ((ci.get(keyOf(a)) ?? 0) - (ci.get(keyOf(b)) ?? 0)));
  });

  // ── Routing via History API (no hash) ─────────────────────────────────────────
  //   /page/N     — pagination
  //   /entry/<id> — STABLE permalink to a single entry (resolved by exact-or-prefix id),
  //                 so a link saved from a share card always finds the same article even
  //                 as pagination shifts under it.
  const parsePage = () => {
    const m = /\/page\/(\d+)/.exec(location.pathname);
    return m ? Math.max(1, parseInt(m[1], 10)) : 1;
  };
  const parseFocus = (): string | null => {
    const m = /\/entry\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const [rawPage, setRawPage] = createSignal(parsePage());
  const [focusId, setFocusId] = createSignal<string | null>(parseFocus());
  // Push a new history entry and sync signals immediately (pushState never fires popstate).
  const navigate = (path: string) => {
    history.pushState(null, '', path);
    setRawPage(parsePage());
    setFocusId(parseFocus());
  };
  onMount(() => {
    // Migrate old hash-based share links saved before the routing change.
    const h = window.location.hash;
    const oldFocus = /#\/f\/([^/?#]+)/.exec(h);
    const oldPage = /#\/page\/(\d+)/.exec(h);
    if (oldFocus) {
      history.replaceState(null, '', `${BASE}entry/${oldFocus[1]}`);
      setFocusId(oldFocus[1]);
    } else if (oldPage) {
      history.replaceState(null, '', `${BASE}page/${oldPage[1]}`);
      setRawPage(parseInt(oldPage[1], 10));
    }
    const onPop = () => { setRawPage(parsePage()); setFocusId(parseFocus()); };
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
  const clearFocus = () => {
    if (!/\/entry\//.test(location.pathname)) return;
    const f = focusedFinding();
    const targetPage = f ? (canonicalPage().get(keyOf(f)) ?? 1) : 1;
    navigate(`${BASE}page/${targetPage}`);
  };
  // Reset to page 1 when the filter/sort changes (but respect the initial URL page).
  createEffect(on([search, category, severity, sortOrder], () => setRawPage(1), { defer: true }));

  const pageCount = createMemo(() => totalPages(filteredList().length));
  const page = createMemo(() => clampPage(rawPage(), filteredList().length));
  const paged = createMemo(() => pageSlice(filteredList(), page()));

  const goToPage = (p: number) => {
    const np = clampPage(p, filteredList().length);
    if (`${BASE}page/${np}` !== location.pathname) navigate(`${BASE}page/${np}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Home: from any page or entry, clear filters and return to page 1 (the landing view).
  const goHome = () => {
    setSearch(''); setCategory(''); setSeverity(''); setSortOrder('newest');
    navigate(`${BASE}page/1`);
    window.scrollTo({ top: 0 });
  };

  // ── Knuth-Plass justification of the analysis text on each rendered page ───────
  const collectJustifyEls = () => Array.from(document.querySelectorAll('.wos-justify')) as HTMLElement[];
  createEffect(() => {
    paged(); focusedFinding(); // re-run whenever the visible cards (or focused entry) change
    requestAnimationFrame(() => void justifyElements(collectJustifyEls()));
  });
  onMount(() => { const dispose = onResizeRejustify(collectJustifyEls); onCleanup(dispose); });

  // ── Share ─────────────────────────────────────────────────────────────────────
  // The shared link is a STABLE per-entry permalink (/entry/<short id>), NOT a page number:
  // page numbers drift as the corpus grows, so an old /page/N would later point at the
  // wrong entry. The id is assigned once and never changes, so a saved image's link keeps
  // resolving to the same article forever. The ids are UUIDv4; a 6-hex-char prefix is the
  // shortest that stays collision-free past a few thousand entries (measured), so it keeps
  // links short while the focused view resolves them by exact-or-prefix match. Older 8-char
  // links still resolve (a longer prefix still uniquely starts-with the full id).
  const handleShare = (f: Finding) => {
    const shortId = (f.id || '').slice(0, 6) || encodeURIComponent(keyOf(f));
    const pageUrl = `${location.origin}${BASE}entry/${shortId}`;
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
        <a href={`${BASE}page/1`} onClick={e => { e.preventDefault(); goHome(); }} style={s.homeLink} aria-label="Wall of Shame — home">
          <h1 style={s.title}>Wall of Shame</h1>
        </a>
        <p style={s.subtitle}>
          English language search engine of web content judged harmful.
          <span style={s.subMeta}>
            <br />
            Powered by IBM <span style={s.nowrap}>granite-embedding-small-english-r2</span>.
            <br />
            Made with <a href="https://github.com/Lincoln504/pi-research" style={s.inlineLink} target="_blank" rel="noopener noreferrer">pi-research</a>.
          </span>
        </p>
        <Show when={data()}>
          <div style={s.stats}>
            <span style={s.stat}>{data()!.totalFindings} Entries</span>
            <span style={s.stat}>{categories().length} Categories</span>
            <Show when={counterEnabled() && counts()}>
              <span style={s.stat}>{formatCount(counts()!.total)} Visits</span>
              <span style={s.stat}>{formatCount(counts()!.today)} Today</span>
            </Show>
            <span style={s.stat}>Updated {new Date(data()!.lastUpdated).toLocaleDateString()}</span>
          </div>
        </Show>
      </header>

      <Show when={!focusId()}>
      <div style={s.controls}>
        <input type="search"
          placeholder={modelState() === 'loading' ? 'Loading search model…' : 'Search entries…'}
          value={search()} onFocus={ensureModel} onInput={e => setSearch(e.currentTarget.value)} style={s.searchInput} />
        <div style={s.filterRow}>
          <select value={category()} onChange={e => setCategory(e.currentTarget.value)} style={s.select}>
            <option value="">All categories</option>
            <For each={categories()}>{cat => <option value={cat}>{categoryLabel(cat)}</option>}</For>
          </select>
          <select value={severity()} onChange={e => setSeverity(e.currentTarget.value)} style={s.select}>
            <option value="">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={sortOrder()} onChange={e => setSortOrder(e.currentTarget.value as any)} style={s.select}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="severity">By Severity</option>
          </select>
        </div>
      </div>
      </Show>

      <Show when={data.loading}><div style={s.loading}>Loading…</div></Show>
      <Show when={data.error}><div style={s.error}>Failed to load findings.</div></Show>

      <Show when={data()}>
        <Show
          when={!focusId()}
          fallback={
            <Show
              when={focusedFinding()}
              fallback={
                <div style={s.empty}>
                  That entry could not be found — it may have been removed.
                  <div style={{ 'margin-top': '1rem' }}><button style={s.backLink} onClick={clearFocus}>← All entries</button></div>
                </div>
              }
            >
              <div style={s.backRow}><button style={s.backLink} onClick={clearFocus}>← All entries</button></div>
              <main style={s.grid}>
                <FindingCard finding={focusedFinding()!} onShare={handleShare} />
              </main>
            </Show>
          }
        >
          <div style={s.resultsBar}>
            {filteredList().length} entries · page {page()} of {pageCount()}
          </div>
          <Show when={filteredList().length === 0}>
            <div style={s.empty}>{hasQuery() && modelState() === 'loading' ? 'Loading semantic search…' : 'No entries found.'}</div>
          </Show>
          <main style={s.grid}>
            <For each={paged()}>
              {item => <FindingCard finding={item} score={item.score} onShare={handleShare} />}
            </For>
          </main>

          <Show when={pageCount() > 1}>
            <Pagination page={page()} pageCount={pageCount()} onGo={goToPage} />
          </Show>
        </Show>
      </Show>

      <div style={s.downloadArea} class="download-container">
        <button onClick={() => setShowDownload(!showDownload())} style={s.downloadAreaBtn}>Download content ↓</button>
        <Show when={showDownload()}>
          <div style={s.dropdown}>
            <button onClick={downloadCSV} style={s.dropdownItem}>CSV</button>
            <button onClick={downloadJSON} style={s.dropdownItem}>JSON</button>
          </div>
        </Show>
      </div>

      <Show when={data()}>
        <footer style={s.footer}>
          <div style={s.footerText}>
            English language search engine of web content judged harmful.
            {' '}Powered by IBM <span style={s.nowrap}>granite-embedding-small-english-r2</span>.
            {' '}Made with{' '}
            <a href="https://github.com/Lincoln504/pi-research" style={s.footerLink} target="_blank" rel="noopener noreferrer">pi-research</a>
            {' '}· Data updated via GitHub Actions
          </div>
          <a href="https://lincoln504.github.io/wall-of-shame/" target="_blank" rel="noopener noreferrer" style={s.qrLink} aria-label="Scan to open Wall of Shame">
            <img src={`${import.meta.env.BASE_URL}qr.svg`} alt="QR code linking to Wall of Shame" width="80" height="80" style={s.qr} />
          </a>
        </footer>
      </Show>

      <ShareModal
        finding={shareTarget()?.finding ?? null}
        page={shareTarget()?.page ?? 1}
        pageUrl={shareTarget()?.pageUrl ?? ''}
        onClose={() => setShareTarget(null)}
      />
    </div>
  );
}

function Pagination(props: { page: number; pageCount: number; onGo: (p: number) => void }) {
  const windowed = createMemo(() => {
    const { page, pageCount } = props;
    const out: number[] = [];
    const lo = Math.max(1, page - 2);
    const hi = Math.min(pageCount, page + 2);
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  });
  return (
    <nav style={s.pagination}>
      <button style={s.pageBtn} disabled={props.page <= 1} onClick={() => props.onGo(props.page - 1)}>‹ Prev</button>
      <Show when={!windowed().includes(1)}>
        <button style={s.pageBtn} onClick={() => props.onGo(1)}>1</button>
        <span style={s.pageEllipsis}>…</span>
      </Show>
      <For each={windowed()}>
        {p => (
          <button
            style={{ ...s.pageBtn, ...(p === props.page ? s.pageBtnActive : {}) }}
            onClick={() => props.onGo(p)}
          >{p}</button>
        )}
      </For>
      <Show when={!windowed().includes(props.pageCount)}>
        <span style={s.pageEllipsis}>…</span>
        <button style={s.pageBtn} onClick={() => props.onGo(props.pageCount)}>{props.pageCount}</button>
      </Show>
      <button style={s.pageBtn} disabled={props.page >= props.pageCount} onClick={() => props.onGo(props.page + 1)}>Next ›</button>
    </nav>
  );
}

// ── Inline styles ────────────────────────────────────────────────────────────

const UI = `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
// Reverted to sans-serif per direction: headings/body all use the Inter (sans) stack.
const SERIF = UI;

const s: Record<string, any> = {
  root: { 'max-width': '760px', margin: '0 auto', padding: '0 1.5rem 5rem', 'font-family': UI, 'min-height': '100vh' },
  header: { padding: '4rem 0 2rem', 'text-align': 'center' },
  title: { 'font-family': SERIF, 'font-size': '3rem', 'font-weight': '700', 'margin-bottom': '0.75rem', 'letter-spacing': '-0.02em' },
  homeLink: { 'text-decoration': 'none', color: 'inherit', cursor: 'pointer', display: 'inline-block' },
  subtitle: { color: '#555', 'font-size': '1.05rem', 'font-weight': '400', 'margin': '0 auto 1.5rem', 'line-height': 1.7, 'max-width': '640px' },
  subMeta: { 'font-size': '0.8rem', color: '#999' },
  nowrap: { 'white-space': 'nowrap' },
  inlineLink: { color: '#666', 'text-decoration': 'underline' },
  stats: { display: 'flex', gap: '0.5rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  stat: { 'font-size': '0.72rem', color: '#888', background: '#fff', border: '1px solid #eee', padding: '0.25rem 0.7rem', 'border-radius': '4px', 'font-weight': '500' },
  controls: {
    display: 'flex', 'flex-direction': 'column', gap: '0.65rem', 'margin-bottom': '2rem',
    padding: '1.5rem 0', 'border-top': '1px solid #eee', 'border-bottom': '1px solid #eee',
  },
  filterRow: { display: 'flex', gap: '0.5rem', 'flex-wrap': 'wrap' },
  searchInput: {
    width: '100%', 'box-sizing': 'border-box', padding: '0.75rem 1.1rem', 'border-radius': '8px',
    border: '1.5px solid #ccc', background: '#fff', color: '#1a1a1a', 'font-size': '1.05rem',
    outline: 'none', 'font-family': UI,
    'box-shadow': '0 2px 8px rgba(0,0,0,0.06)',
  },
  select: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #ddd',
    background: '#fff', color: '#1a1a1a', 'font-size': '0.9rem', cursor: 'pointer', 'font-family': UI,
  },
  downloadArea: { position: 'relative', 'text-align': 'center', 'margin-top': '3rem', 'margin-bottom': '1rem' },
  downloadAreaBtn: {
    padding: '0.45rem 1rem', 'border-radius': '6px', border: '1px solid #ccc',
    background: '#faf9f6', color: '#888', 'font-size': '0.8rem', cursor: 'pointer', 'font-weight': '500', 'font-family': UI,
  },
  dropdown: {
    position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', 'margin-top': '0.4rem', background: '#fff',
    border: '1px solid #ddd', 'border-radius': '6px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.1)', 'z-index': 10,
    display: 'flex', 'flex-direction': 'column', 'min-width': '100px', overflow: 'hidden',
  },
  dropdownItem: { padding: '0.6rem 1rem', background: 'none', border: 'none', 'text-align': 'left', cursor: 'pointer', 'font-size': '0.85rem', color: '#333', 'font-family': UI },
  semanticLoading: { 'font-size': '0.8rem', color: '#ef6c00', 'margin-bottom': '1rem', 'text-align': 'center', 'font-weight': '500' },
  resultsBar: { 'font-size': '0.8rem', color: '#999', 'margin-bottom': '1.5rem', 'text-align': 'center', 'letter-spacing': '0.02em' },
  grid: { display: 'flex', 'flex-direction': 'column', gap: '1.25rem' },
  loading: { color: '#999', padding: '4rem', 'text-align': 'center' },
  error: { color: '#d32f2f', padding: '2rem', 'text-align': 'center' },
  empty: { color: '#999', padding: '4rem', 'text-align': 'center' },
  card: {
    background: '#fff', 'border-radius': '10px', border: '1px solid #ebe9e3',
    padding: '1.4rem 1.6rem',
    'box-shadow': '0 2px 10px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
  },
  cardHeader: { display: 'flex', gap: '0.75rem', 'align-items': 'center', 'margin-bottom': '0.85rem' },
  badge: { 'font-size': '0.62rem', 'font-weight': '700', padding: '0.18rem 0.5rem', 'border-radius': '3px', color: '#fff', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' },
  categoryBadge: { 'font-size': '0.68rem', color: '#888', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' },
  scoreBadge: { 'font-size': '0.62rem', color: '#ef6c00', 'font-weight': '700', 'text-transform': 'uppercase' },
  date: { 'font-size': '0.72rem', color: '#bbb', 'margin-left': 'auto' },
  cardTitle: { 'font-family': SERIF, 'font-size': '1.65rem', 'font-weight': '700', 'margin-bottom': '0.4rem', 'line-height': 1.25, 'letter-spacing': '-0.01em' },
  titleLink: { color: '#1a1a1a', 'text-decoration': 'none', 'background-image': 'linear-gradient(#e8e6e0,#e8e6e0)', 'background-position': '0 100%', 'background-size': '100% 1px', 'background-repeat': 'no-repeat' },
  domain: { 'font-family': SERIF, 'font-size': '0.92rem', color: '#a09a8e', 'margin-bottom': '1.1rem', 'font-style': 'italic' },
  summaryText: { 'font-family': SERIF, 'font-size': '1.05rem', color: '#3a3a3a', 'line-height': 1.6, 'text-align': 'justify', hyphens: 'auto', margin: '0 0 1.25rem' },
  whyBadBox: { background: '#fcfbf8', 'border-left': '3px solid #e4e1d9', padding: '1.1rem 1.25rem' },
  whyBadLabel: { 'font-family': UI, 'font-weight': '700', color: '#1a1a1a', 'font-size': '0.7rem', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '0.6rem' },
  whyBadText: { 'font-family': SERIF, 'font-size': '0.95rem', color: '#444', 'line-height': 1.65, 'text-align': 'left', margin: '0 0 0.7rem' },
  actions: { display: 'flex', 'justify-content': 'flex-end', 'margin-top': '0.85rem' },
  shareBtn: {
    'font-family': UI, 'font-size': '0.78rem', 'font-weight': '600', color: '#1a1a1a',
    background: '#fff', border: '1px solid #ddd', 'border-radius': '6px', padding: '0.4rem 0.85rem', cursor: 'pointer',
  },
  pagination: { display: 'flex', 'flex-wrap': 'wrap', gap: '0.35rem', 'justify-content': 'center', 'align-items': 'center', 'margin-top': '4rem' },
  pageBtn: {
    'font-family': UI, 'font-size': '0.85rem', 'min-width': '2.1rem', padding: '0.4rem 0.6rem',
    border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', 'border-radius': '6px', cursor: 'pointer',
  },
  pageBtnActive: { background: '#1a1a1a', color: '#fff', 'border-color': '#1a1a1a', 'font-weight': '700' },
  pageEllipsis: { color: '#bbb', padding: '0 0.2rem' },
  backRow: { 'margin-bottom': '1.5rem' },
  backLink: { 'font-family': UI, 'font-size': '0.85rem', 'font-weight': '600', color: '#666', background: 'none', border: 'none', padding: '0', cursor: 'pointer' },
  footer: { padding: '8rem 0 4rem', display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '1.5rem', 'flex-wrap': 'wrap', 'font-size': '0.8rem', color: '#ccc', 'border-top': '1px solid #eee', 'margin-top': '4rem' },
  footerText: { 'max-width': '420px', 'text-align': 'left', 'line-height': 1.6 },
  footerLink: { color: '#bbb', 'text-decoration': 'underline' },
  qrLink: { 'flex-shrink': 0, 'line-height': 0 },
  qr: { display: 'block', width: '80px', height: '80px', 'border-radius': '6px' },
};
