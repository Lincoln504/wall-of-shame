// Feed.tsx — a one-card-at-a-time carousel (the default browsing experience).
//
// Adjacent cards (previous + next) are rendered alongside the current one so a swipe/drag/
// click slides the neighbour CONTINUOUSLY into view — the outgoing card never has to leave
// before the incoming one appears. At rest the neighbours sit one card-width + GAP off each
// edge (out of view); dragging translates all three together so the gap between cards reads
// as a natural margin. Works identically on desktop (mouse drag + gutter arrows + ←/→ keys)
// and mobile (touch flick); touch-action: pan-y keeps vertical page scroll alive.
//
// Cards are rendered with a reference-keyed <For>, so each finding keeps its OWN DOM node as
// it moves between the prev/current/next roles. That is what makes the slide seamless (no
// remount mid-animation) AND justify-safe: justify.ts imperatively rewrites a card's summary
// <p>, and because a node never changes which finding it shows, that mutation can never
// desync from Solid's reactive bindings (the title↔summary bug that one reused card caused).
//
// Selection is delegated to the pure weighted-random sequencer (sequencer.ts); the dwell time
// on the card just left feeds the next lookahead so lingering gently nudges toward similar
// content.
import { createSignal, createMemo, createEffect, on, onMount, onCleanup, For, Show } from 'solid-js';
import type { Finding } from './types.js';
import FindingCard from './FindingCard.js';
import { createSequencer } from './sequencer.js';
import { useInputClass, usePrefersReducedMotion } from './device.js';
import { justifyElements } from './justify.js';
import { s } from './styles.js';

// One seed per page load: the feed isn't byte-identical across reloads, but "prev" within a
// session is exact. (Date.now in the browser is fine — the no-Date rule is workflow-only.)
const SESSION_SEED = (Date.now() & 0xffffffff) >>> 0;

const ENGAGE_PX = 6;     // movement before a press becomes a drag (taps/clicks pass through)
const COMMIT_PX = 70;    // drag distance that commits a move
const FLICK_V = 0.45;    // px/ms velocity that commits a move (a quick flick)
const SLIDE_MS = 220;    // slide animation duration
const GAP = 32;          // px gap between adjacent cards (the inter-card margin while dragging)

export default function Feed(props: { findings: Finding[]; onShare: (f: Finding) => void }) {
  const reducedMotion = usePrefersReducedMotion();
  const inputClass = useInputClass(); // 'pointer' → show side arrows; 'touch' → swipe only

  // A fresh sequencer whenever the candidate pool changes (data load or category/severity filter).
  const seq = createMemo(() => createSequencer(props.findings, SESSION_SEED));
  const [current, setCurrent] = createSignal<Finding | null>(null);
  const [next, setNext] = createSignal<Finding | null>(null);          // lookahead (rendered peeking)
  const [prevStack, setPrevStack] = createSignal<Finding[]>([]);
  const prevCard = createMemo(() => prevStack().at(-1) ?? null);
  const canBack = createMemo(() => prevStack().length > 0);
  const canNext = createMemo(() => next() !== null);

  // The rendered window, in left→right order, plus where `current` sits within it.
  const slots = createMemo<Finding[]>(() => [prevCard(), current(), next()].filter(Boolean) as Finding[]);
  const currentIdx = createMemo(() => (prevCard() ? 1 : 0));

  const [dragX, setDragX] = createSignal(0);
  const [sliding, setSliding] = createSignal(false); // CSS transform transition on/off
  const [dragActive, setDragActive] = createSignal(false); // suppress text selection only mid-drag
  const [clipW, setClipW] = createSignal(0);   // measured card width (px) — the slide distance
  const [clipH, setClipH] = createSignal(0);   // tallest visible card (px) — keeps the clip sized

  let shownAt = performance.now();
  let busy = false;            // one move at a time (covers arrows, keys, and slide animation)
  let stageRef: HTMLDivElement | undefined;
  let clipRef: HTMLDivElement | undefined;

  // drag bookkeeping
  let armed = false, dragging = false, startX = 0, startT = 0, pid = -1;

  const dwellMs = () => performance.now() - shownAt;
  const step = () => clipW() + GAP; // distance to shift the track by one card

  // Seed / reseed the feed when the pool changes.
  createEffect(on(seq, (sequencer) => {
    setPrevStack([]);
    setCurrent(sequencer.next(0));
    setNext(sequencer.next(0));
    setDragX(0);
    shownAt = performance.now();
  }));

  // Re-index after a slide settles. Forward: current→prev, next→current, draw a fresh
  // dwell-aware lookahead. Back: current→next (so forward returns here), pop history.
  const reindex = (goNext: boolean) => {
    if (goNext) {
      const cur = current(), nx = next();
      if (!nx) return;
      if (cur) setPrevStack(st => [...st, cur]);
      setCurrent(nx);
      setNext(seq().next(dwellMs())); // dwell on the card just left nudges the new lookahead
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
    if (reducedMotion() || !clipW()) { reindex(goNext); setDragX(0); setSliding(false); busy = false; return; }
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
    while (n && n !== clipRef) {
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
    armed = true; dragging = false; startX = e.clientX; startT = performance.now(); pid = e.pointerId;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!armed) return;
    const dx = e.clientX - startX;
    if (!dragging) {
      if (Math.abs(dx) < ENGAGE_PX) return;
      dragging = true;
      setDragActive(true); // now an intentional drag — block selection flicker until release
      setSliding(false);
      try { clipRef?.setPointerCapture(pid); } catch { /* ignore */ }
    }
    // Resist at the ends (nothing to reveal that way).
    const resist = (dx > 0 && !canBack()) || (dx < 0 && !canNext());
    setDragX(resist ? dx * 0.25 : dx);
  };
  const endDrag = () => {
    if (!armed) return;
    armed = false;
    setDragActive(false);
    try { clipRef?.releasePointerCapture(pid); } catch { /* ignore */ }
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

  // ── Measure the card width (slide distance) + tallest card (clip height) ─────────
  const measure = () => {
    if (clipRef) setClipW(clipRef.clientWidth);
    if (stageRef) {
      let h = 0;
      stageRef.querySelectorAll('.wos-feed-slot').forEach(el => { h = Math.max(h, (el as HTMLElement).offsetHeight); });
      if (h > 0) setClipH(h);
    }
  };
  onMount(() => {
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && clipRef) { ro = new ResizeObserver(() => measure()); ro.observe(clipRef); }
    onCleanup(() => ro?.disconnect());
  });

  // Re-justify the visible cards whenever the window changes, then re-measure height (justify
  // changes line count → height). Each finding owns its node, so justify never desyncs.
  createEffect(() => {
    prevCard(); current(); next(); clipW();
    requestAnimationFrame(() => {
      void justifyElements(stageRef ? Array.from(stageRef.querySelectorAll('.wos-justify')) as HTMLElement[] : [])
        .then(measure);
      measure();
    });
  });

  // Per-card transform: each slot is positioned by its offset from the current card, plus the
  // shared drag/slide translation. The current card is at offset 0 (centred); neighbours sit
  // one card-width + GAP to either side (off-screen at rest).
  const slotTransform = (i: number) => `translateX(${(i - currentIdx()) * step() + dragX()}px)`;

  return (
    <div ref={stageRef} style={s.feedStage}>
      {/* Desktop only: clickable arrows out in the margin gutter (not on the card). */}
      <Show when={inputClass() === 'pointer'}>
        <button
          style={{ ...s.feedArrowBtn, ...s.feedArrowLeft, ...(canBack() ? {} : s.feedArrowBtnDisabled) }}
          onClick={goPrev} disabled={!canBack()} aria-label="Previous entry"
        >{'←'}</button>
        <button
          style={{ ...s.feedArrowBtn, ...s.feedArrowRight, ...(canNext() ? {} : s.feedArrowBtnDisabled) }}
          onClick={goNext} disabled={!canNext()} aria-label="Next entry"
        >{'→'}</button>
      </Show>

      <div
        ref={clipRef}
        style={{
          ...s.feedClip,
          position: 'relative',
          ...(clipH() ? { 'min-height': `${clipH()}px` } : {}),
          ...(dragActive() ? { 'user-select': 'none', '-webkit-user-select': 'none' } : {}),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div aria-live="polite" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {current()?.title ?? ''}
        </div>
        {/* Reference-keyed: each finding keeps its node across prev/current/next roles, so the
            slide is seamless and justify can never desync a reused card. */}
        <For each={slots()}>
          {(f, i) => (
            <div
              class="wos-feed-slot"
              style={{
                position: 'absolute', top: '0', left: '0', width: '100%',
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
    </div>
  );
}
