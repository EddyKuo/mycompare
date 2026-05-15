import { describe, it, expect } from 'vitest'
import { getViewTypeForPath } from '../../src/renderer/src/core/file-type.js'

describe('getViewTypeForPath', () => {
  // ── image ──────────────────────────────────────────────────────────────────
  describe('image extensions', () => {
    it('returns image for .png', () => {
      expect(getViewTypeForPath('photo.png')).toBe('image')
    })
    it('returns image for .jpg', () => {
      expect(getViewTypeForPath('photo.jpg')).toBe('image')
    })
    it('returns image for .jpeg', () => {
      expect(getViewTypeForPath('photo.jpeg')).toBe('image')
    })
    it('returns image for .gif', () => {
      expect(getViewTypeForPath('anim.gif')).toBe('image')
    })
    it('returns image for .bmp', () => {
      expect(getViewTypeForPath('icon.bmp')).toBe('image')
    })
    it('returns image for .webp', () => {
      expect(getViewTypeForPath('img.webp')).toBe('image')
    })
    it('returns image for .ico', () => {
      expect(getViewTypeForPath('favicon.ico')).toBe('image')
    })
    it('returns image for .tiff', () => {
      expect(getViewTypeForPath('scan.tiff')).toBe('image')
    })
    it('returns image for .tif', () => {
      expect(getViewTypeForPath('scan.tif')).toBe('image')
    })
    it('returns image for .svg', () => {
      expect(getViewTypeForPath('logo.svg')).toBe('image')
    })
    it('returns image for uppercase extension .PNG', () => {
      expect(getViewTypeForPath('photo.PNG')).toBe('image')
    })
    it('returns image for path with directories', () => {
      expect(getViewTypeForPath('C:/Users/foo/image.jpg')).toBe('image')
    })
    it('returns image for Windows backslash path', () => {
      expect(getViewTypeForPath('C:\\Users\\foo\\image.jpg')).toBe('image')
    })
  })

  // ── table ──────────────────────────────────────────────────────────────────
  describe('table extensions', () => {
    it('returns table for .csv', () => {
      expect(getViewTypeForPath('data.csv')).toBe('table')
    })
    it('returns table for .tsv', () => {
      expect(getViewTypeForPath('data.tsv')).toBe('table')
    })
    it('returns table for .xlsx', () => {
      expect(getViewTypeForPath('report.xlsx')).toBe('table')
    })
    it('returns table for .xls', () => {
      expect(getViewTypeForPath('report.xls')).toBe('table')
    })
    it('returns table for uppercase .CSV', () => {
      expect(getViewTypeForPath('DATA.CSV')).toBe('table')
    })
  })

  // ── hex ────────────────────────────────────────────────────────────────────
  describe('hex extensions', () => {
    it('returns hex for .exe', () => {
      expect(getViewTypeForPath('app.exe')).toBe('hex')
    })
    it('returns hex for .dll', () => {
      expect(getViewTypeForPath('lib.dll')).toBe('hex')
    })
    it('returns hex for .bin', () => {
      expect(getViewTypeForPath('fw.bin')).toBe('hex')
    })
    it('returns hex for .dat', () => {
      expect(getViewTypeForPath('data.dat')).toBe('hex')
    })
    it('returns hex for .so', () => {
      expect(getViewTypeForPath('libfoo.so')).toBe('hex')
    })
    it('returns hex for .class', () => {
      expect(getViewTypeForPath('Main.class')).toBe('hex')
    })
    it('returns hex for .wasm', () => {
      expect(getViewTypeForPath('module.wasm')).toBe('hex')
    })
    it('returns hex for .zip', () => {
      expect(getViewTypeForPath('archive.zip')).toBe('hex')
    })
    it('returns hex for .gz', () => {
      expect(getViewTypeForPath('archive.tar.gz')).toBe('hex')
    })
    it('returns hex for .pdf', () => {
      expect(getViewTypeForPath('doc.pdf')).toBe('hex')
    })
    it('returns hex for .docx', () => {
      expect(getViewTypeForPath('report.docx')).toBe('hex')
    })
    it('returns hex for .EXE uppercase', () => {
      expect(getViewTypeForPath('SETUP.EXE')).toBe('hex')
    })
  })

  // ── text (default) ─────────────────────────────────────────────────────────
  describe('text extensions (default)', () => {
    it('returns text for .js', () => {
      expect(getViewTypeForPath('app.js')).toBe('text')
    })
    it('returns text for .ts', () => {
      expect(getViewTypeForPath('app.ts')).toBe('text')
    })
    it('returns text for .txt', () => {
      expect(getViewTypeForPath('notes.txt')).toBe('text')
    })
    it('returns text for .md', () => {
      expect(getViewTypeForPath('README.md')).toBe('text')
    })
    it('returns text for .json', () => {
      expect(getViewTypeForPath('config.json')).toBe('text')
    })
    it('returns text for .html', () => {
      expect(getViewTypeForPath('index.html')).toBe('text')
    })
    it('returns text for .css', () => {
      expect(getViewTypeForPath('style.css')).toBe('text')
    })
    it('returns text for .py', () => {
      expect(getViewTypeForPath('script.py')).toBe('text')
    })
  })

  // ── edge cases ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns text for null', () => {
      expect(getViewTypeForPath(null)).toBe('text')
    })
    it('returns text for undefined', () => {
      expect(getViewTypeForPath(undefined)).toBe('text')
    })
    it('returns text for empty string', () => {
      expect(getViewTypeForPath('')).toBe('text')
    })
    it('returns text for path with no extension', () => {
      expect(getViewTypeForPath('Makefile')).toBe('text')
    })
    it('returns text for path ending with dot', () => {
      expect(getViewTypeForPath('file.')).toBe('text')
    })
    it('returns text for hidden file without extension (e.g. .gitignore)', () => {
      expect(getViewTypeForPath('.gitignore')).toBe('text')
    })
  })
})
