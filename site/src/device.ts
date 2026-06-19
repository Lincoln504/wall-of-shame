// device.ts — reactive input-class + reduced-motion signals for the feed.
//
// inputClass(): 'touch' (mobile — swipe only, NO side buttons; vertical screens can't spare
// the width) vs 'pointer' (desktop — side arrow buttons + drag + keys). The drag/flick gesture
// itself is unified Pointer Events either way; this only decides whether to render the arrows
// and which affordance hint to show. Primary signal is `(pointer: coarse)`, so a touchscreen
// LAPTOP with a mouse reports `fine` → pointer/arrows (correct). Listens for live changes
// (hybrid devices, dock/undock, orientation) and cleans up via onCleanup.

import { createSignal, onCleanup } from 'solid-js';

export type InputClass = 'touch' | 'pointer';

function detectInputClass(): InputClass {
  if (typeof window === 'undefined' || !window.matchMedia) return 'pointer';
  if (window.matchMedia('(pointer: coarse)').matches) return 'touch';
  if (window.matchMedia('(pointer: none)').matches && (navigator.maxTouchPoints || 0) > 0) return 'touch';
  return 'pointer';
}

export function useInputClass(): () => InputClass {
  const [cls, setCls] = createSignal<InputClass>(detectInputClass());
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCls(detectInputClass());
    mq.addEventListener('change', update);
    onCleanup(() => mq.removeEventListener('change', update));
  }
  return cls;
}

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
