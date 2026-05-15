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
    ],
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/main/encoding.js',
        'src/main/file-hash.js',
        'src/renderer/src/core/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80
      }
    }
  }
})
