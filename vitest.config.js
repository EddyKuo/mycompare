import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/unit/text-compare-view.test.js', 'jsdom'],
      ['tests/unit/text-compare-*.test.js', 'jsdom'],
      ['tests/unit/three-way-*.test.js', 'jsdom'],
      ['tests/unit/utils.test.js', 'jsdom'],
      ['tests/unit/folder-compare.test.js', 'jsdom'],
      // S15-U03/U09: toast/modal/i18n + S13/S14 regression suites
      ['tests/unit/s13-*.test.js', 'jsdom'],
      ['tests/unit/s14-*.test.js', 'jsdom'],
      ['tests/unit/s15-*.test.js', 'jsdom'],
    ],
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/main/**',
        'src/renderer/src/core/**',
        'src/renderer/src/views/**',
      ],
      exclude: [
        'src/main/index.js',         // entry — covered by e2e
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80
      }
    }
  }
})
