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
  if (sessionStorage.getItem('wos-chunk-reloaded') === '1') return;
  sessionStorage.setItem('wos-chunk-reloaded', '1');
  e.preventDefault();
  location.reload();
});

render(() => <App />, document.getElementById('root')!);
