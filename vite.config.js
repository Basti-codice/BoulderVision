import { defineConfig } from 'vite';

// Relative base so the build also works from a sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  esbuild: { target: 'es2022' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
});
