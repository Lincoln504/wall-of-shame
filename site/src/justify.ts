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
 * after a pass, so we re-justify on a debounced resize.
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

/** Register a debounced resize handler that re-justifies. Returns a disposer. */
export function onResizeRejustify(getEls: () => HTMLElement[], delay = 150): () => void {
  let t: number | undefined;
  const handler = () => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => void justifyElements(getEls()), delay);
  };
  window.addEventListener('resize', handler);
  return () => {
    if (t) clearTimeout(t);
    window.removeEventListener('resize', handler);
  };
}
