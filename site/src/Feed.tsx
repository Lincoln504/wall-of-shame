// Feed.tsx — one-card-at-a-time feed (the default browsing experience).
//
// Side-to-side on BOTH desktop and mobile, via ONE Pointer Events implementation: a mouse
// click-drag on desktop and a touch flick on mobile are the same gesture here. Carousel
// arrows overlay the card edges on both; ←/→ (and ↑/↓) keys also advance. Drag only engages
// after a few px of movement, so taps/clicks on links and the Share button pass through.
// touch-action: pan-y keeps vertical page scroll working, so the header stays reachable.
//
// Card selection is delegated to the pure weighted-random sequencer (sequencer.ts), fed the
// dwell time on the entry just left so lingering gently nudges toward similar content.
import { createSignal, createMemo, createEffect, on, onMount, onCleanup, Show } from 'solid-js';
import type { Finding } from './types.js';
import FindingCard from './FindingCard.js';
import { createSequencer } from './sequencer.js';
import { useInputClass, usePrefersReducedMotion } from './device.js';
import { justifyElements, onResizeRejustify } from './justify.js';
import { s } from './styles.js';

// One seed per page load: the feed isn't byte-identical across reloads, but "prev" within a
// session is exact. (Date.now in the browser is fine — the no-Date rule is workflow-only.)
const SESSION_SEED = (Date.now() & 0xffffffff) >>> 0;

const ENGAGE_PX = 6;     // movement before a press becomes a drag (taps/clicks pass through)
const COMMIT_PX = 70;    // drag distance that commits a move
const FLICK_V = 0.45;    // px/ms velocity that commits a move (a quick flick)
const SLIDE_MS = 190;    // slide animation duration

export default function Feed(props: { findings: Finding[]; onShare: (f: Finding) => void }) {
  const reducedMotion = usePrefersReducedMotion();
  const inputClass = useInputClass(); // 'pointer' → show side arrows; 'touch' → swipe only

  // A fresh sequencer whenever the candidate pool changes (data load or category/severity filter).
  const seq = createMemo(() => createSequencer(props.findings, SESSION_SEED));
  const [current, setCurrent] = createSignal<Finding | null>(null);
  const [prevStack, setPrevStack] = createSignal<Finding[]>([]);
  const canBack = createMemo(() => prevStack().length > 0);

  const [dragX, setDragX] = createSignal(0);
  const [sliding, setSliding] = createSignal(false); // CSS transform transition on/off

  let shownAt = performance.now();
  let busy = false;            // one move at a time (covers buttons, keys, and slide animation)
  let stageRef: HTMLDivElement | undefined;
  let motionEl: HTMLDivElement | undefined;

  // drag bookkeeping
  let armed = false, dragging = false, startX = 0, startT = 0, pid = -1;

  // Seed / reseed the feed when the pool changes.
  createEffect(on(seq, (sequencer) => {
    setPrevStack([]);
    setCurrent(sequencer.next(0));
    setDragX(0);
    shownAt = performance.now();
  }));

  const dwellMs = () => performance.now() - shownAt;

  const advance = () => {
    const nxt = seq().next(dwellMs());
    if (!nxt) return;
    const cur = current();
    if (cur) setPrevStack(st => [...st, cur]);
    setCurrent(nxt);
    shownAt = performance.now();
  };
  const back = () => {
    const st = prevStack();
    if (!st.length) return;
    setCurrent(st[st.length - 1]);
    setPrevStack(st.slice(0, -1));
    shownAt = performance.now();
  };

  // Animate: slide the current card out, swap content, slide the incoming card in from the
  // opposite edge. reducedMotion → instant swap.
  const commitMove = (goNext: boolean) => {
    if (busy) return;
    if (!goNext && !canBack()) return;
    busy = true;
    if (reducedMotion()) { goNext ? advance() : back(); setDragX(0); busy = false; return; }
    const w = motionEl?.offsetWidth || 360;
    setSliding(true);
    setDragX(goNext ? -w : w);
    window.setTimeout(() => {
      goNext ? advance() : back();
      setSliding(false);
      setDragX(goNext ? w * 0.45 : -w * 0.45);
      requestAnimationFrame(() => { setSliding(true); setDragX(0); });
      window.setTimeout(() => { busy = false; }, SLIDE_MS);
    }, SLIDE_MS);
  };
  const next = () => commitMove(true);
  const prev = () => commitMove(false);

  // ── Pointer drag (mouse + touch, unified) ──────────────────────────────────────
  const onPointerDown = (e: PointerEvent) => {
    if (busy) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
    armed = true; dragging = false; startX = e.clientX; startT = performance.now(); pid = e.pointerId;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!armed) return;
    const dx = e.clientX - startX;
    if (!dragging) {
      if (Math.abs(dx) < ENGAGE_PX) return;
      dragging = true;
      setSliding(false);
      try { motionEl?.setPointerCapture(pid); } catch { /* ignore */ }
    }
    setDragX(dx > 0 && !canBack() ? dx * 0.25 : dx); // resist when there's nothing to go back to
  };
  const endDrag = () => {
    if (!armed) return;
    armed = false;
    try { motionEl?.releasePointerCapture(pid); } catch { /* ignore */ }
    if (!dragging) return; // was a tap/click — let it through (link / Share button)
    dragging = false;
    const dx = dragX();
    const v = dx / Math.max(1, performance.now() - startT);
    const goNext = dx < 0;
    const commit = (Math.abs(dx) > COMMIT_PX || Math.abs(v) > FLICK_V) && (goNext || canBack());
    if (commit) commitMove(goNext);
    else { setSliding(true); setDragX(0); } // snap back
  };

  // ── Keyboard ────────────────────────────────────────────────────────────────────
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // don't hijack search/filters
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prev(); }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  // ── Re-justify the single card on every swap (mirrors the list view) ───────────
  const collect = () => (stageRef ? Array.from(stageRef.querySelectorAll('.wos-justify')) as HTMLElement[] : []);
  createEffect(() => { current(); requestAnimationFrame(() => void justifyElements(collect())); });
  onMount(() => { const dispose = onResizeRejustify(collect); onCleanup(dispose); });

  return (
    <div ref={stageRef}>
      <div style={s.feedStage}>
        {/* Desktop only: clickable carousel arrows. Mobile is swipe-only (no width to spare). */}
        <Show when={inputClass() === 'pointer'}>
          <button
            style={{ ...s.feedArrowBtn, ...s.feedArrowLeft, ...(canBack() ? {} : s.feedArrowBtnDisabled) }}
            onClick={prev} disabled={!canBack()} aria-label="Previous entry"
          >←</button>
        </Show>

        <div
          ref={motionEl}
          style={{ ...s.feedMotion, transform: `translateX(${dragX()}px)`, transition: sliding() ? `transform ${SLIDE_MS}ms ease` : 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div aria-live="polite">
            <Show when={current()} fallback={<div style={s.empty}>No entries found.</div>}>
              <FindingCard finding={current()!} onShare={props.onShare} variant="feed" />
            </Show>
          </div>
        </div>

        <Show when={inputClass() === 'pointer'}>
          <button
            style={{ ...s.feedArrowBtn, ...s.feedArrowRight }}
            onClick={next} aria-label="Next entry"
          >→</button>
        </Show>
      </div>

      {/* Affordance: on touch, make the side-to-side swipe explicit (no buttons to imply it). */}
      <Show
        when={inputClass() === 'touch'}
        fallback={<div style={s.feedHint}>Drag, use the side arrows, or ← → keys</div>}
      >
        <div class="wos-swipe-hint" style={s.feedSwipeHint}>
          <span style={s.feedSwipeChev} aria-hidden="true">‹</span>
          <span>swipe sideways to browse</span>
          <span style={s.feedSwipeChev} aria-hidden="true">›</span>
        </div>
      </Show>
    </div>
  );
}
