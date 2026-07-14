/**
 * Vite config — only used for the demo HTML page (`npm run demo`).
 * The library itself ships via `tsc` to dist/; Vite is not on the publish path.
 *
 * The demo lives in `demo/` and imports from `../src`, which is outside the
 * demo root. We tell Vite to allow filesystem reads upward so dev-server and
 * `vite build` both resolve the source tree.
 */
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const projectRoot = __dirname

export default defineConfig({
  // Relative base so the built demo works under any subpath (e.g. poqpoq.com/babylon-outline/)
  base: './',
  root: resolve(projectRoot, 'demo'),
  server: {
    fs: {
      // Allow imports from the parent (so `../src/index` resolves cleanly)
      allow: [projectRoot],
    },
    open: true,
  },
  build: {
    outDir: resolve(projectRoot, 'demo-dist'),
    emptyOutDir: true,
  },
})
