// Feed.tsx — a full-bleed one-card carousel (the default browsing experience).
//
// The current card stays at the content-column width and centred; the previous/next cards are
// rendered too and rest just past the LEFT/RIGHT screen edges, so a swipe/drag/arrow sweeps the
// neighbour CONTINUOUSLY across the whole viewport — it enters from the window edge, not from an
// inset column margin. The inter-card gap is derived from the viewport so the cards sit clearly
// apart. Works identically on desktop (mouse drag + gutter arrows + ←/→ keys) and mobile (touch
// flick); touch-action: pan-y keeps vertical page scroll alive.
//
// Cards render with a reference-keyed <For>, so each finding keeps its OWN DOM node as it moves
// between prev/current/next roles. That makes the slide seamless (no remount mid-animation) AND
// justify-safe: justify.ts imperatively rewrites a card's summary <p>, and because a node never
// changes which finding it shows, that mutation can never desync from Solid's bindings.
//
// Selection is delegated to the pure weighted-random sequencer (sequencer.ts); the dwell time on
// the card just left feeds the next lookahead so lingering gently nudges toward similar content.
import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from 'solid-js';
import type { Finding } from './types.js';
import FindingCard from './FindingCard.js';
import { createSequencer, type Sequencer } from './sequencer.js';
import { useInputClass, usePrefersReducedMotion } from './device.js';
import { justifyElements } from './justify.js';
import { s } from './styles.js';

// One seed per page load: the feed isn't byte-identical across reloads, but "prev" within a
// session is exact. (Date.now in the browser is fine — the no-Date rule is workflow-only.)
const SESSION_SEED = (Date.now() & 0xffffffff) >>> 0;

// On a FRESH page load the very first feed card is biased to one of these high-signal
// categories. Module-level so it fires only on the initial load — returning to the feed from
// an entry/search within the same session (no reload) re-seeds normally (random). A user-set
// category filter takes precedence (the first card is then naturally that category).
// First-card seed categories on a fresh load. Excludes `current_affairs` (3 entries) — a
// residual-only category by classify.ts design (topical pieces are reassigned to their real
// subject), so it's effectively never seeded and only dilutes this list.
const PREFERRED_FIRST = ['climate', 'gender', 'healthcare', 'immigration', 'media', 'spectacle', 'war', 'technology'];
let isFirstSeedOfPageLoad = true;

// Feed position persists across LEAVING the feed (opening a search or an entry) and returning
// within the same session — so deleting a query drops the reader back exactly where they were,
// not at the first card. Keyed by the pool ARRAY REFERENCE: a category/severity filter change
// produces a new pool array → no restore → a correct fresh feed for the new filter. The whole
// sequencer instance is preserved too, so recent-history suppression and read-time affinity
// carry over rather than resetting on return.
type FeedSession = { pool: Finding[]; seq: Sequencer; current: Finding | null; next: Finding | null; prevStack: Finding[] };
let savedSession: FeedSession | null = null;

const ENGAGE_PX = 6;      // movement before a press becomes a drag (taps/clicks pass through)
const COMMIT_PX = 70;     // drag distance that commits a move
const FLICK_V = 0.45;     // px/ms velocity that commits a move (a quick flick)
const SLIDE_MS = 240;     // slide animation duration
const MAX_CARD = 712;     // card width cap = content column (root max-width 760 − 2×1.5rem padding)
const SIDE_MIN = 24;      // min breathing room each side of the card on narrow screens
const GAP_MIN = 32;       // floor for the inter-card gap (narrow screens)
const EDGE_OVERSHOOT = 28; // neighbours rest this many px PAST each screen edge (fully off, sweep in)
const FALLBACK_H = 360;   // clip height before the first measure, to avoid a 1-frame collapse
const EDGE_FEATHER = 34;  // px the card edge fades over at each screen edge (soft clip, see below)
// A mask-image feather softens the hard clip line where a card is cut by the screen edge: the
// incoming/outgoing card edge fades to transparent over EDGE_FEATHER px instead of a sharp cut.
// This is a GPU-composited alpha mask — no blur filter, no extra DOM, effectively free per frame.
const EDGE_MASK = `linear-gradient(to right, transparent 0, #000 ${EDGE_FEATHER}px, #000 calc(100% - ${EDGE_FEATHER}px), transparent 100%)`;

export default function Feed(props: { findings: Finding[]; onShare: (f: Finding) => void }) {
  const reducedMotion = usePrefersReducedMotion();
  const inputClass = useInputClass(); // 'pointer' → show side arrows; 'touch' → swipe only

  // The sequencer for the current pool. Created fresh when the pool changes, or restored from the
  // saved session when returning to the same pool (see the seed effect below).
  let sequencer!: Sequencer;
  const [current, setCurrent] = createSignal<Finding | null>(null);
  const [next, setNext] = createSignal<Finding | null>(null);          // lookahead (rendered peeking)
  const [prevStack, setPrevStack] = createSignal<Finding[]>([]);
  const prevCard = createMemo(() => prevStack().at(-1) ?? null);
  const canBack = createMemo(() => prevStack().length > 0);
  const canNext = createMemo(() => next() !== null);

  const slots = createMemo<Finding[]>(() => [prevCard(), current(), next()].filter(Boolean) as Finding[]);
  const currentIdx = createMemo(() => (prevCard() ? 1 : 0));

  const [dragX, setDragX] = createSignal(0);
  const [sliding, setSliding] = createSignal(false); // CSS transform transition on/off
  const [dragActive, setDragActive] = createSignal(false); // suppress text selection only mid-drag
  const [cardW, setCardW] = createSignal(MAX_CARD);  // card (column) width, px
  const [gap, setGap] = createSignal(GAP_MIN);       // inter-card gap, px (viewport-derived)
  const [clipH, setClipH] = createSignal(0);         // tallest visible card, px

  let shownAt = performance.now();
  let busy = false;            // one move at a time (covers arrows, keys, and slide animation)
  let stageRef: HTMLDivElement | undefined;

  // drag bookkeeping. `scrolling` locks a gesture to the vertical axis: once a press resolves to
  // a vertical-dominant move it's a page scroll and can never also slide the card (no diagonal
  // where both happen at once); only a horizontal-dominant move engages the card drag.
  let armed = false, dragging = false, scrolling = false, startX = 0, startY = 0, startT = 0, pid = -1;

  const dwellMs = () => performance.now() - shownAt;
  const step = () => cardW() + gap(); // distance to shift the track by one card

  // Seed / reseed the feed when the pool changes — or restore the saved position when returning
  // to the same pool (deleting a search, leaving an entry) so the reader lands where they were.
  createEffect(on(() => props.findings, (findings) => {
    if (savedSession && savedSession.pool === findings) {
      sequencer = savedSession.seq;
      setPrevStack(savedSession.prevStack);
      setCurrent(savedSession.current);
      setNext(savedSession.next);
      setDragX(0);
      shownAt = performance.now();
      return;
    }
    sequencer = createSequencer(findings, SESSION_SEED);
    setPrevStack([]);
    // Fresh page load only: bias the first card to a preferred category (when the pool is the
    // full corpus — a user filter already narrows it, so respect that).
    let first: Finding | null = null;
    if (isFirstSeedOfPageLoad) {
      const pref = findings.filter(f => PREFERRED_FIRST.includes(f.category));
      if (pref.length) first = pref[SESSION_SEED % pref.length]!;
    }
    isFirstSeedOfPageLoad = false;
    // Mark the externally-chosen first card served BEFORE drawing the lookahead, so the no-repeat
    // guarantee covers it too (next() excludes the served set).
    if (first) sequencer.markServed(first);
    setCurrent(first ?? sequencer.next(0));
    setNext(sequencer.next(0));
    setDragX(0);
    shownAt = performance.now();
  }));

  // Keep the saved session in lock-step with the live position, so leaving the feed at any moment
  // captures the exact card on screen (and its neighbours) for an accurate restore on return.
  createEffect(() => {
    const cur = current(), nx = next(), st = prevStack();
    if (!sequencer) return;
    savedSession = { pool: props.findings, seq: sequencer, current: cur, next: nx, prevStack: st };
  });

  // Re-index after a slide settles. Forward: current→prev, next→current, draw a fresh
  // dwell-aware lookahead. Back: current→next (so forward returns here), pop history.
  const reindex = (goNext: boolean) => {
    if (goNext) {
      const cur = current(), nx = next();
      if (!nx) return;
      if (cur) setPrevStack(st => [...st, cur]);
      setCurrent(nx);
      // Credit the read-time to the card actually just left (cur) — not the sequencer's own last
      // pick, which is one ahead due to the lookahead — so its category gets the engagement boost.
      setNext(sequencer.next(dwellMs(), cur?.category));
    } else {
      const st = prevStack();
      if (!st.length) return;
      setNext(current());
      setCurrent(st[st.length - 1]!);
      setPrevStack(st.slice(0, -1));
    }
    shownAt = performance.now();
  };

  // Animate the whole track one card over, then re-index and snap back to centre in the same
  // frame (content shifts to compensate, so the swap is seamless). reducedMotion → instant.
  const commitMove = (goNext: boolean) => {
    if (busy) return;
    if (goNext ? !canNext() : !canBack()) return;
    busy = true;
    if (reducedMotion()) { reindex(goNext); setDragX(0); setSliding(false); busy = false; return; }
    setSliding(true);
    setDragX(goNext ? -step() : step());
    window.setTimeout(() => {
      setSliding(false);   // disable transition for the instant re-centre
      reindex(goNext);
      setDragX(0);         // transform jumps, but the slot content shifted by one → no visible move
      requestAnimationFrame(() => { setSliding(true); busy = false; });
    }, SLIDE_MS);
  };
  const goNext = () => commitMove(true);
  const goPrev = () => commitMove(false);

  // ── Pointer drag (mouse + touch, unified) ──────────────────────────────────────
  // Is the press target selectable text or an interactive control (not bare card whitespace)?
  const isTextOrInteractive = (target: EventTarget | null): boolean => {
    let n = target as Element | null;
    while (n && n !== stageRef) {
      const tag = n.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' ||
          tag === 'SELECT' || tag === 'LABEL' ||
          tag === 'P' || tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'SPAN') return true;
      n = n.parentElement;
    }
    return false;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (busy) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
    // On a precise pointer (mouse), a press starting on text or a link is a selection/click,
    // never a drag — so text stays highlightable and the card drags only from whitespace.
    // Touch has no such ambiguity: a swipe navigates anywhere, while a stationary long-press
    // still triggers native selection (we engage a drag only past ENGAGE_PX of movement).
    if (e.pointerType === 'mouse' && isTextOrInteractive(e.target)) return;
    armed = true; dragging = false; scrolling = false;
    startX = e.clientX; startY = e.clientY; startT = performance.now(); pid = e.pointerId;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!armed) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (scrolling) return; // gesture already committed to vertical scroll — ignore horizontal
      if (Math.abs(dx) < ENGAGE_PX && Math.abs(dy) < ENGAGE_PX) return;
      // Axis lock: a vertical-dominant gesture is a page scroll — leave it to the browser (pan-y)
      // and never slide the card too. Only a horizontal-dominant gesture engages the card drag.
      if (Math.abs(dy) >= Math.abs(dx)) { scrolling = true; return; }
      dragging = true;
      setDragActive(true); // now an intentional drag — block selection flicker until release
      setSliding(false);
      try { stageRef?.setPointerCapture(pid); } catch { /* ignore */ }
    }
    // Resist at the ends (nothing to reveal that way).
    const resist = (dx > 0 && !canBack()) || (dx < 0 && !canNext());
    setDragX(resist ? dx * 0.25 : dx);
  };
  const endDrag = () => {
    if (!armed) return;
    armed = false;
    setDragActive(false);
    try { stageRef?.releasePointerCapture(pid); } catch { /* ignore */ }
    if (!dragging) return; // was a tap/click — let it through (link / Share button)
    dragging = false;
    const dx = dragX();
    const v = dx / Math.max(1, performance.now() - startT);
    const fwd = dx < 0;
    const commit = (Math.abs(dx) > COMMIT_PX || Math.abs(v) > FLICK_V) && (fwd ? canNext() : canBack());
    if (commit) commitMove(fwd);
    else { setSliding(true); setDragX(0); } // snap back
  };

  // ── Keyboard ────────────────────────────────────────────────────────────────────
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // don't hijack search/filters
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev(); }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  // ── Measure card width, viewport-derived gap, and tallest card (clip height) ─────
  // cardW = the content column width (capped); gap is sized so each neighbour rests just past a
  // screen edge: neighbour-near-edge = centre ± (cardW/2 + gap) = screen edge + EDGE_OVERSHOOT.
  const measure = () => {
    const W = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const cw = Math.min(MAX_CARD, Math.max(200, W - SIDE_MIN * 2));
    setCardW(cw);
    setGap(Math.max(GAP_MIN, (W - cw) / 2 + EDGE_OVERSHOOT));
    if (stageRef) {
      // Measure the CURRENT card specifically (not the tallest visible) so the stage hugs the
      // actual content — the page stays minimal (no permanent extra space) and the footer sits a
      // consistent gap below the card. Height changes between cards are smoothed by the animated
      // min-height transition on the stage, so a taller/shorter card eases in rather than jumping.
      const els = stageRef.querySelectorAll('.wos-feed-slot');
      const cur = els[currentIdx()] as HTMLElement | undefined;
      const h = cur ? cur.offsetHeight : 0;
      if (h > 0) setClipH(h);
    }
  };
  onMount(() => {
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && stageRef) { ro = new ResizeObserver(() => measure()); ro.observe(stageRef); }
    onCleanup(() => { window.removeEventListener('resize', onResize); ro?.disconnect(); });
  });

  // Re-justify the visible cards whenever the window changes, then re-measure height (justify
  // changes line count → height). Each finding owns its node, so justify never desyncs.
  createEffect(() => {
    prevCard(); current(); next(); cardW();
    requestAnimationFrame(() => {
      void justifyElements(stageRef ? Array.from(stageRef.querySelectorAll('.wos-justify')) as HTMLElement[] : [])
        .then(measure);
      measure();
    });
  });

  const slotTransform = (i: number) => `translateX(${(i - currentIdx()) * step() + dragX()}px)`;

  return (
    // Full-bleed stage: breaks out of the centred column to the full viewport so neighbours can
    // enter from the actual screen edges. The negative-margin technique (NOT left:50%+translateX)
    // is used because a relative `left` offset leaks horizontal scroll width on mobile — making the
    // page pannable / not-fully-zoomed-out; negative margins centre it symmetrically with no
    // overflow regardless of the parent column's padding. overflow:clip contains the slide.
    <div
      ref={stageRef}
      style={{
        position: 'relative', width: '100vw', 'margin-left': 'calc(50% - 50vw)',
        padding: '0.4rem 0', overflow: 'clip', 'overflow-clip-margin': '20px',
        'touch-action': 'pan-y',
        // Stage hugs the current card; height eases between cards of different sizes (a single
        // short transition per swap — not per-frame — so it's cheap), keeping the page minimal
        // without a jarring jump as the footer below settles to the new height.
        'min-height': `${clipH() || FALLBACK_H}px`,
        transition: 'min-height 280ms ease',
        // Soft-clip the card edges at the screen edge (cheap GPU alpha mask, no blur filter).
        '-webkit-mask-image': EDGE_MASK, 'mask-image': EDGE_MASK,
        ...(dragActive() ? { 'user-select': 'none', '-webkit-user-select': 'none' } : {}),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Desktop only: clickable arrows just outside the card's left/right edges. */}
      <Show when={inputClass() === 'pointer'}>
        <button
          style={{ ...s.feedArrowBtn, top: '50%', left: `calc(50% - ${cardW() / 2}px - 3.4rem)`, transform: 'translate(-50%, -50%)', ...(canBack() ? {} : s.feedArrowBtnDisabled) }}
          onClick={goPrev} disabled={!canBack()} aria-label="Previous entry"
        >{'←'}</button>
        <button
          style={{ ...s.feedArrowBtn, top: '50%', left: `calc(50% + ${cardW() / 2}px + 3.4rem)`, transform: 'translate(-50%, -50%)', ...(canNext() ? {} : s.feedArrowBtnDisabled) }}
          onClick={goNext} disabled={!canNext()} aria-label="Next entry"
        >{'→'}</button>
      </Show>

      <div aria-live="polite" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {current()?.title ?? ''}
      </div>

      {/* Reference-keyed: each finding keeps its node across prev/current/next roles. Each card is
          column-width and centred; its role offset + drag position it within the full-bleed stage. */}
      <For each={slots()}>
        {(f, i) => (
          <div
            class="wos-feed-slot"
            style={{
              position: 'absolute', top: '0', width: `${cardW()}px`, left: `calc(50% - ${cardW() / 2}px)`,
              transform: slotTransform(i()),
              transition: sliding() ? `transform ${SLIDE_MS}ms ease` : 'none',
              'will-change': 'transform',
            }}
          >
            <FindingCard finding={f} onShare={props.onShare} variant="feed" />
          </div>
        )}
      </For>
      <Show when={slots().length === 0}>
        <div style={s.empty}>No entries found.</div>
      </Show>
    </div>
  );
}
