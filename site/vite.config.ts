import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  base: '/wall-of-shame/',
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});
