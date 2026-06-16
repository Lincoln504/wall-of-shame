import { createSignal, createResource, For, Show, createMemo, onCleanup, createEffect, onMount, on } from 'solid-js';
import type { FindingsStore, Finding } from './types.js';
import { pipeline, env } from '@huggingface/transformers';
import { canonicalOrder, pageForIndex, totalPages, clampPage, pageSlice } from './order.js';
import { justifyElements, onResizeRejustify } from './justify.js';
import { shareFinding } from './share.js';
import { useVisitCounts, counterEnabled, formatCount } from './counter.js';

// Configuration for transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

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

function cosineSimilarity(v1: number[], v2: number[]): number {
  let dot = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < v1.length; i++) { dot += v1[i] * v2[i]; n1 += v1[i] * v1[i]; n2 += v2[i] * v2[i]; }
  return dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

function FindingCard(props: { finding: Finding; score?: number; sharing: boolean; onShare: (f: Finding) => void }) {
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
      <p style={s.summary}>{f.summary}</p>
      <div style={s.whyBadBox}>
        <div style={s.whyBadLabel}>Analysis</div>
        <p class="wos-justify" style={s.whyBadText}>{f.whyBad}</p>
      </div>
      <div style={s.actions}>
        <button
          style={{ ...s.shareBtn, opacity: props.sharing ? 0.55 : 1 }}
          disabled={props.sharing}
          onClick={() => props.onShare(f)}
          title="Share this entry as an image"
        >
          {props.sharing ? 'Generating…' : 'Share ↗'}
        </button>
      </div>
    </article>
  );
}

let extractor: any = null;

export default function App() {
  const [data] = createResource(fetchFindings);
  const [findingVectors, setFindingVectors] = createSignal<Map<string, number[]>>(new Map());
  const [search, setSearch] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [severity, setSeverity] = createSignal('');
  const [sortOrder, setSortOrder] = createSignal<'shuffled' | 'newest' | 'oldest' | 'severity' | 'semantic'>('shuffled');
  const [showDownload, setShowDownload] = createSignal(false);
  const [isSemanticLoading, setIsSemanticLoading] = createSignal(false);
  const [queryVector, setQueryVector] = createSignal<number[] | null>(null);
  const [sharingId, setSharingId] = createSignal<string | null>(null);

  const counts = useVisitCounts();

  // ── Semantic search (unchanged) ──────────────────────────────────────────────
  createEffect(async () => {
    if (sortOrder() === 'semantic' && !extractor) {
      setIsSemanticLoading(true);
      try {
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'webgpu' as any });
      } catch (err) {
        console.warn('WebGPU failed, falling back to CPU:', err);
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      } finally { setIsSemanticLoading(false); }
    }
  });

  createEffect(async () => {
    if (sortOrder() !== 'semantic' || !extractor) return;
    const d = data();
    if (!d || d.findings.length === 0 || findingVectors().size > 0) return;
    setIsSemanticLoading(true);
    try {
      const texts = d.findings.map(f => `${f.title}. ${f.summary} ${f.whyBad}`);
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const dim = out.dims[out.dims.length - 1] as number;
      const flat = out.data as ArrayLike<number>;
      const map = new Map<string, number[]>();
      d.findings.forEach((f, i) => {
        map.set(f.url, Array.from({ length: dim }, (_, j) => flat[i * dim + j] as number));
      });
      setFindingVectors(map);
    } catch (err) { console.error('Finding embedding failed:', err); }
    finally { setIsSemanticLoading(false); }
  });

  createEffect(async () => {
    const q = search();
    if (sortOrder() === 'semantic' && extractor && q.trim().length > 2) {
      setIsSemanticLoading(true);
      try {
        const output = await extractor(q, { pooling: 'mean', normalize: true });
        setQueryVector(Array.from(output.data as number[]));
      } catch (err) { console.error('Embedding failed:', err); }
      finally { setIsSemanticLoading(false); }
    } else if (q.trim().length <= 2) { setQueryVector(null); }
  });

  const categories = createMemo(() => {
    const d = data();
    if (!d) return [];
    return [...new Set(d.findings.map(f => f.category))].sort();
  });

  const semanticScores = createMemo(() => {
    const qv = queryVector();
    const vecs = findingVectors();
    if (!qv || vecs.size === 0) return new Map<string, number>();
    const scores = new Map<string, number>();
    for (const [url, v] of vecs) scores.set(url, cosineSimilarity(qv, v));
    return scores;
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
    const q = search().toLowerCase();
    const cat = category();
    const sev = severity();
    const scores = semanticScores();
    const order = sortOrder();

    let list: (Finding & { score?: number })[] = d.findings.map(f => ({ ...f, score: scores.get(f.url) }));
    if (cat) list = list.filter(f => f.category === cat);
    if (sev) list = list.filter(f => f.severity === sev);
    if (order !== 'semantic' && q) {
      list = list.filter(f =>
        f.title.toLowerCase().includes(q) ||
        f.summary.toLowerCase().includes(q) ||
        f.whyBad.toLowerCase().includes(q) ||
        f.domain.toLowerCase().includes(q));
    }

    if (order === 'semantic' && queryVector()) {
      return list.filter(f => f.score !== undefined && f.score > 0.1).sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    if (order === 'oldest') return [...list].sort((a, b) => a.foundAt.localeCompare(b.foundAt));
    if (order === 'newest') return [...list].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
    if (order === 'severity') {
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return [...list].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    }
    // default: shuffled = canonical deterministic order
    const ci = canonicalIndex();
    return [...list].sort((a, b) => (ci.get(keyOf(a)) ?? 0) - (ci.get(keyOf(b)) ?? 0));
  });

  // ── Pagination via hash (#/page/N), state-preserving (no router remount) ───────
  const parsePage = () => {
    const m = /#\/page\/(\d+)/.exec(location.hash);
    return m ? Math.max(1, parseInt(m[1], 10)) : 1;
  };
  const [rawPage, setRawPage] = createSignal(parsePage());
  onMount(() => {
    const onHash = () => setRawPage(parsePage());
    window.addEventListener('hashchange', onHash);
    onCleanup(() => window.removeEventListener('hashchange', onHash));
  });
  // Reset to page 1 when the filter/sort changes (but respect the initial URL page).
  createEffect(on([search, category, severity, sortOrder], () => setRawPage(1), { defer: true }));

  const pageCount = createMemo(() => totalPages(filteredList().length));
  const page = createMemo(() => clampPage(rawPage(), filteredList().length));
  const paged = createMemo(() => pageSlice(filteredList(), page()));

  const goToPage = (p: number) => {
    const np = clampPage(p, filteredList().length);
    if (`#/page/${np}` !== location.hash) location.hash = `#/page/${np}`;
    setRawPage(np);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Knuth-Plass justification of the analysis text on each rendered page ───────
  const collectJustifyEls = () => Array.from(document.querySelectorAll('.wos-justify')) as HTMLElement[];
  createEffect(() => {
    paged(); // re-run whenever the visible cards change
    requestAnimationFrame(() => void justifyElements(collectJustifyEls()));
  });
  onMount(() => { const dispose = onResizeRejustify(collectJustifyEls); onCleanup(dispose); });

  // ── Share ─────────────────────────────────────────────────────────────────────
  const handleShare = async (f: Finding) => {
    const id = keyOf(f);
    setSharingId(id);
    try {
      const p = canonicalPage().get(id) ?? 1;
      const pageUrl = `${location.origin}${BASE}#/page/${p}`;
      await shareFinding(f, p, pageUrl);
    } catch (err) {
      console.error('share failed:', err);
    } finally { setSharingId(null); }
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
        <h1 style={s.title}>Wall of Shame</h1>
        <p style={s.subtitle}>
          A repository of web content judged to be socially harmful.
          <br />
          <span style={s.subtitleMuted}>racist, classist, sexist, politically regressive</span>
          <br />
          Made with <a href="https://github.com/Lincoln504/pi-research" style={s.inlineLink} target="_blank" rel="noopener noreferrer">pi-research</a>.
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

      <div style={s.controls}>
        <input type="search" placeholder={sortOrder() === 'semantic' ? 'Semantic search query…' : 'Search…'}
          value={search()} onInput={e => setSearch(e.currentTarget.value)} style={s.searchInput} />
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
          <option value="shuffled">Shuffled</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="severity">By Severity</option>
          <option value="semantic">Semantic (AI)</option>
        </select>
        <div class="download-container" style={s.downloadContainer}>
          <button onClick={() => setShowDownload(!showDownload())} style={s.downloadBtn}>Download ↓</button>
          <Show when={showDownload()}>
            <div style={s.dropdown}>
              <button onClick={downloadCSV} style={s.dropdownItem}>CSV</button>
              <button onClick={downloadJSON} style={s.dropdownItem}>JSON</button>
            </div>
          </Show>
        </div>
      </div>

      <Show when={isSemanticLoading()}>
        <div style={s.semanticLoading}>AI model loading/processing… (uses WebGPU)</div>
      </Show>
      <Show when={data.loading}><div style={s.loading}>Loading…</div></Show>
      <Show when={data.error}><div style={s.error}>Failed to load findings.</div></Show>

      <Show when={data()}>
        <div style={s.resultsBar}>
          {filteredList().length} entries · page {page()} of {pageCount()}
        </div>
        <Show when={filteredList().length === 0}>
          <div style={s.empty}>No entries found.</div>
        </Show>
        <main style={s.grid}>
          <For each={paged()}>
            {item => <FindingCard finding={item} score={item.score} sharing={sharingId() === keyOf(item)} onShare={handleShare} />}
          </For>
        </main>

        <Show when={pageCount() > 1}>
          <Pagination page={page()} pageCount={pageCount()} onGo={goToPage} />
        </Show>
      </Show>

      <footer style={s.footer}>
        Built with{' '}
        <a href="https://github.com/Lincoln504/pi-research" style={s.footerLink} target="_blank" rel="noopener noreferrer">pi-research</a>
        {' '}· Data updated via GitHub Actions
      </footer>
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
const SERIF = `Newsreader, Georgia, "Times New Roman", serif`;

const s: Record<string, any> = {
  root: { 'max-width': '760px', margin: '0 auto', padding: '0 1.5rem 5rem', 'font-family': UI },
  header: { padding: '4rem 0 2rem', 'text-align': 'center' },
  title: { 'font-family': SERIF, 'font-size': '3rem', 'font-weight': '700', 'margin-bottom': '0.75rem', 'letter-spacing': '-0.02em' },
  subtitle: { color: '#666', 'font-size': '1.05rem', 'margin': '0 auto 1.5rem', 'line-height': 1.7, 'max-width': '500px' },
  subtitleMuted: { color: '#a09a8e', 'font-style': 'italic', 'font-family': SERIF },
  inlineLink: { color: '#666', 'text-decoration': 'underline' },
  stats: { display: 'flex', gap: '0.5rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  stat: { 'font-size': '0.72rem', color: '#888', background: '#fff', border: '1px solid #eee', padding: '0.25rem 0.7rem', 'border-radius': '4px', 'font-weight': '500' },
  controls: {
    display: 'flex', gap: '0.5rem', 'flex-wrap': 'wrap', 'margin-bottom': '2rem',
    padding: '1.5rem 0', 'border-top': '1px solid #eee', 'border-bottom': '1px solid #eee',
  },
  searchInput: {
    flex: '1 1 200px', padding: '0.5rem 0.75rem', 'border-radius': '6px',
    border: '1px solid #ddd', background: '#fff', color: '#1a1a1a', 'font-size': '0.9rem', outline: 'none', 'font-family': UI,
  },
  select: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #ddd',
    background: '#fff', color: '#1a1a1a', 'font-size': '0.9rem', cursor: 'pointer', 'font-family': UI,
  },
  downloadContainer: { position: 'relative' },
  downloadBtn: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #1a1a1a',
    background: '#1a1a1a', color: '#fff', 'font-size': '0.9rem', cursor: 'pointer', 'font-weight': '500', 'font-family': UI,
  },
  dropdown: {
    position: 'absolute', top: '100%', right: '0', 'margin-top': '0.5rem', background: '#fff',
    border: '1px solid #ddd', 'border-radius': '6px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.1)', 'z-index': 10,
    display: 'flex', 'flex-direction': 'column', 'min-width': '100px', overflow: 'hidden',
  },
  dropdownItem: { padding: '0.6rem 1rem', background: 'none', border: 'none', 'text-align': 'left', cursor: 'pointer', 'font-size': '0.85rem', color: '#333', 'font-family': UI },
  semanticLoading: { 'font-size': '0.8rem', color: '#ef6c00', 'margin-bottom': '1rem', 'text-align': 'center', 'font-weight': '500' },
  resultsBar: { 'font-size': '0.8rem', color: '#999', 'margin-bottom': '1.5rem', 'text-align': 'center', 'letter-spacing': '0.02em' },
  grid: { display: 'flex', 'flex-direction': 'column', gap: '3rem' },
  loading: { color: '#999', padding: '4rem', 'text-align': 'center' },
  error: { color: '#d32f2f', padding: '2rem', 'text-align': 'center' },
  empty: { color: '#999', padding: '4rem', 'text-align': 'center' },
  card: { background: 'transparent' },
  cardHeader: { display: 'flex', gap: '0.75rem', 'align-items': 'center', 'margin-bottom': '0.85rem' },
  badge: { 'font-size': '0.62rem', 'font-weight': '700', padding: '0.18rem 0.5rem', 'border-radius': '3px', color: '#fff', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' },
  categoryBadge: { 'font-size': '0.68rem', color: '#888', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' },
  scoreBadge: { 'font-size': '0.62rem', color: '#ef6c00', 'font-weight': '700', 'text-transform': 'uppercase' },
  date: { 'font-size': '0.72rem', color: '#bbb', 'margin-left': 'auto' },
  cardTitle: { 'font-family': SERIF, 'font-size': '1.65rem', 'font-weight': '700', 'margin-bottom': '0.4rem', 'line-height': 1.25, 'letter-spacing': '-0.01em' },
  titleLink: { color: '#1a1a1a', 'text-decoration': 'none', 'background-image': 'linear-gradient(#e8e6e0,#e8e6e0)', 'background-position': '0 100%', 'background-size': '100% 1px', 'background-repeat': 'no-repeat' },
  domain: { 'font-family': SERIF, 'font-size': '0.92rem', color: '#a09a8e', 'margin-bottom': '1.1rem', 'font-style': 'italic' },
  summary: { 'font-family': SERIF, 'font-size': '1.08rem', color: '#3a3a3a', 'line-height': 1.6, 'margin-bottom': '1.25rem' },
  whyBadBox: { background: '#fcfbf8', 'border-left': '3px solid #e4e1d9', padding: '1.1rem 1.25rem' },
  whyBadLabel: { 'font-family': UI, 'font-weight': '700', color: '#1a1a1a', 'font-size': '0.7rem', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '0.6rem' },
  whyBadText: { 'font-family': SERIF, 'font-size': '1rem', color: '#444', 'line-height': 1.65, 'text-align': 'justify', hyphens: 'auto', margin: 0 },
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
  footer: { padding: '8rem 0 4rem', 'text-align': 'center', 'font-size': '0.8rem', color: '#ccc', 'border-top': '1px solid #eee', 'margin-top': '4rem' },
  footerLink: { color: '#bbb', 'text-decoration': 'underline' },
};
