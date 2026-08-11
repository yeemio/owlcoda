import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/service-launchd.js', () => ({
  isLaunchdServiceInstalled: () => true,
  kickstartLaunchdService: vi.fn(),
}))

const { doStop } = await import('../src/cli-core.js')

describe('stop under launchd ownership', () => {
  it('fails closed instead of claiming stopped while KeepAlive still owns the daemon', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'owlcoda-service-stop-'))
    const previousHome = process.env.HOME
    const previousOwlcodaHome = process.env.OWLCODA_HOME
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__test_exit_${code}__`)
    }) as never
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.HOME = fixtureRoot
    process.env.OWLCODA_HOME = join(fixtureRoot, '.owlcoda')
    try {
      await expect(doStop()).rejects.toThrow('__test_exit_1__')
      const output = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
      expect(output).toContain('launchd owns the daemon lifecycle')
      expect(output).toContain('owlcoda service uninstall')
      expect(output).not.toContain('owlcoda is not running')
      expect(output).not.toContain('owlcoda stopped')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousOwlcodaHome === undefined) delete process.env.OWLCODA_HOME
      else process.env.OWLCODA_HOME = previousOwlcodaHome
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
