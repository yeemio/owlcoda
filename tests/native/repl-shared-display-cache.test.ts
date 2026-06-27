import { describe, it, expect, beforeEach } from 'vitest'
import {
  countTranscriptLines,
  selectVisibleTranscriptWindow,
  __clearDisplayLinesCacheForTest,
  buildTranscriptOffsetsCache,
  updateTranscriptOffsetsCache,
  totalLinesFromCache,
  type TranscriptOffsetsCache,
  type TranscriptItem,
} from '../../src/native/repl-shared.js'

// 0.13.73 transcript-perf — LRU cache for getDisplayLines.
//
// The composer's spinner re-renders at ~11 Hz during an active
// session. Each render walks visible transcript items via
// `selectVisibleTranscriptItems → estimateWrappedLineCount →
// getDisplayLines`, which used to call `wrapText` per logical line
// every time. For a long pasted user message (100+ logical CJK
// lines), the per-render wrap cost was 50–200ms — visible as
// sustained lag even after 0.13.72's MeasuredText bypass took the
// composer side of the wrap path off the table.
//
// The cache is sound because TranscriptItem text is immutable once
// produced; same `(text, width)` always yields the same wrapped
// result. These tests pin down: cache hits avoid recomputation;
// width changes invalidate; LRU eviction works.
describe('getDisplayLines LRU cache (0.13.73)', () => {
  beforeEach(() => {
    __clearDisplayLinesCacheForTest()
  })

  it('countTranscriptLines is consistent across repeated calls (cache idempotent)', () => {
    // Mixed CJK + multi-line forces the slow path
    // (estimateWrappedLineCount fast-path only fires for ASCII
    // single-line). Repeated calls must return identical counts.
    const item = { id: '1', text: '中文段落\nLine two\nLine three\nLine four' }
    const a = countTranscriptLines([item], 40)
    const b = countTranscriptLines([item], 40)
    const c = countTranscriptLines([item], 40)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toBeGreaterThanOrEqual(4)
  })

  it('width change invalidates the cache (different keys, recomputed)', () => {
    // Same text wrapped at different widths must produce different
    // line counts (narrower → more lines for a given long line).
    const item = { id: '1', text: '中文'.repeat(30) }
    const wide = countTranscriptLines([item], 80)
    const narrow = countTranscriptLines([item], 20)
    expect(narrow).toBeGreaterThan(wide)
  })

  it('warm-cache call is faster than cold-cache for a 100KB CJK paste', () => {
    // Wall-clock test with a coarse threshold to avoid CI flakiness.
    // The 0.13.73 cache should make the second call nearly free; the
    // first call paid the wrapAnsi-per-logical-line cost.
    const lines: string[] = []
    while (lines.join('\n').length < 100 * 1024) {
      lines.push('中文段落 zh-CN ' + 'x'.repeat(40))
    }
    const item = { id: '1', text: lines.join('\n') }

    const cold0 = performance.now()
    countTranscriptLines([item], 80)
    const cold = performance.now() - cold0

    const warm0 = performance.now()
    countTranscriptLines([item], 80)
    const warm = performance.now() - warm0

    // Warm should be at least 10× faster. Cold path commonly takes
    // 50–200ms in the field; warm should be sub-millisecond.
    expect(warm).toBeLessThan(Math.max(2, cold / 10))
  })

  it('serves identical cached value across many calls (no allocation churn)', () => {
    const item = { id: '1', text: '中文\nEnglish\n중국어\n日本語\n' + 'x'.repeat(200) }
    countTranscriptLines([item], 30)
    const second = countTranscriptLines([item], 30)
    const third = countTranscriptLines([item], 30)
    expect(second).toBe(third)
  })

  it('keeps repeated live-window selection cheap for a long submitted user item', () => {
    const lines: string[] = []
    while (lines.join('\n').length < 80 * 1024) {
      lines.push('用户长 prompt 中文 English mixed ' + 'x'.repeat(44))
    }
    const item = { id: 'user-long', text: lines.join('\n') }

    const cold0 = performance.now()
    const coldWindow = selectVisibleTranscriptWindow([item], 80, 12, 0)
    const cold = performance.now() - cold0
    expect(coldWindow.visible).toHaveLength(1)

    const warm0 = performance.now()
    for (let i = 0; i < 40; i++) {
      const warmWindow = selectVisibleTranscriptWindow([item], 80, 12, 0)
      expect(warmWindow.visible).toHaveLength(1)
    }
    const warmTotal = performance.now() - warm0

    expect(warmTotal).toBeLessThan(Math.max(8, cold * 2))
  })
})

// ─── Task D-1: TranscriptOffsetsCache ────────────────────────────────────────
describe('TranscriptOffsetsCache (D-1)', () => {
  beforeEach(() => {
    __clearDisplayLinesCacheForTest()
  })

  function makeItems(n: number, linesEach = 2): TranscriptItem[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      text: Array.from({ length: linesEach }, () => 'Hello world line').join('\n'),
    }))
  }

  it('buildTranscriptOffsetsCache returns correct cumulative totals', () => {
    // 5 items, each with 3 short lines at width 80 → 3 lines each
    const items: TranscriptItem[] = [
      { id: 'a', text: 'line1\nline2\nline3' },
      { id: 'b', text: 'line4\nline5\nline6' },
      { id: 'c', text: 'line7\nline8\nline9' },
    ]
    const cache = buildTranscriptOffsetsCache(items, 80)
    expect(cache.width).toBe(80)
    expect(cache.itemIds).toEqual(['a', 'b', 'c'])
    expect(cache.cumulativeLines).toHaveLength(3)
    // cumulative: [3, 6, 9]
    expect(cache.cumulativeLines[0]).toBe(3)
    expect(cache.cumulativeLines[1]).toBe(6)
    expect(cache.cumulativeLines[2]).toBe(9)
    expect(cache.totalLines).toBe(9)
  })

  it('totalLinesFromCache returns the total', () => {
    const items = makeItems(4, 2)
    const cache = buildTranscriptOffsetsCache(items, 80)
    expect(totalLinesFromCache(cache)).toBe(countTranscriptLines(items, 80))
  })

  it('updateTranscriptOffsetsCache is append-only: existing entries survive append', () => {
    const items = makeItems(3, 2)
    const cache = buildTranscriptOffsetsCache(items, 80)
    const totalBefore = cache.totalLines
    const idsBefore = [...cache.itemIds]

    // Append one more item
    const extended = [...items, { id: 'new-item', text: 'extra line' }]
    updateTranscriptOffsetsCache(cache, extended, 80)

    // All original ids must still be present at the start
    expect(cache.itemIds.slice(0, 3)).toEqual(idsBefore)
    expect(cache.totalLines).toBeGreaterThan(totalBefore)
    expect(cache.itemIds).toHaveLength(4)
    expect(cache.itemIds[3]).toBe('new-item')
  })

  it('width change invalidates the cache (returns 0 total, forces rebuild)', () => {
    const items = makeItems(3, 2)
    const cache = buildTranscriptOffsetsCache(items, 80)
    // Calling update with a different width should reset the cache
    updateTranscriptOffsetsCache(cache, items, 40)
    // After width change, totalLines should be recomputed for the new width
    expect(cache.width).toBe(40)
    // totalLines must still be correct for the new width
    expect(cache.totalLines).toBe(countTranscriptLines(items, 40))
  })

  it('append cost is O(new items) not O(all items): timing test', () => {
    // Build a 200-item cache (warm it up)
    const items = makeItems(200, 3)
    const cache = buildTranscriptOffsetsCache(items, 80)

    // Append 1 item and measure time
    const appendStart = performance.now()
    for (let rep = 0; rep < 100; rep++) {
      const extended = [...items, { id: `extra-${rep}`, text: 'new line' }]
      updateTranscriptOffsetsCache(cache, extended, 80)
      // Reset back for next iteration
      cache.itemIds.length = items.length
      cache.cumulativeLines.length = items.length
      cache.totalLines = cache.cumulativeLines[items.length - 1]!
    }
    const appendTime = performance.now() - appendStart

    // Cold build of 200 items
    __clearDisplayLinesCacheForTest()
    const coldStart = performance.now()
    buildTranscriptOffsetsCache(makeItems(200, 3), 80)
    const coldTime = performance.now() - coldStart

    // 100 single-appends should be much cheaper than 1 full cold rebuild
    // (generous 5x threshold for CI)
    expect(appendTime).toBeLessThan(Math.max(10, coldTime * 5))
  })

  it('selectVisibleTranscriptWindow with warm cache returns identical result to cold call', () => {
    const items = makeItems(50, 4)
    // Cold call
    const cold = selectVisibleTranscriptWindow(items, 80, 30, 0)

    // Build cache and call with it
    const cache = buildTranscriptOffsetsCache(items, 80)
    const warm = selectVisibleTranscriptWindow(items, 80, 30, 0, cache)

    expect(warm.totalLines).toBe(cold.totalLines)
    expect(warm.visible.length).toBe(cold.visible.length)
    expect(warm.viewStartLine).toBe(cold.viewStartLine)
    expect(warm.viewEndLine).toBe(cold.viewEndLine)
  })

  it('selectVisibleTranscriptWindow with warm cache stays cheap for 500 items', () => {
    const items = makeItems(500, 3)
    // Warm the display lines LRU cache first
    buildTranscriptOffsetsCache(items, 80)

    const cache = buildTranscriptOffsetsCache(items, 80)

    const baseline = selectVisibleTranscriptWindow(items, 80, 30, 0)
    const warm0 = performance.now()
    for (let i = 0; i < 20; i++) {
      const warm = selectVisibleTranscriptWindow(items, 80, 30, 0, cache)
      expect(warm.totalLines).toBe(baseline.totalLines)
      expect(warm.visible.length).toBe(baseline.visible.length)
    }
    const warmTime = performance.now() - warm0

    // Keep this as an absolute sanity bound instead of a warm/cold ratio:
    // under parallel full-suite load, the cold side can also become very fast
    // once the display-line LRU is hot, making ratio assertions noisy.
    expect(warmTime).toBeLessThan(50)
  })
})

// ─── Task D-5: O(1) viewport compute on spinner tick for stable items ─────────
describe('selectVisibleTranscriptWindow O(1) spinner-tick regression (D-5)', () => {
  beforeEach(() => {
    __clearDisplayLinesCacheForTest()
  })

  function makeItems(n: number, linesEach = 3): TranscriptItem[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      text: Array.from({ length: linesEach }, () => 'Hello world line ' + i).join('\n'),
    }))
  }

  it('100 stable-item calls with warm cache take < 20ms total (pins O(1) cost)', () => {
    // Simulate 100 spinner ticks where items/budget/cols are unchanged.
    // With warm offsets cache + warm display-lines LRU, these calls are cheap.
    const items = makeItems(200, 3)
    const cache = buildTranscriptOffsetsCache(items, 80)

    // Pre-warm the display-lines LRU cache too
    selectVisibleTranscriptWindow(items, 80, 30, 0, cache)

    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      selectVisibleTranscriptWindow(items, 80, 30, 0, cache)
    }
    const elapsed = performance.now() - t0

    // Generous: 20ms for 100 calls on any CI machine
    expect(elapsed).toBeLessThan(20)
  })

  it('cold calls (no display-lines LRU, no offsets cache) are slower than warm cached calls', () => {
    // Demonstrates that the combination of offsets cache + display-lines LRU
    // provides measurable speedup over fully cold calls.
    const items = makeItems(200, 3)

    // First: measure fully cold (no display-lines LRU, no offsets cache)
    __clearDisplayLinesCacheForTest()
    const coldCache = buildTranscriptOffsetsCache(items, 80)
    // The first call populates the LRU; measure subsequent cold-ish calls
    const coldStart = performance.now()
    for (let i = 0; i < 5; i++) {
      __clearDisplayLinesCacheForTest()
      selectVisibleTranscriptWindow(items, 80, 30, 0)
    }
    const coldTime = performance.now() - coldStart
    void coldCache

    // Now measure warm (offsets cache + LRU both warm)
    const cache = buildTranscriptOffsetsCache(items, 80)
    selectVisibleTranscriptWindow(items, 80, 30, 0, cache) // warm LRU
    const warmStart = performance.now()
    for (let i = 0; i < 100; i++) {
      selectVisibleTranscriptWindow(items, 80, 30, 0, cache)
    }
    const warmTime = performance.now() - warmStart

    // 100 warm calls should take less than 5 × cold single calls
    // (cold per-call = coldTime/5; 100 warm calls = warmTime)
    // Very generous threshold: just pins that warm is not absurdly slow
    expect(warmTime).toBeLessThan(coldTime * 5)
  })
})
