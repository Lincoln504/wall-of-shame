/**
 * counter.ts — total + daily-UTC visitor counts for the static site.
 *
 * Two backends, in priority order:
 *   1. A self-hosted Cloudflare Worker (set VITE_COUNTER_URL) returning {total,today}.
 *   2. Otherwise the free, no-account Abacus hit-counter API (zero setup) — works
 *      out of the box. Total lives in one key; "today" lives in a per-UTC-day key
 *      (d<YYYYMMDD>), so it resets automatically at 00:00 UTC (a new key starts at 0).
 *
 * We de-dupe per browser session (sessionStorage): the first load of a session
 * increments; later loads only read — so refreshes don't inflate the count.
 * Any network/CORS failure leaves the counter hidden; the site works without it.
 */

import { createSignal, onMount } from 'solid-js';

export interface VisitCounts {
  total: number;
  today: number;
}

const WORKER_URL = (import.meta.env.VITE_COUNTER_URL as string | undefined)?.trim();
const ABACUS_NS = 'wall-of-shame-lincoln504';
const ABACUS_BASE = 'https://abacus.jasoncameron.dev';
const SESSION_FLAG = 'wos-visit-counted';

export function counterEnabled(): boolean {
  return true; // Abacus is the always-available default backend.
}

function utcDayKey(): string {
  return 'd' + new Date().toISOString().slice(0, 10).replace(/-/g, ''); // d20260616
}

async function fetchNum(url: string): Promise<number | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: number; count?: number };
    const n = data.value ?? data.count;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

async function loadViaWorker(peek: boolean): Promise<VisitCounts | null> {
  try {
    const res = await fetch(peek ? `${WORKER_URL}?peek=1` : WORKER_URL!);
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<VisitCounts>;
    if (typeof d.total === 'number' && typeof d.today === 'number') return { total: d.total, today: d.today };
  } catch { /* fall through */ }
  return null;
}

async function loadViaAbacus(peek: boolean): Promise<VisitCounts | null> {
  const verb = peek ? 'get' : 'hit';
  const day = utcDayKey();
  const [total, today] = await Promise.all([
    fetchNum(`${ABACUS_BASE}/${verb}/${ABACUS_NS}/total`),
    fetchNum(`${ABACUS_BASE}/${verb}/${ABACUS_NS}/${day}`),
  ]);
  if (total == null && today == null) return null;
  return { total: total ?? 0, today: today ?? 0 };
}

/** Reactive accessor for the visit counts (null until loaded / on failure). */
export function useVisitCounts() {
  const [counts, setCounts] = createSignal<VisitCounts | null>(null);

  onMount(async () => {
    let alreadyCounted = false;
    try { alreadyCounted = sessionStorage.getItem(SESSION_FLAG) === '1'; } catch { /* ignore */ }
    const peek = alreadyCounted;

    const result = WORKER_URL ? await loadViaWorker(peek) : await loadViaAbacus(peek);
    if (result) {
      setCounts(result);
      if (!alreadyCounted) {
        try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch { /* ignore */ }
      }
    }
  });

  return counts;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
