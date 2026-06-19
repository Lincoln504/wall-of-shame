// FindingCard.tsx — the single result card, shared by the list view, the feed, and the
// permalink view. Pure presentation: takes a finding (+ optional search score) and a
// share handler. Extracted from App.tsx so Feed.tsx can render an identical card.
import { For, Show } from 'solid-js';
import type { Finding } from './types.js';
import { splitAnalysisPoints } from './format.js';
import { s, SEVERITY_COLOR, categoryLabel } from './styles.js';

export default function FindingCard(props: {
  finding: Finding; score?: number; onShare: (f: Finding) => void;
  variant?: 'list' | 'feed';
}) {
  const f = props.finding;
  const color = SEVERITY_COLOR[f.severity] ?? '#757575';
  const date = f.foundAt ? `Found ${new Date(f.foundAt).toLocaleDateString()}` : '';

  return (
    <article style={props.variant === 'feed' ? s.cardFeed : s.card}>
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
