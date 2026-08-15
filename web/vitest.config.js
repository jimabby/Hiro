import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Renderer tests only.
//
// The main-process suites in test/ run under plain Node (`node test/run.js`) and
// deliberately have no framework — they exercise services that need no DOM. The
// renderer needs one, so it gets its own runner rather than dragging jsdom into
// the fast suite. `npm test` runs both.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/renderer/**/*.test.jsx'],
    setupFiles: ['test/renderer/setup.js'],
    restoreMocks: true,
  },
})
