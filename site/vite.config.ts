import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  // Served from the apex custom domain wallofshame.io, so assets live at the site root.
  base: '/',
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});
