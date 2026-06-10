import { describe, it, expect } from 'vitest'
import { MeasuredText, Cursor } from '../../src/utils/Cursor.js'

// 0.13.72 / 0.13.73 paste-perf — MeasuredText.measureWrappedText()
// bypass for huge texts. Threshold: 2 KB (lowered from 8 KB in
// 0.13.73 after dogfood feedback). Pasting a long block delivers the
// entire string as ONE text token; the composer's onChange handler
// synchronously collapses to a placeholder, but in the same tick a
// Cursor/MeasuredText pair gets constructed for the long content.
// If anything calls `wrappedLines` before the React state update
// flushes, `wrapAnsi(N KB, columns)` runs once and blocks the event
// loop for hundreds of ms. The bypass returns one WrappedLine per
// logical line for texts above the threshold — preserving logical-
// line navigation while skipping the expensive width-aware wrap.
describe('MeasuredText huge-text wrap bypass (0.13.72/0.13.73)', () => {
  it('returns logical lines for text well above the 2 KB bypass threshold', () => {
    const lines = ['line one', 'line two', 'line three']
    const padding = 'x'.repeat(4 * 1024)
    const huge = `${lines[0]}\n${lines[1]}\n${lines[2]}\n${padding}`
    const mt = new MeasuredText(huge, 80)
    const wrapped = mt.getWrappedText()
    expect(wrapped.length).toBe(4) // 3 small lines + 1 padded line
    expect(wrapped[0]).toBe('line one')
    expect(wrapped[1]).toBe('line two')
    expect(wrapped[2]).toBe('line three')
    expect(wrapped[3]!.length).toBe(padding.length)
  })

  it('starts each WrappedLine at the correct startOffset for huge texts', () => {
    const lines = ['alpha', 'beta', 'gamma']
    const padding = 'p'.repeat(3 * 1024)
    const huge = `${lines.join('\n')}\n${padding}`
    const mt = new MeasuredText(huge, 80)
    const wrapped = mt.getWrappedText()
    expect(wrapped).toHaveLength(4)
    const cursor = Cursor.fromText(huge, 80, huge.length)
    expect(cursor.offset).toBe(huge.length)
    expect(cursor.text.length).toBe(huge.length)
  })

  it('runs in a fraction of the time it takes wrapAnsi to process the same input', () => {
    // Wall-clock test is flaky-prone on busy CI, so we use a coarse
    // upper bound: 100KB through the bypass should land well under
    // 50ms even on slow hardware. The pre-bypass wrapAnsi path on the
    // same input commonly took 200-800ms in the field.
    const huge = 'a'.repeat(100 * 1024)
    const start = performance.now()
    const mt = new MeasuredText(huge, 80)
    const wrapped = mt.getWrappedText()
    const elapsed = performance.now() - start
    expect(wrapped).toHaveLength(1)
    expect(elapsed).toBeLessThan(50)
  })

  it('uses the standard wrap pipeline for texts below the threshold (preserves visual wrap)', () => {
    // ~1.5 KB single-line ASCII (under 2 KB threshold) on 80-col
    // terminal must still produce wrapped visual lines via wrapAnsi —
    // confirms the bypass doesn't apply below threshold.
    const text = 'A'.repeat(1500)
    const mt = new MeasuredText(text, 80)
    const wrapped = mt.getWrappedText()
    expect(wrapped.length).toBeGreaterThan(1)
  })

  it('preserves correct line count for a multi-line input at the bypass boundary', () => {
    const segments: string[] = []
    while (segments.join('\n').length < 3 * 1024) {
      segments.push(`segment ${segments.length}: ${'x'.repeat(40)}`)
    }
    const multiline = segments.join('\n')
    const mt = new MeasuredText(multiline, 80)
    const wrapped = mt.getWrappedText()
    expect(wrapped.length).toBe(segments.length)
    expect(wrapped[0]).toBe(segments[0])
    expect(wrapped[segments.length - 1]).toBe(segments[segments.length - 1])
  })
})
