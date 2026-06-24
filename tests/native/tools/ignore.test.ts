import { describe, expect, it } from 'vitest'
import { IGNORE_DIR_NAMES, IGNORE_GLOB_PATTERNS } from '../../../src/native/tools/ignore.js'

describe('tool ignore list', () => {
  it('includes generated-artifact directories', () => {
    for (const name of [
      'node_modules',
      '.git',
      'dist',
      'dist-prod',
      'build',
      'target',
      'output',
      'coverage',
      '.next',
      '.cache',
      '.turbo',
    ]) {
      expect(IGNORE_DIR_NAMES.has(name)).toBe(true)
    }
  })

  it('mirrors dir names into glob patterns', () => {
    expect(IGNORE_GLOB_PATTERNS.length).toBe(IGNORE_DIR_NAMES.size)
    for (const pattern of IGNORE_GLOB_PATTERNS) {
      expect(pattern).toMatch(/^\*\*\/.+\/\*\*$/)
    }
    expect(IGNORE_GLOB_PATTERNS).toContain('**/node_modules/**')
    expect(IGNORE_GLOB_PATTERNS).toContain('**/dist-prod/**')
    expect(IGNORE_GLOB_PATTERNS).toContain('**/.next/**')
  })

  // OC-20260623-15: 'out' must NOT be in the ignore list — it is a
  // common user-created output directory (research datasets, tsconfig
  // outDir) and blanket-ignoring it causes false negatives.
  it('does NOT include out (OC-20260623-15)', () => {
    expect(IGNORE_DIR_NAMES.has('out')).toBe(false)
    expect(IGNORE_GLOB_PATTERNS).not.toContain('**/out/**')
  })

  // Sanity: truly-excluded directories must still be present.
  it('still excludes node_modules and .git', () => {
    expect(IGNORE_DIR_NAMES.has('node_modules')).toBe(true)
    expect(IGNORE_DIR_NAMES.has('.git')).toBe(true)
  })
})
