/**
 * @vitest-environment jsdom
 *
 * The model behind the metadata (MP3 / Version) comparison grid.
 *
 * Two things are checked that a plain "does it return rows" test would not:
 * the renderer's copy of the field vocabulary is asserted against the parser's
 * own constants, because they live in different processes and cannot import
 * each other; and "absent" is asserted to stay distinguishable from "present
 * but empty", because collapsing the two is what makes a grid claim two files
 * agree when one of them simply has no tag at all.
 */
import { describe, it, expect } from 'vitest'
import { MP3_FIELDS, PE_FIELDS, diffMetadata } from '../../src/main/metadata.js'
import {
  MP3_FIELD_ORDER,
  PE_FIELD_ORDER,
  AUDIO_FIELD_ORDER,
  FIELD_LABELS,
  audioFields,
  buildMetadataRows,
  countRows,
  diffFields,
  diffRowIndices,
  fieldLabel,
  formatDuration,
  metadataNotes,
  resolveKind,
  stateLabel,
  buildMetadataTextReport,
  buildMetadataHtmlReport,
} from '../../src/renderer/src/views/metadata-compare.js'

/** @param {Record<string,string>} fields @param {object} [extra] */
const mp3 = (fields, extra = {}) => ({ kind: 'mp3', fields, ...extra })
/** @param {Record<string,string>} fields */
const pe = (fields) => ({ kind: 'pe', fields })

describe('field vocabulary parity with the parser', () => {
  it('lists exactly the MP3 fields main/metadata.js produces, in the same order', () => {
    // A field added to the parser and not here would be parsed and then never
    // shown — the failure mode this project keeps finding.
    expect([...MP3_FIELD_ORDER]).toEqual([...MP3_FIELDS])
  })

  it('lists exactly the PE fields main/metadata.js produces, in the same order', () => {
    expect([...PE_FIELD_ORDER]).toEqual([...PE_FIELDS])
  })

  it('labels every field it claims to order', () => {
    for (const f of [...MP3_FIELD_ORDER, ...PE_FIELD_ORDER, ...AUDIO_FIELD_ORDER]) {
      expect(FIELD_LABELS[f], f).toBeTruthy()
    }
  })

  it('falls back to the raw key for a field nobody named', () => {
    // PE string tables may carry arbitrary keys; showing the key beats blank.
    expect(fieldLabel('BuildID')).toBe('BuildID')
  })
})

describe('diffFields', () => {
  it('agrees with the parser-side diffMetadata on which fields exist', () => {
    const left = { title: 'A', artist: 'X', year: '2001' }
    const right = { title: 'A', album: 'Z', year: '2002' }
    const mine = diffFields(left, right, MP3_FIELD_ORDER)
    const theirs = diffMetadata(left, right, MP3_FIELDS)
    expect(mine.map((r) => r.field)).toEqual(theirs.map((r) => r.field))
    expect(mine.map((r) => r.state === 'same')).toEqual(theirs.map((r) => r.same))
  })

  it('classifies each row', () => {
    const rows = diffFields(
      { title: 'A', artist: 'X', year: '2001' },
      { title: 'A', album: 'Z', year: '2002' },
      MP3_FIELD_ORDER)
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.state]))
    expect(byField).toEqual({
      title: 'same', artist: 'left-only', album: 'right-only', year: 'different',
    })
  })

  it('keeps "absent" distinct from "present but empty"', () => {
    const rows = diffFields({ comment: '' }, {}, MP3_FIELD_ORDER)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('left-only')
    expect(rows[0].left).toBe('')
    expect(rows[0].leftPresent).toBe(true)
    expect(rows[0].right).toBeNull()
    expect(rows[0].rightPresent).toBe(false)
  })

  it('shows two empty values as the same, not as a difference', () => {
    const rows = diffFields({ comment: '' }, { comment: '' }, MP3_FIELD_ORDER)
    expect(rows[0].state).toBe('same')
  })

  it('omits fields neither side has', () => {
    const rows = diffFields({ title: 'A' }, { title: 'A' }, MP3_FIELD_ORDER)
    expect(rows.map((r) => r.field)).toEqual(['title'])
  })

  it('appends unlisted fields after the canonical ones, sorted', () => {
    const rows = diffFields(
      { zzz: '1', aaa: '2', title: 'T' }, {}, MP3_FIELD_ORDER)
    expect(rows.map((r) => r.field)).toEqual(['title', 'aaa', 'zzz'])
  })
})

describe('resolveKind', () => {
  it('agrees when both sides parsed the same way', () => {
    expect(resolveKind(mp3({}), mp3({}))).toBe('mp3')
    expect(resolveKind(pe({}), pe({}))).toBe('pe')
  })

  it('lets the one side that parsed decide the vocabulary', () => {
    // Otherwise an MP3 opposite an unreadable file shows nothing at all,
    // including the fields that were read perfectly well.
    expect(resolveKind(mp3({}), { kind: 'unknown', fields: {} })).toBe('mp3')
    expect(resolveKind(null, pe({}))).toBe('pe')
  })

  it('reports a mismatch rather than picking a winner', () => {
    expect(resolveKind(mp3({}), pe({}))).toBe('mixed')
  })

  it('is unknown when nothing parsed', () => {
    expect(resolveKind(null, null)).toBe('unknown')
    expect(resolveKind({ kind: 'unknown', fields: {} }, null)).toBe('unknown')
  })
})

describe('audioFields', () => {
  const full = {
    bitrate: 192, sampleRate: 44100, channelMode: 'joint stereo',
    durationSec: 185.4, mpegVersion: '1', layer: 3, vbr: false,
  }

  it('formats every readable property', () => {
    expect(audioFields(full)).toEqual({
      'audio:duration': '3:05',
      'audio:bitrate': '192 kbps',
      'audio:sampleRate': '44100 Hz',
      'audio:channelMode': 'joint stereo',
      'audio:mpegVersion': 'MPEG 1',
      'audio:layer': 'Layer 3',
    })
  })

  it('omits a property the parser could not read, rather than showing zero', () => {
    // Number(null) and Number('') are both 0 and 0 is finite: a bare finiteness
    // check here would invent "0 kbps" for a header that failed to parse.
    const empty = {
      bitrate: null, sampleRate: null, channelMode: null,
      durationSec: null, mpegVersion: null, layer: null, vbr: false,
    }
    expect(audioFields(empty)).toEqual({})
    expect(audioFields(null)).toEqual({})
  })

  it('marks a VBR bitrate as an average', () => {
    expect(audioFields({ ...full, vbr: true })['audio:bitrate']).toBe('192 kbps（VBR 平均）')
  })

  it('formats durations past an hour', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(59.6)).toBe('1:00')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})

describe('buildMetadataRows', () => {
  it('uses the MP3 order and appends the audio properties', () => {
    const audio = {
      bitrate: 128, sampleRate: 44100, channelMode: 'stereo',
      durationSec: 60, mpegVersion: '1', layer: 3, vbr: false,
    }
    const { kind, rows } = buildMetadataRows(
      mp3({ artist: 'X', title: 'A' }, { audio }),
      mp3({ artist: 'Y', title: 'A' }, { audio }))
    expect(kind).toBe('mp3')
    expect(rows.slice(0, 2).map((r) => r.field)).toEqual(['title', 'artist'])
    expect(rows.filter((r) => r.group === 'audio').map((r) => r.field))
      .toEqual([...AUDIO_FIELD_ORDER])
    expect(rows.every((r) => r.group !== 'audio' || r.state === 'same')).toBe(true)
  })

  it('uses the PE order and adds no audio rows', () => {
    const { kind, rows } = buildMetadataRows(
      pe({ CompanyName: 'Acme', FileVersion: '1.0.0.0' }),
      pe({ CompanyName: 'Acme', FileVersion: '1.0.0.1' }))
    expect(kind).toBe('pe')
    expect(rows.map((r) => r.field)).toEqual(['FileVersion', 'CompanyName'])
    expect(rows.some((r) => r.group === 'audio')).toBe(false)
  })

  it('still lays out both vocabularies when the two files disagree', () => {
    const { kind, rows } = buildMetadataRows(mp3({ title: 'A' }), pe({ CompanyName: 'Acme' }))
    expect(kind).toBe('mixed')
    expect(rows.map((r) => r.field)).toEqual(['title', 'CompanyName'])
    expect(rows[0].state).toBe('left-only')
    expect(rows[1].state).toBe('right-only')
  })

  it('produces no rows when neither side parsed', () => {
    expect(buildMetadataRows(null, null)).toEqual({ kind: 'unknown', rows: [] })
  })
})

describe('diffRowIndices / countRows', () => {
  const { rows } = buildMetadataRows(
    mp3({ title: 'A', artist: 'X', year: '2001' }),
    mp3({ title: 'A', album: 'Z', year: '2002' }))

  it('navigates only the rows that differ, in grid order', () => {
    expect(rows.map((r) => r.field)).toEqual(['title', 'artist', 'album', 'year'])
    expect(diffRowIndices(rows)).toEqual([1, 2, 3])
  })

  it('counts every state', () => {
    expect(countRows(rows)).toEqual({
      total: 4, same: 1, different: 1, leftOnly: 1, rightOnly: 1,
    })
  })

  it('tolerates an empty model', () => {
    expect(diffRowIndices([])).toEqual([])
    expect(countRows(undefined)).toEqual({
      total: 0, same: 0, different: 0, leftOnly: 0, rightOnly: 0,
    })
  })
})

describe('metadataNotes', () => {
  const side = (path, meta) => ({ path, meta })

  it('asks for files when nothing is loaded', () => {
    expect(metadataNotes(null, null, []).join('')).toContain('尚未載入')
  })

  it('names a file that carries no readable metadata at all', () => {
    const notes = metadataNotes(
      side('C:/tmp/notes.txt', { kind: 'unknown', fields: {} }),
      side('C:/tmp/b.mp3', mp3({ title: 'A' })),
      [])
    expect(notes.some((n) => n.includes('notes.txt') && n.includes('不是可讀取中繼資料'))).toBe(true)
  })

  it('says a tag is empty rather than leaving a blank grid', () => {
    const notes = metadataNotes(
      side('C:/tmp/a.mp3', mp3({})), side('C:/tmp/b.mp3', mp3({})), [])
    expect(notes.some((n) => n.includes('沒有任何 ID3 標籤'))).toBe(true)
    expect(notes.some((n) => n.includes('沒有版本資源'))).toBe(false)
  })

  it('says a PE has no version resource', () => {
    const notes = metadataNotes(
      side('C:/tmp/a.dll', pe({})), side('C:/tmp/b.dll', pe({ FileVersion: '1' })), [])
    expect(notes.some((n) => n.includes('a.dll') && n.includes('沒有版本資源'))).toBe(true)
  })

  it('refuses to let an empty grid read as "identical"', () => {
    const notes = metadataNotes(
      side('a.mp3', mp3({})), side('b.mp3', mp3({})), [])
    expect(notes.some((n) => n.includes('不代表兩個檔案相同'))).toBe(true)
  })

  it('says nothing extra when both sides have fields', () => {
    const { rows } = buildMetadataRows(mp3({ title: 'A' }), mp3({ title: 'B' }))
    expect(metadataNotes(side('a.mp3', mp3({ title: 'A' })),
      side('b.mp3', mp3({ title: 'B' })), rows)).toEqual([])
  })
})

describe('reports', () => {
  const { rows } = buildMetadataRows(
    mp3({ title: 'A', artist: 'X' }), mp3({ title: 'B' }))
  const info = {
    leftPath: 'C:/tmp/a.mp3',
    rightPath: 'C:/tmp/b.mp3',
    kind: 'mp3',
    rows,
    notes: ['測試附註'],
  }
  const at = new Date('2026-01-02T03:04:05Z')

  it('writes a text report carrying every row and the counts', () => {
    const text = buildMetadataTextReport(info, { generatedAt: at })
    expect(text).toContain('C:/tmp/a.mp3')
    expect(text).toContain('MP3 標籤')
    expect(text).toContain('標題')
    expect(text).toContain('演出者')
    expect(text).toContain('僅左側 1')
    expect(text).toContain('測試附註')
  })

  it('writes an HTML report whose row classes carry the state', () => {
    const html = buildMetadataHtmlReport(info, { generatedAt: at })
    expect(html).toContain('<tr class="different">')
    expect(html).toContain('<tr class="left-only">')
    expect(html).toContain('2026-01-02 03:04:05')
  })

  it('escapes values rather than letting a tag inject markup', () => {
    const html = buildMetadataHtmlReport({
      ...info,
      rows: [{
        field: 'title', label: '標題', group: 'tag',
        left: '<script>x</script>', right: null,
        leftPresent: true, rightPresent: false, state: 'left-only',
      }],
    })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('says so when there is nothing to tabulate', () => {
    expect(buildMetadataTextReport({ ...info, rows: [], notes: [] }))
      .toContain('沒有可比對的欄位')
  })
})

describe('stateLabel', () => {
  it('names every state', () => {
    expect(['same', 'different', 'left-only', 'right-only'].map(stateLabel))
      .toEqual(['相同', '不同', '僅左側', '僅右側'])
  })
})
