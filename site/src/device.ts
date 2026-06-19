// device.ts — reactive prefers-reduced-motion signal for the feed's slide animation.
//
// (Input class no longer matters: the feed uses one Pointer Events drag for mouse + touch,
// so desktop and mobile share the exact same side-to-side navigation.)

import { createSignal, onCleanup } from 'solid-js';

export function usePrefersReducedMotion(): () => boolean {
  const supported = typeof window !== 'undefined' && !!window.matchMedia;
  const mq = supported ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = createSignal(mq ? mq.matches : false);
  if (mq) {
    const update = () => setReduced(mq.matches);
    mq.addEventListener('change', update);
    onCleanup(() => mq.removeEventListener('change', update));
  }
  return reduced;
}
