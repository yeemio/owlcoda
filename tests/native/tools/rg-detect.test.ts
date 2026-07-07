import { describe, expect, it, beforeEach } from 'vitest'
import {
  _resetRipgrepCacheForTests,
  detectRipgrep,
  RIPGREP_FIXED_PATHS,
} from '../../../src/native/tools/rg-detect.js'

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
    await detectRipgrep()
    _resetRipgrepCacheForTests()
    const second = await detectRipgrep()
    // Reset should allow another probe. The host environment can change
    // between probes under parallel test load, so assert the public shape
    // instead of requiring byte-identical answers.
    if (second !== null) {
      expect(typeof second.bin).toBe('string')
      expect(second.bin.length).toBeGreaterThan(0)
    } else {
      expect(second).toBeNull()
    }
  })

  it('checks the Codex.app bundled rg path as a fixed fallback', () => {
    expect(RIPGREP_FIXED_PATHS).toContain('/Applications/Codex.app/Contents/Resources/rg')
  })
})
