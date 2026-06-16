/**
 * visitor-counter.js — Cloudflare Worker: total + daily-UTC visitor counts.
 *
 * KV scheme (binding name: COUNTER):
 *   total              — lifetime counter, never expires.
 *   visits:YYYY-MM-DD  — one key per UTC day, TTL ~48h so old days self-purge.
 *                        The date is computed server-side from the UTC clock, so
 *                        "today" resets automatically at 00:00 UTC. No cron needed.
 *
 * Requests:
 *   GET /            → increment total + today, return { total, today }
 *   GET /?peek=1     → read-only, return { total, today } without incrementing
 *   OPTIONS /        → CORS preflight
 *
 * The client de-dupes per session (sessionStorage), so writes ≈ unique sessions,
 * staying well under the free tier's 1k KV writes/day (2 writes per counted visit).
 *
 * Deploy: see worker/README.md.
 */

const ALLOW_ORIGIN = '*'; // tighten to 'https://lincoln504.github.io' if desired

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    const url = new URL(request.url);
    const peek = url.searchParams.get('peek') === '1';

    const day = new Date().toISOString().slice(0, 10); // UTC date
    const dayKey = `visits:${day}`;

    let total = parseInt((await env.COUNTER.get('total')) || '0', 10) || 0;
    let today = parseInt((await env.COUNTER.get(dayKey)) || '0', 10) || 0;

    if (!peek) {
      total += 1;
      today += 1;
      await Promise.all([
        env.COUNTER.put('total', String(total)),
        env.COUNTER.put(dayKey, String(today), { expirationTtl: 172800 }), // 48h
      ]);
    }

    return json({ total, today });
  },
};
