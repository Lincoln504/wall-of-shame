/**
 * justify.ts — TeX (Knuth-Plass) justification of article text on the page.
 *
 * Plain CSS `text-align: justify` uses the browser's greedy first-fit and leaves
 * rivers/large gaps in narrow columns. tex-linebreak runs the Knuth-Plass total-fit
 * algorithm with TeX en-us hyphenation for properly even spacing.
 *
 * The library is loaded lazily (it + the hyphenation pattern table are only needed
 * once text is on screen) and applied imperatively as a side effect — it mutates
 * the DOM (inserts <br>, wraps words, sets word-spacing), so it must run AFTER the
 * framework renders and re-run when the content or width changes. Layout is frozen
 * after a pass, so we re-justify only when the column WIDTH changes — never on a
 * height-only change such as a mobile URL bar showing/hiding during scroll (see
 * onResizeRejustify). Line breaking depends solely on width, so re-running on scroll
 * would be wasted work that visibly reflows the text.
 */

type JustifyFn = (els: HTMLElement | HTMLElement[], hyphenateFn?: (w: string) => string[]) => void;
type UnjustifyFn = (el: HTMLElement) => void;

let libPromise: Promise<{ justify: JustifyFn; unjustify: UnjustifyFn; hyphenate: (w: string) => string[] }> | null = null;

async function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      const [tl, pat] = await Promise.all([
        import('tex-linebreak'),
        import('hyphenation.en-us'),
      ]);
      const patterns = (pat as any).default ?? pat;
      const hyphenate = tl.createHyphenator(patterns);
      return { justify: tl.justifyContent as JustifyFn, unjustify: tl.unjustifyContent as UnjustifyFn, hyphenate };
    })();
  }
  return libPromise;
}

/**
 * Justify the given elements. Waits for web fonts so measurement matches render,
 * reverses any previous pass first (idempotent), and silently no-ops on failure
 * (the elements keep their CSS `text-align: justify` fallback).
 */
export async function justifyElements(els: HTMLElement[]): Promise<void> {
  if (!els.length) return;
  try {
    const lib = await loadLib();
    if (document.fonts?.ready) await document.fonts.ready;
    for (const el of els) {
      try { lib.unjustify(el); } catch { /* not previously justified */ }
    }
    lib.justify(els, lib.hyphenate);
  } catch {
    /* keep CSS fallback */
  }
}

/**
 * Re-justify ONLY when the layout WIDTH changes — never on a height-only change.
 *
 * Knuth-Plass line breaking depends solely on the column width, but a naive `resize`
 * listener also fires when a mobile browser's URL bar shows/hides during scroll (that
 * changes the visual-viewport HEIGHT, not the width). Re-justifying then is wasted work
 * that visibly reflows the text as you scroll. We watch document.documentElement's width
 * — which is immune to URL-bar height changes — via ResizeObserver, and skip unless it
 * actually moved. Returns a disposer.
 */
export function onResizeRejustify(getEls: () => HTMLElement[], delay = 150): () => void {
  let t: number | undefined;
  const root = document.documentElement;
  // Measure window.innerWidth (which INCLUDES the scrollbar), NOT documentElement.clientWidth
  // (which EXCLUDES it). When a justify pass makes the page tall enough to toggle the vertical
  // scrollbar, clientWidth jumps by the scrollbar width (~15px); observed as a "width change"
  // that re-justifies, which can toggle the scrollbar again — a feedback loop that pegs the CPU
  // and freezes the tab. innerWidth is immune to scrollbar toggling, and a threshold absorbs
  // any remaining jitter so ONLY a real column-width change re-justifies.
  const widthNow = () => window.innerWidth;
  let lastW = widthNow();
  const schedule = () => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => void justifyElements(getEls()), delay);
  };
  const onMaybeWidthChange = () => {
    const w = widthNow();
    if (Math.abs(w - lastW) < 24) return;   // scrollbar toggle / sub-threshold jitter — ignore
    lastW = w;
    schedule();
  };

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onMaybeWidthChange);
    ro.observe(root);
    return () => { if (t) clearTimeout(t); ro.disconnect(); };
  }
  // Fallback for browsers without ResizeObserver: width-gated window resize.
  window.addEventListener('resize', onMaybeWidthChange);
  return () => { if (t) clearTimeout(t); window.removeEventListener('resize', onMaybeWidthChange); };
}
