import { render } from 'solid-js/web';
import App from './App.js';

// Self-hosted sans-serif type (no external CDN — works on GitHub Pages offline).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

render(() => <App />, document.getElementById('root')!);
