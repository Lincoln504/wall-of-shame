import { render } from 'solid-js/web';
import App from './App.js';

// Self-hosted sans-serif type (no external CDN — works on GitHub Pages offline).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

// Recover from a stale dynamically-imported chunk after a deploy. When a new version
// ships while this tab is open, the lazy chunk hashes change and the old ones are removed,
// so an import() 404s (GitHub Pages serves the HTML 404 page → "disallowed MIME type").
// Vite raises 'vite:preloadError' in that case; reload ONCE to pull the fresh index +
// chunks. A sessionStorage guard prevents a reload loop if the import fails for any other
// reason (e.g. the user is genuinely offline).
window.addEventListener('vite:preloadError', (e) => {
  // Recover from each stale chunk (this site deploys frequently, so a long-open tab's lazy
  // chunk hashes go missing repeatedly), but never tight-loop: reload at most once per 20s.
  // If a reload doesn't fix it (genuinely broken chunk, offline), the window guard stops it.
  const now = Date.now();
  const last = Number(sessionStorage.getItem('wos-chunk-reload-at') || 0);
  if (now - last < 20000) return;
  sessionStorage.setItem('wos-chunk-reload-at', String(now));
  e.preventDefault();
  location.reload();
});

// Proactively pull the latest app after a deploy. When the tab regains focus, compare the
// running ENTRY bundle filename (its content hash changes ONLY when code changes — data-only
// deploys keep it stable, so this never reload-storms during constant ingestion) against the
// live index.html. A mismatch means this tab is running a stale bundle → reload to the fresh
// app + data. This is what stops a user from being stuck on an old, buggy build. import.meta.url
// is the running chunk's own URL; if it doesn't look hashed (dev), the check is inert (safe).
const CURRENT_ENTRY = (import.meta.url.match(/index-[A-Za-z0-9_-]+\.js/) || [])[0] || '';
let lastUpdateCheck = 0;
function checkForUpdate() {
  if (!CURRENT_ENTRY || document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastUpdateCheck < 30_000) return; // throttle network checks
  lastUpdateCheck = now;
  fetch(`${import.meta.env.BASE_URL}?_=${now}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
      if (!m) return;
      if (m[0] !== CURRENT_ENTRY) {
        if (sessionStorage.getItem('wos-stale-reloaded') === '1') return; // guard against a reload loop
        sessionStorage.setItem('wos-stale-reloaded', '1');
        location.reload();
      } else {
        sessionStorage.removeItem('wos-stale-reloaded');
      }
    })
    .catch(() => { /* offline / transient — try again next focus */ });
}
document.addEventListener('visibilitychange', checkForUpdate);
window.addEventListener('focus', checkForUpdate);

render(() => <App />, document.getElementById('root')!);
