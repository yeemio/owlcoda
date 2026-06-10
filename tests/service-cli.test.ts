/**
 * Smoke/regression coverage for the `owlcoda service` CLI dispatch (doService).
 *
 * The plist logic is unit-tested in service-launchd.test.ts; this guards the
 * cli-core glue: dynamic import resolution + subcommand dispatch. Assertions
 * are machine-independent (only the always-printed header/labels), so they
 * hold whether or not the launchd service is actually installed here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { doService } from '../src/cli-core.js'

function captureStderr(): { lines: () => string; restore: () => void } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return {
    lines: () => spy.mock.calls.map(c => c.map(String).join(' ')).join('\n'),
    restore: () => spy.mockRestore(),
  }
}

describe('doService', () => {
  afterEach(() => vi.restoreAllMocks())

  it('status path prints the launchd service header without throwing', async () => {
    const cap = captureStderr()
    await expect(doService(['status'])).resolves.toBeUndefined()
    const out = cap.lines()
    cap.restore()
    expect(out).toContain('owlcoda service — launchd')
    expect(out).toMatch(/supported\s*:/)
    expect(out).toMatch(/installed\s*:/)
  })

  it('defaults to the status subcommand when none is given', async () => {
    const cap = captureStderr()
    await doService([])
    const out = cap.lines()
    cap.restore()
    expect(out).toContain('owlcoda service — launchd')
  })
})
