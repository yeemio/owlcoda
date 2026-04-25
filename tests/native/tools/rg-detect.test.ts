import { describe, expect, it, beforeEach } from 'vitest'
import { _resetRipgrepCacheForTests, detectRipgrep } from '../../../src/native/tools/rg-detect.js'

describe('detectRipgrep', () => {
  beforeEach(() => {
    _resetRipgrepCacheForTests()
  })

  it('resolves to a binary or null without throwing', async () => {
    // We don't assume the CI environment has rg installed. The contract is:
    // never reject, always resolve to either a usable binary or null.
    const result = await detectRipgrep()
    if (result !== null) {
      expect(typeof result.bin).toBe('string')
      expect(result.bin.length).toBeGreaterThan(0)
    } else {
      expect(result).toBeNull()
    }
  })

  it('caches the result across calls', async () => {
    const first = await detectRipgrep()
    const second = await detectRipgrep()
    expect(second).toEqual(first)
  })

  it('reset clears the cache so detection re-runs', async () => {
    const first = await detectRipgrep()
    _resetRipgrepCacheForTests()
    const second = await detectRipgrep()
    // Result shape should match but identity need not
    expect(second).toEqual(first)
  })
})
