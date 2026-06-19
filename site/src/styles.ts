// styles.ts — shared inline-style objects + presentational helpers.
//
// Extracted from App.tsx so the card + feed views share ONE source of truth (and to
// avoid a circular import between App.tsx and Feed.tsx). Solid inline-style objects use
// kebab-case CSS keys. UI === SERIF: headings/body all use the Inter (sans) stack.

export const UI = `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
export const SERIF = UI;

export const SEVERITY_COLOR: Record<string, string> = {
  high: '#d32f2f',
  medium: '#ef6c00',
  low: '#c79a00',
};

export function categoryLabel(key: string): string {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const s: Record<string, any> = {
  root: { 'max-width': '760px', margin: '0 auto', padding: '0 1.5rem 5rem', 'font-family': UI, 'min-height': '100vh' },
  header: { padding: '4rem 0 2rem', 'text-align': 'center' },
  title: { 'font-family': SERIF, 'font-size': '3rem', 'font-weight': '700', 'margin-bottom': '0', 'letter-spacing': '-0.02em', 'line-height': 1 },
  homeLink: { 'text-decoration': 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', gap: '0.7rem', 'margin-bottom': '1.25rem' },
  titleLogo: { height: '2.1rem', width: '2.1rem', display: 'block', 'flex-shrink': 0 },
  subtitle: { color: '#555', 'font-size': '1.05rem', 'font-weight': '400', 'margin': '0 auto 1.5rem', 'line-height': 1.7, 'max-width': '640px' },
  subMeta: { display: 'block', 'margin-top': '0.95rem', 'font-size': '0.8rem', color: '#999', 'line-height': 1.7 },
  nowrap: { 'white-space': 'nowrap' },
  inlineLink: { color: '#1a1a1a', 'text-decoration': 'underline', 'font-weight': '600' },
  stats: { display: 'flex', gap: '0.5rem', 'justify-content': 'center', 'flex-wrap': 'wrap' },
  stat: { 'font-size': '0.72rem', color: '#888', background: '#fff', border: '1px solid #eee', padding: '0.25rem 0.7rem', 'border-radius': '4px', 'font-weight': '500' },
  controls: {
    display: 'flex', 'flex-direction': 'column', gap: '0.65rem', 'margin-bottom': '2rem',
    padding: '1.5rem 0', 'border-top': '1px solid #eee', 'border-bottom': '1px solid #eee',
  },
  filterRow: { display: 'flex', gap: '0.5rem', 'flex-wrap': 'wrap' },
  modelStatusRow: { display: 'flex', 'align-items': 'center', gap: '0.6rem', 'min-height': '1.1rem' },
  progressTrack: { flex: '1 1 auto', height: '4px', background: '#eceae4', 'border-radius': '999px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#1a1a1a', 'border-radius': '999px', transition: 'width 0.2s ease' },
  progressPct: { 'font-size': '0.72rem', color: '#888', 'white-space': 'nowrap', 'flex-shrink': 0 },
  cacheTick: { 'font-size': '0.72rem', color: '#1a7f37', 'font-weight': '600' },
  clearedTick: { 'font-size': '0.72rem', color: '#888', 'font-weight': '600' },
  clearModelBtn: { 'font-family': UI, 'font-size': '0.7rem', color: '#999', background: 'none', border: 'none', padding: '0', cursor: 'pointer', 'text-decoration': 'none' },
  searchRow: { display: 'flex', gap: '0.5rem', 'align-items': 'stretch' },
  searchInput: {
    flex: '1 1 auto', 'min-width': 0, 'box-sizing': 'border-box', padding: '0.75rem 1.1rem', 'border-radius': '2px',
    border: '1.5px solid #ccc', background: '#fff', color: '#1a1a1a', 'font-size': '1.05rem',
    outline: 'none', 'font-family': UI,
    'box-shadow': '0 2px 8px rgba(0,0,0,0.06)',
  },
  select: {
    padding: '0.5rem 0.75rem', 'border-radius': '6px', border: '1px solid #ddd',
    background: '#fff', color: '#1a1a1a', 'font-size': '0.9rem', cursor: 'pointer', 'font-family': UI,
  },
  downloadArea: { position: 'relative', 'text-align': 'center', margin: '0' },
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
  grid: { display: 'flex', 'flex-direction': 'column', gap: '1.25rem' },
  loading: { color: '#999', padding: '4rem', 'text-align': 'center' },
  error: { color: '#d32f2f', padding: '2rem', 'text-align': 'center' },
  empty: { color: '#999', padding: '4rem', 'text-align': 'center' },
  // Search/list tiles: SQUARE edges (2px) — the visual signature of list/search mode.
  card: {
    background: '#fff', 'border-radius': '2px', border: '1px solid #ebe9e3',
    padding: '1.45rem 1.65rem',
    'box-shadow': '0 2px 10px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
  },
  // Feed/permalink card: ROUNDED, slightly tighter insets — the signature of feed mode.
  cardFeed: {
    background: '#fff', 'border-radius': '12px', border: '1px solid #ebe9e3',
    padding: '1.2rem 1.4rem',
    'box-shadow': '0 2px 14px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04)',
    cursor: 'grab', // whitespace is the drag handle; text blocks below override to I-beam
  },
  cardHeader: { display: 'flex', gap: '0.75rem', 'align-items': 'center', 'margin-bottom': '0.85rem' },
  badge: { 'font-size': '0.62rem', 'font-weight': '700', padding: '0.18rem 0.5rem', 'border-radius': '3px', color: '#fff', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' },
  categoryBadge: { 'font-size': '0.68rem', color: '#888', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' },
  scoreBadge: { 'font-size': '0.62rem', color: '#ef6c00', 'font-weight': '700', 'text-transform': 'uppercase' },
  date: { 'font-size': '0.72rem', color: '#bbb', 'margin-left': 'auto' },
  cardTitle: { 'font-family': SERIF, 'font-size': '1.65rem', 'font-weight': '700', 'margin-bottom': '0.4rem', 'line-height': 1.25, 'letter-spacing': '-0.01em' },
  titleLink: { color: '#1a1a1a', 'text-decoration': 'none', 'background-image': 'linear-gradient(#e8e6e0,#e8e6e0)', 'background-position': '0 100%', 'background-size': '100% 1px', 'background-repeat': 'no-repeat' },
  domain: { 'font-family': SERIF, 'font-size': '0.92rem', color: '#a09a8e', 'margin-bottom': '1.1rem', 'font-style': 'italic', cursor: 'text' },
  summaryText: { 'font-family': SERIF, 'font-size': '1.05rem', color: '#3a3a3a', 'line-height': 1.6, 'text-align': 'justify', hyphens: 'auto', margin: '0 0 1.25rem', cursor: 'text' },
  whyBadBox: { background: '#fcfbf8', 'border-left': '3px solid #e4e1d9', padding: '1.1rem 1.25rem' },
  whyBadLabel: { 'font-family': UI, 'font-weight': '700', color: '#1a1a1a', 'font-size': '0.7rem', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '0.6rem' },
  whyBadText: { 'font-family': SERIF, 'font-size': '0.95rem', color: '#444', 'line-height': 1.65, 'text-align': 'left', margin: '0 0 0.7rem', cursor: 'text' },
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
  footer: { padding: '8rem 0 4rem', display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '2.75rem', 'border-top': '1px solid #eee', 'margin-top': '4rem' },
  footerMain: { display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '1.5rem', 'flex-wrap': 'wrap' },
  feedbackLine: { display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '0.65rem', 'flex-wrap': 'wrap', 'font-size': '0.95rem', color: '#555', 'text-align': 'center' },
  feedbackArrow: { 'font-size': '1.7rem', 'line-height': 1, color: '#1a1a1a', 'font-weight': '700' },
  feedbackEmail: { color: '#1a1a1a', 'font-weight': '700', 'text-decoration': 'underline' },
  footerMark: { width: '72px', height: '72px', display: 'block', 'flex-shrink': 0 },
  qrLink: { 'flex-shrink': 0, 'line-height': 0 },
  qr: { display: 'block', width: '72px', height: '72px', 'border-radius': '6px' },
  footerCta: { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start', gap: '0.25rem' },
  footerCtaLabel: { 'font-size': '0.85rem', color: '#999' },
  footerUrl: { 'font-size': '1.15rem', 'font-weight': '700', color: '#1a1a1a', 'text-decoration': 'none' },

  // ── Feed mode ────────────────────────────────────────────────────────────────
  // Side-to-side on BOTH desktop and mobile. One pointer-drag implementation (Pointer
  // Events) gives mouse-drag on desktop and touch-flick on mobile; clickable carousel
  // arrows overlay the card's left/right edges on both; ←/→ keys also advance. Vertical
  // page scroll is preserved (touch-action: pan-y) so the header stays reachable.
  // Full-bleed feed stage + per-slot transforms are styled inline in Feed.tsx (they derive from
  // measured viewport/card widths). Only the round arrow button keeps a static style here.
  feedArrowBtn: {
    position: 'absolute', top: '50%', 'z-index': 2,
    'font-family': UI, display: 'flex', 'align-items': 'center', 'justify-content': 'center',
    width: '2.7rem', height: '2.7rem', 'font-size': '1.25rem', 'line-height': 1,
    background: 'rgba(255,255,255,0.94)', border: '1px solid #e2dfd7', color: '#555',
    'border-radius': '999px', cursor: 'pointer', 'box-shadow': '0 1px 8px rgba(0,0,0,0.12)',
    padding: 0, 'user-select': 'none',
    transition: 'background 0.15s ease, color 0.15s ease, opacity 0.15s ease',
  },
  feedArrowBtnDisabled: { opacity: 0.32, cursor: 'default', 'box-shadow': 'none' },

  // Section label above the content area: "Feed" vs "Results".
  sectionLabel: {
    'font-family': UI, 'font-size': '0.7rem', 'font-weight': '700', color: '#b0ada4',
    'text-transform': 'uppercase', 'letter-spacing': '0.12em', 'margin-bottom': '1rem', 'text-align': 'center',
  },
};
