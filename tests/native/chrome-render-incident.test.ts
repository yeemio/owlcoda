import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearRawMdRing,
  dumpRenderIncident,
  recordRawMdChunk,
} from '../../src/native/tui/chrome.js'

// 2026-06-12 dogfood: a long CJK turn rendered corrupted in the live session
// (glued lines, raw ## leak) but every layer replays CLEAN from the saved
// text — the incident is only diagnosable with first-hand evidence captured
// AT RENDER TIME. Two instruments:
//   1. a bounded ring of the raw chunks fed to mdRenderer.push()
//   2. dumpRenderIncident(err): when the render path throws (today the
//      safeRender fallback silently prints RAW markdown), persist the ring
//      + error to ~/.owlcoda/render-incidents/ so the next occurrence pins
//      the failing layer instead of vanishing.

describe('render incident capture', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'owlcoda-incident-'))
    process.env['OWLCODA_HOME'] = home
    clearRawMdRing()
  })

  afterEach(() => {
    delete process.env['OWLCODA_HOME']
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps a bounded ring of raw chunks', () => {
    for (let i = 0; i < 300; i++) recordRawMdChunk(`chunk-${i}`)
    const path = dumpRenderIncident(new Error('boom'))
    expect(path).not.toBeNull()
    const payload = JSON.parse(readFileSync(path!, 'utf8'))
    expect(payload.error).toContain('boom')
    expect(payload.chunks.length).toBeLessThanOrEqual(256)
    expect(payload.chunks.at(-1)).toBe('chunk-299')
    expect(payload.chunks[0]).toBe('chunk-44') // 300 - 256
  })

  it('writes incidents under OWLCODA_HOME/render-incidents', () => {
    recordRawMdChunk('only-chunk')
    const path = dumpRenderIncident('string error')
    expect(path).toContain(join(home, 'render-incidents'))
    expect(readdirSync(join(home, 'render-incidents'))).toHaveLength(1)
  })

  it('throttles dumps so a render-error loop cannot spam the disk', () => {
    recordRawMdChunk('x')
    const first = dumpRenderIncident(new Error('a'))
    const second = dumpRenderIncident(new Error('b'))
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('never throws even if the home dir is not writable', () => {
    process.env['OWLCODA_HOME'] = '/dev/null/nope'
    expect(() => dumpRenderIncident(new Error('c'))).not.toThrow()
  })

  it('persists structured fault kind, sequence, frame, and recovery metadata', () => {
    const path = dumpRenderIncident(new Error('structured boom'), {
      faultKind: 'recoverable',
      sequence: 9,
      frame: { renderSequence: 4, frameSequence: 8, phase: 'render' },
      rendererState: 'healthy',
      recovery: 'repaint_suppressed_limit',
      componentStack: ' at Demo',
    })

    const payload = JSON.parse(readFileSync(path!, 'utf8'))
    expect(payload).toMatchObject({
      schemaVersion: 1,
      faultKind: 'recoverable',
      sequence: 9,
      frame: { renderSequence: 4, frameSequence: 8, phase: 'render' },
      rendererState: 'healthy',
      recovery: 'repaint_suppressed_limit',
      componentStack: ' at Demo',
      errorDetails: { name: 'Error', message: 'structured boom' },
    })
  })
})
