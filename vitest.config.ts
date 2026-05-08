/**
 * Vitest config — kept separate from vite.config.ts because that file sets
 * `root: 'demo'` for the demo dev-server, which would also reroute vitest's
 * test discovery and produce "No test files found." Vitest auto-prefers
 * vitest.config.ts when present, so the two contexts coexist cleanly.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
