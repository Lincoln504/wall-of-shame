/**
 * counter.ts — total + daily-UTC visitor counts for the static site.
 *
 * Backed by a tiny Cloudflare Worker + KV (see worker/visitor-counter.js). The
 * endpoint is injected at build time via VITE_COUNTER_URL; when it is absent the
 * counter is simply not shown (the site stays fully functional without it).
 *
 * "Daily" resets at 00:00 UTC: the worker keys today's count by the UTC date
 * string, so the rollover is automatic and server-side. We de-dupe per browser
 * session (sessionStorage) — the first load of a session increments, later loads
 * only read (?peek=1) — so refreshes don't inflate the count.
 */

import { createSignal, onMount } from 'solid-js';

export interface VisitCounts {
  total: number;
  today: number;
}

const ENDPOINT = (import.meta.env.VITE_COUNTER_URL as string | undefined)?.trim();
const SESSION_FLAG = 'wos-visit-counted';

export function counterEnabled(): boolean {
  return !!ENDPOINT;
}

/** A reactive accessor for the visit counts (null until loaded / if disabled). */
export function useVisitCounts() {
  const [counts, setCounts] = createSignal<VisitCounts | null>(null);

  onMount(async () => {
    if (!ENDPOINT) return;
    let alreadyCounted = false;
    try {
      alreadyCounted = sessionStorage.getItem(SESSION_FLAG) === '1';
    } catch { /* sessionStorage may be unavailable */ }

    const url = alreadyCounted ? `${ENDPOINT}?peek=1` : ENDPOINT;
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<VisitCounts>;
      if (typeof data.total === 'number' && typeof data.today === 'number') {
        setCounts({ total: data.total, today: data.today });
      }
      if (!alreadyCounted) {
        try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch { /* ignore */ }
      }
    } catch {
      /* network/CORS error — leave the counter hidden */
    }
  });

  return counts;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
