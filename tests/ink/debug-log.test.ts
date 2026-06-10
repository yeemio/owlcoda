import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  logForDebugging,
  resetDebugLoggingForTests,
} from '../../src/utils/debug.js'

describe('logForDebugging', () => {
  const priorDebug = process.env['OWLCODA_DEBUG']
  const priorDebugLog = process.env['OWLCODA_DEBUG_LOG']

  afterEach(() => {
    if (priorDebug === undefined) delete process.env['OWLCODA_DEBUG']
    else process.env['OWLCODA_DEBUG'] = priorDebug
    if (priorDebugLog === undefined) delete process.env['OWLCODA_DEBUG_LOG']
    else process.env['OWLCODA_DEBUG_LOG'] = priorDebugLog
    resetDebugLoggingForTests()
  })

  it('writes debug lines to OWLCODA_DEBUG_LOG when OWLCODA_DEBUG is enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-debug-'))
    const logPath = join(dir, 'debug.log')
    process.env['OWLCODA_DEBUG'] = '1'
    process.env['OWLCODA_DEBUG_LOG'] = logPath
    resetDebugLoggingForTests()

    logForDebugging('ambiguous-width: terminal renders Ambiguous glyphs WIDE (2)')

    expect(readFileSync(logPath, 'utf8')).toContain(
      'ambiguous-width: terminal renders Ambiguous glyphs WIDE (2)',
    )
  })
})
