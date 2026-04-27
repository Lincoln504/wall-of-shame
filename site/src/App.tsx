import { createSignal, createResource, For, Show, createMemo } from 'solid-js';
import type { FindingsStore, Finding } from './types.js';

const BASE = import.meta.env.BASE_URL;

async function fetchFindings(): Promise<FindingsStore> {
  const res = await fetch(`${BASE}findings.json`);
  if (!res.ok) throw new Error(`Failed to load findings: ${res.status}`);
  return res.json() as Promise<FindingsStore>;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: '#ff4444',
  medium: '#ff9944',
  low: '#ffcc44',
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

function FindingCard(props: { finding: Finding }) {
  const f = props.finding;
  const color = SEVERITY_COLOR[f.severity] ?? '#aaa';
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
        <span style={s.whyBadLabel}>Why it's on the wall: </span>
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

  return (
    <div style={s.root}>
      <header style={s.header}>
        <h1 style={s.title}>🧱 Wall of Shame</h1>
        <p style={s.subtitle}>
          An automated catalogue of harmful, biased, and maliciously ideological content found on the internet.
        </p>
        <Show when={data()}>
          <div style={s.stats}>
            <span style={s.stat}>{data()!.totalFindings} entries</span>
            <span style={s.stat}>{categories().length} categories</span>
            <span style={s.stat}>
              Updated {new Date(data()!.lastUpdated).toLocaleDateString()}
            </span>
          </div>
        </Show>
      </header>

      <div style={s.controls}>
        <input
          type="search"
          placeholder="Search titles, summaries, domains..."
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
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="severity">By severity</option>
        </select>
      </div>

      <Show when={data.loading}>
        <div style={s.loading}>Loading findings...</div>
      </Show>

      <Show when={data.error}>
        <div style={s.error}>Failed to load findings. {String(data.error)}</div>
      </Show>

      <Show when={data()}>
        <div style={s.resultsBar}>
          Showing {filtered().length} of {data()!.totalFindings} entries
        </div>
        <Show when={filtered().length === 0}>
          <div style={s.empty}>No findings match your filters.</div>
        </Show>
        <main style={s.grid}>
          <For each={filtered()}>
            {finding => <FindingCard finding={finding} />}
          </For>
        </main>
      </Show>

      <footer style={s.footer}>
        Content identified by automated research using{' '}
        <a href="https://github.com/Lincoln504/pi-research" style={s.footerLink} target="_blank" rel="noopener noreferrer">
          pi-research
        </a>
        {' '}· Updated automatically via GitHub Actions
      </footer>
    </div>
  );
}

// ── Inline styles ────────────────────────────────────────────────────────────

const s: Record<string, object> = {
  root: { 'max-width': '1100px', margin: '0 auto', padding: '0 1rem 4rem' },
  header: { padding: '3rem 0 1.5rem', 'border-bottom': '1px solid #2a2a2a', 'margin-bottom': '1.5rem' },
  title: { 'font-size': '2.4rem', 'font-weight': 800, 'letter-spacing': '-0.5px', 'margin-bottom': '0.5rem' },
  subtitle: { color: '#888', 'font-size': '1rem', 'max-width': '600px', 'line-height': 1.5 },
  stats: { display: 'flex', gap: '1.5rem', 'margin-top': '1rem', 'flex-wrap': 'wrap' },
  stat: { 'font-size': '0.85rem', color: '#aaa', background: '#1a1a1a', padding: '0.3rem 0.8rem', 'border-radius': '99px' },
  controls: { display: 'flex', gap: '0.75rem', 'flex-wrap': 'wrap', 'margin-bottom': '1rem' },
  searchInput: {
    flex: '1 1 240px', padding: '0.6rem 0.9rem', 'border-radius': '8px',
    border: '1px solid #333', background: '#1a1a1a', color: '#e5e5e5',
    'font-size': '0.9rem', outline: 'none',
  },
  select: {
    padding: '0.6rem 0.9rem', 'border-radius': '8px', border: '1px solid #333',
    background: '#1a1a1a', color: '#e5e5e5', 'font-size': '0.9rem', cursor: 'pointer',
  },
  resultsBar: { 'font-size': '0.8rem', color: '#666', 'margin-bottom': '1rem' },
  grid: { display: 'flex', 'flex-direction': 'column', gap: '1rem' },
  loading: { color: '#888', padding: '3rem', 'text-align': 'center' },
  error: { color: '#ff6666', padding: '2rem', 'text-align': 'center', background: '#1a0000', 'border-radius': '8px' },
  empty: { color: '#666', padding: '3rem', 'text-align': 'center' },
  card: {
    background: '#161616', border: '1px solid #2a2a2a', 'border-radius': '10px',
    padding: '1.2rem 1.4rem', transition: 'border-color 0.2s',
  },
  cardHeader: { display: 'flex', gap: '0.6rem', 'align-items': 'center', 'margin-bottom': '0.7rem', 'flex-wrap': 'wrap' },
  badge: {
    'font-size': '0.7rem', 'font-weight': 700, padding: '0.2rem 0.6rem',
    'border-radius': '99px', color: '#000', 'text-transform': 'uppercase', 'letter-spacing': '0.5px',
  },
  categoryBadge: {
    'font-size': '0.72rem', padding: '0.2rem 0.7rem', 'border-radius': '99px',
    background: '#252525', color: '#aaa', border: '1px solid #333',
  },
  date: { 'font-size': '0.72rem', color: '#555', 'margin-left': 'auto' },
  cardTitle: { 'font-size': '1.05rem', 'font-weight': 600, 'margin-bottom': '0.25rem', 'line-height': 1.4 },
  titleLink: { color: '#7eb8f7', 'text-decoration': 'none' },
  domain: { 'font-size': '0.75rem', color: '#666', 'margin-bottom': '0.6rem' },
  summary: { 'font-size': '0.88rem', color: '#bbb', 'line-height': 1.6, 'margin-bottom': '0.75rem' },
  whyBadBox: {
    'font-size': '0.84rem', color: '#e5c07b', 'line-height': 1.55,
    background: '#1e1a0d', border: '1px solid #3a3000', 'border-radius': '6px',
    padding: '0.6rem 0.9rem',
  },
  whyBadLabel: { 'font-weight': 700, color: '#d4a017' },
  footer: { 'margin-top': '4rem', 'text-align': 'center', 'font-size': '0.8rem', color: '#555', 'padding-top': '2rem', 'border-top': '1px solid #1a1a1a' },
  footerLink: { color: '#7eb8f7', 'text-decoration': 'none' },
};
