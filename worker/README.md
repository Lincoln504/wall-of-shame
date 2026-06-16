# Visitor counter worker

A tiny free Cloudflare Worker that returns total + daily-UTC visitor counts for the
Wall of Shame site. Free tier is ample: 100k requests/day, 100k KV reads/day, 1k KV
writes/day; Cloudflare's quotas reset at 00:00 UTC, matching the daily counter.

## Deploy (one-time, ~5 min)

1. Create a free Cloudflare account, then install Wrangler: `npm i -g wrangler` and
   `wrangler login`.
2. Create a KV namespace:
   ```bash
   wrangler kv namespace create COUNTER
   ```
   Copy the returned `id`.
3. Create `wrangler.toml` next to `visitor-counter.js`:
   ```toml
   name = "wos-visitor-counter"
   main = "visitor-counter.js"
   compatibility_date = "2026-01-01"

   [[kv_namespaces]]
   binding = "COUNTER"
   id = "<paste-the-id-from-step-2>"
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```
   Wrangler prints the public URL, e.g. `https://wos-visitor-counter.<you>.workers.dev`.

## Wire it into the site

Set the URL as a build-time env var so the site renders the counter:

```bash
# in site/, for local dev:
echo 'VITE_COUNTER_URL=https://wos-visitor-counter.<you>.workers.dev' > .env.local
```

For the GitHub Pages deploy, add `VITE_COUNTER_URL` to the build step in
`.github/workflows/deploy.yml` (as a repo Actions **variable**, not a secret —
it's a public URL):

```yaml
      - name: Build site
        working-directory: site
        run: npm run build
        env:
          VITE_COUNTER_URL: ${{ vars.VITE_COUNTER_URL }}
```

Until `VITE_COUNTER_URL` is set the site simply omits the counter — everything else
works unchanged.

## Behaviour

- `GET /` increments `total` and `visits:<UTC-date>` and returns `{ total, today }`.
- `GET /?peek=1` returns the counts without incrementing (used after the first load
  of a browser session, so refreshes don't inflate the count).
- The daily key carries a 48h TTL and rolls over automatically at 00:00 UTC.
