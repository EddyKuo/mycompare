import globals from 'globals'

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        __testAPI: 'writable',
        electronAPI: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-with': 'error'
    }
  },
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'tests/**', '*.config.js']
  }
]
