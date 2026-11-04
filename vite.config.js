import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Cloudflare's GitHub builds set WORKERS_CI_COMMIT_SHA; locally it is empty.
const commit = (process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || '').slice(0, 7);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
