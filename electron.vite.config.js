import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: 'src/main/index.js'
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.js',
        output: {
          format: 'cjs',
          // Electron 33+ respects package.json "type":"module" when require()-ing
          // the preload, so the file must use a .cjs extension.
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
})
