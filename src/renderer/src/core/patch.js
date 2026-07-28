/**
 * @file patch.js
 * @description Unified diff parsing, shared by the text compare view and the
 *   standalone Text Patch view.
 *
 *   It lives here rather than inside a view because two views read patches
 *   now, and a second parser is exactly how the two would come to disagree
 *   about what a malformed hunk means.
 */

// ---------------------------------------------------------------------------
// P2-25: unified diff (patch) parsing
//
// Pure, DOM-free functions so the format handling can be tested directly.
// Every malformed input raises UnifiedDiffParseError instead of producing a
// half-parsed result: a patch viewer that silently drops lines is worse than
// one that refuses the file, because the user cannot tell the difference.
// ---------------------------------------------------------------------------

/** Thrown by parseUnifiedDiff() when the input is not a well-formed patch. */
export class UnifiedDiffParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [lineNumber] 1-based line of the offending input line
   */
  constructor(message, lineNumber) {
    super(lineNumber != null ? `${message}（第 ${lineNumber} 行）` : message);
    this.name = 'UnifiedDiffParseError';
    /** @type {number | null} */
    this.lineNumber = lineNumber ?? null;
  }
}

/**
 * @typedef {{ type: ' ' | '-' | '+', text: string, noNewline: boolean }} PatchLine
 * @typedef {{
 *   oldStart: number, oldCount: number,
 *   newStart: number, newCount: number,
 *   section: string,
 *   lines: PatchLine[],
 * }} PatchHunk
 * @typedef {{ oldPath: string, newPath: string, hunks: PatchHunk[] }} PatchFile
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff / patch into a structured form.
 *
 * Supports multi-file patches, hunk headers with omitted counts
 * (`@@ -3 +3 @@` means one line), `\ No newline at end of file` markers, and
 * arbitrary preamble noise between files (`diff --git`, `index …`).
 *
 * @param {string} text raw patch contents
 * @returns {PatchFile[]}
 * @throws {UnifiedDiffParseError} on any malformed hunk header, truncated
 *   hunk, line-count mismatch, or input containing no hunk at all.
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string') {
    throw new UnifiedDiffParseError('patch 內容必須是字串');
  }

  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline yields one empty tail element that is an artefact of the
  // split, not a patch line; keeping it would let a truncated hunk consume it
  // as an empty context line and pass validation.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  /** @type {PatchFile[]} */
  const files = [];
  /** @type {PatchFile | null} */
  let current = null;
  let i = 0;

  /** @param {string} raw @returns {string} */
  const stripPathMeta = (raw) => raw.split('\t')[0].trim();

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next == null || !next.startsWith('+++ ')) {
        throw new UnifiedDiffParseError('`---` 檔頭之後缺少對應的 `+++` 檔頭', i + 1);
      }
      current = {
        oldPath: stripPathMeta(line.slice(4)),
        newPath: stripPathMeta(next.slice(4)),
        hunks: [],
      };
      files.push(current);
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(line);
      if (!m) {
        throw new UnifiedDiffParseError(`無法解析的 hunk 標頭：${line}`, i + 1);
      }
      if (!current) {
        // A bare hunk with no file header is legal `diff -u` fragment output.
        current = { oldPath: '(old)', newPath: '(new)', hunks: [] };
        files.push(current);
      }
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      i += 1;

      /** @type {PatchLine[]} */
      const hunkLines = [];
      let oldRemaining = oldCount;
      let newRemaining = newCount;

      while (oldRemaining > 0 || newRemaining > 0) {
        if (i >= lines.length) {
          throw new UnifiedDiffParseError(
            `hunk 在檔案結束前被截斷（還缺 ${oldRemaining} 行原始、${newRemaining} 行新增）`,
            i,
          );
        }
        const raw = lines[i];
        if (raw.startsWith('\\')) {
          if (hunkLines.length === 0) {
            throw new UnifiedDiffParseError('`\\ No newline` 標記前沒有任何 hunk 行', i + 1);
          }
          hunkLines[hunkLines.length - 1].noNewline = true;
          i += 1;
          continue;
        }
        // Many tools strip the trailing space of an empty context line.
        const marker = raw === '' ? ' ' : raw[0];
        const body = raw === '' ? '' : raw.slice(1);

        if (marker === ' ') {
          if (oldRemaining <= 0 || newRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 內容行數超過標頭宣告的行數', i + 1);
          }
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (marker === '-') {
          if (oldRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 的刪除行數超過標頭宣告的原始行數', i + 1);
          }
          oldRemaining -= 1;
        } else if (marker === '+') {
          if (newRemaining <= 0) {
            throw new UnifiedDiffParseError('hunk 的新增行數超過標頭宣告的新增行數', i + 1);
          }
          newRemaining -= 1;
        } else {
          throw new UnifiedDiffParseError(`hunk 內出現無法解析的行：${raw}`, i + 1);
        }

        hunkLines.push({ type: marker, text: body, noNewline: false });
        i += 1;
      }

      // A `\ No newline` marker may also sit immediately after the last line.
      if (i < lines.length && lines[i].startsWith('\\') && hunkLines.length > 0) {
        hunkLines[hunkLines.length - 1].noNewline = true;
        i += 1;
      }

      // A body-looking line immediately after a satisfied hunk means the
      // header under-declared its counts. Silently treating it as preamble
      // would drop real content, so it is an error. `--- `/`+++ ` are file
      // headers, and a bare empty line is a common inter-hunk separator.
      const after = lines[i];
      if (after != null && after !== '' &&
          (after[0] === ' ' || after[0] === '-' || after[0] === '+') &&
          !after.startsWith('--- ') && !after.startsWith('+++ ')) {
        throw new UnifiedDiffParseError(
          'hunk 內容行數超過標頭宣告的行數', i + 1,
        );
      }

      current.hunks.push({
        oldStart, oldCount, newStart, newCount,
        section: m[5] ?? '',
        lines: hunkLines,
      });
      continue;
    }

    // Anything else between hunks (`diff --git`, `index …`, prose) is preamble.
    i += 1;
  }

  const totalHunks = files.reduce((sum, f) => sum + f.hunks.length, 0);
  if (totalHunks === 0) {
    throw new UnifiedDiffParseError('內容中找不到任何 unified diff hunk');
  }

  return files;
}

/**
 * Reconstruct the "before" and "after" text a patch describes.
 *
 * A patch only carries the hunk neighbourhoods, so the result is not the whole
 * file. Skipped regions and file/hunk headers are emitted identically on both
 * sides, which makes the diff engine render them as context and keeps the two
 * panes aligned.
 *
 * @param {PatchFile[]} files output of parseUnifiedDiff()
 * @returns {{ oldText: string, newText: string }}
 */
export function buildPatchSides(files) {
  /** @type {string[]} */
  const oldLines = [];
  /** @type {string[]} */
  const newLines = [];
  /** @param {string} s */
  const both = (s) => { oldLines.push(s); newLines.push(s); };

  for (const file of files) {
    if (oldLines.length > 0) both('');
    both(`═══ ${file.oldPath} → ${file.newPath} ═══`);
    for (const hunk of file.hunks) {
      both(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.section}`);
      for (const l of hunk.lines) {
        if (l.type === ' ') { oldLines.push(l.text); newLines.push(l.text); }
        else if (l.type === '-') oldLines.push(l.text);
        else newLines.push(l.text);
      }
    }
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}
