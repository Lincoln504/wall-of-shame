import { createSignal, createResource, For, Show, createMemo, onCleanup } from 'solid-js';
import type { FindingsStore, Finding } from './types.js';

const BASE = import.meta.env.BASE_URL;

async function fetchFindings(): Promise<FindingsStore> {
  const res = await fetch(`${BASE}findings.json`);
  if (!res.ok) throw new Error(`Failed to load findings: ${res.status}`);
  return res.json() as Promise<FindingsStore>;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: '#d32f2f',
  medium: '#ef6c00',
  low: '#fbc02d',
};

const CATEGORY_LABELS: Record<string, string> = {
  union_busting: 'Anti-Labor',
  trickle_down: 'Trickle-Down',
  billionaire_worship: 'Billionaire Worship',
  gig_exploitation: 'Gig Exploitation',
  poverty_blaming: 'Poverty Blaming',
  child_labor: 'Child Labor',
  race_science: 'Race Pseudoscience',
  colorblind_racism: 'Colorblind Racism',
  great_replacement: 'Replacement Theory',
  confederate_apologia: 'Confederate Apologia',
  redpill_misogyny: 'Misogyny / Redpill',
  pay_gap_denial: 'Pay Gap Denial',
  trans_panic: 'Trans Panic',
  conversion_therapy: 'Conversion Therapy',
  climate_denial: 'Climate Denial',
  greenwashing: 'Greenwashing',
  vaccine_disinfo: 'Vaccine Disinfo',
  alt_medicine_scams: 'Alt-Medicine Scams',
  voter_suppression: 'Voter Suppression',
  autocrat_admiration: 'Autocrat Admiration',
  surveillance_normalization: 'Surveillance',
  police_apologia: 'Police Apologia',
  prison_labor: 'Prison Labor',
  false_equivalence: 'False Equivalence',
  think_tank_astroturfing: 'Astroturfing',
  social_media_addiction_defense: 'Social Media Harms',
  ai_ethics_dismissal: 'AI Ethics Dismissal',
  colonialism_revisionism: 'Colonialism Revisionism',
  indigenous_rights_denial: 'Indigenous Rights Denial',
  christian_nationalism: 'Christian Nationalism',
  ableism: 'Ableism',
  meritocracy_myth: 'Meritocracy Myth',
  dark_money_normalization: 'Dark Money',
  islamophobia: 'Islamophobia',
};

function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? key.replace(/_/g, ' ');
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
    f.title,
    f.url,
    f.domain,
    f.category,
    f.severity,
    f.foundAt,
    f.summary,
    f.whyBad
  ].map(val => `"${(val || '').toString().replace(/"/g, '""')}"`).join(','));
  
  return [headers.join(','), ...rows].join('\n');
}

function FindingCard(props: { finding: Finding }) {
  const f = props.finding;
  const color = SEVERITY_COLOR[f.severity] ?? '#757575';
  const date = f.foundAt ? new Date(f.foundAt).toLocaleDateString() : '';

  return (
    <article style={s.card}>
      <div style={s.cardHeader}>
        <span style={{ ...s.badge, background: color }}>{f.severity}</span>
        <span style={s.categoryBadge}>{categoryLabel(f.category)}</span>
        <span style={s.date}>{date}</span>
      </div>
      <h3 style={s.cardTitle}>
        <a href={f.url} target="_blank" rel="noopener noreferrer" style={s.titleLink}>
          {f.title}
        </a>
      </h3>
      <div style={s.domain}>{f.domain}</div>
      <p style={s.summary}>{f.summary}</p>
      <div style={s.whyBadBox}>
        <span style={s.whyBadLabel}>Analysis: </span>
        {f.whyBad}
      </div>
    </article>
  );
}

export default function App() {
  const [data] = createResource(fetchFindings);
  const [search, setSearch] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [severity, setSeverity] = createSignal('');
  const [sortOrder, setSortOrder] = createSignal<'newest' | 'oldest' | 'severity'>('newest');
  const [showDownload, setShowDownload] = createSignal(false);

  const categories = createMemo(() => {
    const d = data();
    if (!d) return [];
    return [...new Set(d.findings.map(f => f.category))].sort();
  });

  const filtered = createMemo(() => {
    const d = data();
    if (!d) return [];
    const q = search().toLowerCase();
    const cat = category();
    const sev = severity();

    let list = d.findings;
    if (cat) list = list.filter(f => f.category === cat);
    if (sev) list = list.filter(f => f.severity === sev);
    if (q) list = list.filter(f =>
      f.title.toLowerCase().includes(q) ||
      f.summary.toLowerCase().includes(q) ||
      f.whyBad.toLowerCase().includes(q) ||
      f.domain.toLowerCase().includes(q)
    );

    const order = sortOrder();
    if (order === 'oldest') return [...list].sort((a, b) => a.foundAt.localeCompare(b.foundAt));
    if (order === 'severity') {
      const rank = { high: 0, medium: 1, low: 2 };
      return [...list].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    }
    return [...list].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  });

  const downloadJSON = () => {
    const d = data();
    if (!d) return;
    const content = JSON.stringify(d, null, 2);
    downloadFile(content, 'wall-of-shame.json', 'application/json');
    setShowDownload(false);
  };

  const downloadCSV = () => {
    const d = data();
    if (!d) return;
    const content = jsonToCsv(d.findings);
    downloadFile(content, 'wall-of-shame.csv', 'text/csv;charset=utf-8;');
    setShowDownload(false);
  };

  // Close dropdown on outside click
  const clickOutside = (e: MouseEvent) => {
    if (showDownload() && !(e.target as HTMLElement).closest('.download-container')) {
      setShowDownload(false);
    }
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
          (racist, classist, sexist, politically regressive)
          <br />
          Made with <a href="https://github.com/Lincoln504/pi-research" style={s.inlineLink} target="_blank" rel="noopener noreferrer">pi-research</a>.
        </p>
        <Show when={data()}>
          <div style={s.stats}>
            <span style={s.stat}>{data()!.totalFindings} Entries</span>
            <span style={s.stat}>{categories().length} Categories</span>
            <span style={s.stat}>
              Last updated {new Date(data()!.lastUpdated).toLocaleDateString()}
            </span>
          </div>
        </Show>
      </header>

      <div style={s.controls}>
        <input
          type="search"
          placeholder="Search..."
          value={search()}
          onInput={e => setSearch(e.currentTarget.value)}
          style={s.searchInput}
        />
        <select value={category()} onChange={e => setCategory(e.currentTarget.value)} style={s.select}>
          <option value="">All categories</option>
          <For each={categories()}>
            {cat => <option value={cat}>{categoryLabel(cat)}</option>}
          </For>
        </select>
        <select value={severity()} onChange={e => setSeverity(e.currentTarget.value)} style={s.select}>
          <option value="">All severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={sortOrder()} onChange={e => setSortOrder(e.currentTarget.value as 'newest' | 'oldest' | 'severity')} style={s.select}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="severity">By Severity</option>
        </select>
        
        <div class="download-container" style={s.downloadContainer}>
          <button onClick={() => setShowDownload(!showDownload())} style={s.downloadBtn}>
            Download ↓
          </button>
          <Show when={showDownload()}>
            <div style={s.dropdown}>
              <button onClick={downloadCSV} style={s.dropdownItem}>CSV</button>
              <button onClick={downloadJSON} style={s.dropdownItem}>JSON</button>
            </div>
          </Show>
        </div>
      </div>

      <Show when={data.loading}>
        <div style={s.loading}>Loading...</div>
      </Show>

      <Show when={data.error}>
        <div style={s.error}>Failed to load findings.</div>
      </Show>

      <Show when={data()}>
        <div style={s.resultsBar}>
          Showing {filtered().length} findings
        </div>
        <Show when={filtered().length === 0}>
          <div style={s.empty}>No entries found.</div>
        </Show>
        <main style={s.grid}>
          <For each={filtered()}>
            {finding => <FindingCard finding={finding} />}
          </For>
        </main>
      </Show>

      <footer style={s.footer}>
        Built with{' '}
        <a href="https://github.com/Lincoln504/pi-research" style={s.footerLink} target="_blank" rel="noopener noreferrer">
          pi-research
        </a>
        {' '}· Data updated via GitHub Actions
      </footer>
    </div>
  );
}

// ── Inline styles ────────────────────────────────────────────────────────────

const s: Record<string, any> = {
  root: { 'max-width': '760px', margin: '0 auto', padding: '0 1.5rem 5rem' },
  header: { padding: '4rem 0 2rem', 'text-align': 'center' },
  title: { 'font-size': '2.5rem', 'font-weight': '700', 'margin-bottom': '0.75rem', 'letter-spacing': '-0.02em' },
  subtitle: { color: '#666', 'font-size': '1.1rem', 'margin': '0 auto 1.5rem', 'line-height': 1.6, 'max-width': '500px' },
  inlineLink: { color: '#666', 'text-decoration': 'underline' },
  stats: { display: 'flex', gap: '0.75rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  stat: { 'font-size': '0.75rem', color: '#888', background: '#fff', border: '1px solid #eee', padding: '0.25rem 0.75rem', 'border-radius': '4px', 'font-weight': '500' },
  controls: { 
    display: 'flex', gap: '0.5rem', 'flex-wrap': 'wrap', 'margin-bottom': '2rem', 
    padding: '1.5rem 0', 'border-top': '1px solid #eee', 'border-bottom': '1px solid #eee' 
  },
  searchInput: {
    flex: '1 1 200px', padding: '0.5rem 0.75rem', 'border-radius': '6px',
    border: '1px solid #ddd', background: '#fff', color: '#1a1a1a',
    'font-size': '0.9rem', outline: 'none',
  },
  select: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #ddd',
    background: '#fff', color: '#1a1a1a', 'font-size': '0.9rem', cursor: 'pointer',
  },
  downloadContainer: { position: 'relative' },
  downloadBtn: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #1a1a1a',
    background: '#1a1a1a', color: '#fff', 'font-size': '0.9rem', cursor: 'pointer',
    'font-weight': '500', transition: 'opacity 0.2s',
  },
  dropdown: {
    position: 'absolute', top: '100%', right: '0', 'margin-top': '0.5rem',
    background: '#fff', border: '1px solid #ddd', 'border-radius': '6px',
    'box-shadow': '0 4px 12px rgba(0,0,0,0.1)', 'z-index': 10,
    display: 'flex', 'flex-direction': 'column', 'min-width': '100px',
    overflow: 'hidden'
  },
  dropdownItem: {
    padding: '0.6rem 1rem', background: 'none', border: 'none',
    'text-align': 'left', cursor: 'pointer', 'font-size': '0.85rem',
    color: '#333', transition: 'background 0.2s',
  },
  resultsBar: { 'font-size': '0.85rem', color: '#999', 'margin-bottom': '1rem', 'text-align': 'center' },
  grid: { display: 'flex', 'flex-direction': 'column', gap: '2rem' },
  loading: { color: '#999', padding: '4rem', 'text-align': 'center' },
  error: { color: '#d32f2f', padding: '2rem', 'text-align': 'center' },
  empty: { color: '#999', padding: '4rem', 'text-align': 'center' },
  card: {
    background: '#fff', 'border-radius': '0',
    padding: '0', transition: 'none',
  },
  cardHeader: { display: 'flex', gap: '0.75rem', 'align-items': 'center', 'margin-bottom': '0.75rem' },
  badge: {
    'font-size': '0.65rem', 'font-weight': '700', padding: '0.15rem 0.5rem',
    'border-radius': '3px', color: '#fff', 'text-transform': 'uppercase', 'letter-spacing': '0.05em'
  },
  categoryBadge: {
    'font-size': '0.7rem', color: '#888', 'font-weight': '500', 'text-transform': 'uppercase', 'letter-spacing': '0.02em'
  },
  date: { 'font-size': '0.75rem', color: '#bbb', 'margin-left': 'auto' },
  cardTitle: { 'font-size': '1.4rem', 'font-weight': '600', 'margin-bottom': '0.5rem', 'line-height': 1.3 },
  titleLink: { color: '#1a1a1a', 'text-decoration': 'none', borderBottom: '1px solid #eee' },
  domain: { 'font-size': '0.8rem', color: '#999', 'margin-bottom': '1rem', 'font-style': 'italic' },
  summary: { 'font-size': '1rem', color: '#444', 'line-height': 1.6, 'margin-bottom': '1.25rem' },
  whyBadBox: {
    'font-size': '0.9rem', color: '#555', 'line-height': 1.6,
    background: '#fcfcf9', borderLeft: '3px solid #eee',
    padding: '0.75rem 1rem',
  },
  whyBadLabel: { 'font-weight': '700', color: '#333' },
  footer: { 'margin-top': '6rem', 'text-align': 'center', 'font-size': '0.8rem', color: '#aaa', 'padding-top': '3rem', 'border-top': '1px solid #eee' },
  footerLink: { color: '#666', 'text-decoration': 'underline' },
};
