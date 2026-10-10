import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { buildId } from './tools/build-id.ts';

// Dev-only: point the dev server's /rest proxy at a real Navidrome, e.g.
//   NAVILITE_DEV_SERVER=https://alienlab.tailbed832.ts.net npm run dev
// With no override it proxies to the local mock (npm run mock), which serves the
// built app and a synthetic Subsonic library on one origin — the same-origin shape
// Navilite is designed around.
const devTarget = process.env.NAVILITE_DEV_SERVER ?? 'http://127.0.0.1:4533';

/**
 * public/sw.js carries a __BUILD_ID__ placeholder; stamping the real value into
 * dist/sw.js is what makes a new deploy evict the old shell cache. The source file
 * stays diff-stable, and dist/ is gitignored.
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'navilite-sw-build-id',
    apply: 'build',
    closeBundle() {
      const file = resolve(import.meta.dirname, 'dist/sw.js');
      if (!existsSync(file)) return;
      const stamped = readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', buildId());
      writeFileSync(file, stamped);
    },
  };
}

export default defineConfig({
  // Relative base: the same dist/ has to work from a subpath behind the reverse
  // proxy and from the Capacitor webview's own origin.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/rest': { target: devTarget, changeOrigin: true, secure: false },
    },
  },
  plugins: [stampServiceWorker()],
});
