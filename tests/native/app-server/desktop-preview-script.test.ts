import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli as runRunKitCore } from '../../../scripts/runkit-contract/runkit-cli.mjs'

const execFileAsync = promisify(execFile)

describe('desktop preview script', () => {
  it('starts the App Server desktop renderer in smoke mode', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'owlcoda-preview-runkit-'))
    const compileParent = mkdtempSync(join(tmpdir(), 'owlcoda-preview-compile-parent-'))
    const nodeModulesSentinel = join(compileParent, 'node_modules', 'sentinel')
    const runKitSentinel = join(compileParent, 'scripts', 'runkit-contract', 'sentinel')
    mkdirSync(join(compileParent, 'node_modules'), { recursive: true })
    mkdirSync(join(compileParent, 'scripts', 'runkit-contract'), { recursive: true })
    writeFileSync(nodeModulesSentinel, 'preserve\n')
    writeFileSync(runKitSentinel, 'preserve\n')
    expect((await runRunKitCore(['init', '--workspace', projectRoot])).exitCode).toBe(0)
    let stdout = ''
    let compileParentPreserved = false
    let compileParentEntries: string[] = []
    try {
      const result = await execFileAsync(process.execPath, [
        'scripts/start-owlcoda-desktop-preview.mjs',
        '--project-root',
        projectRoot,
        '--compile-dir',
        compileParent,
        '--no-open',
        '--smoke',
        '--port',
        '0',
      ], {
        cwd: process.cwd(),
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      })
      stdout = result.stdout
      compileParentPreserved = existsSync(nodeModulesSentinel) && existsSync(runKitSentinel)
      compileParentEntries = readdirSync(compileParent).sort()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(compileParent, { recursive: true, force: true })
    }

    expect(compileParentPreserved).toBe(true)
    const lastLine = stdout.trim().split('\n').at(-1)
    expect(lastLine).toBeTruthy()
    const result = JSON.parse(lastLine!) as {
      ok: boolean
      desktopUrl: string
      health: { status: string }
      protocol: {
        schemaVersion: string
        protocolVersion: string
        methodCount: number
        stableMethodCount: number
        debugOnlyMethods: string[]
      }
      capabilityGate: {
        ok: boolean
        protocolVersion: string
        requiredStableMissing: string[]
        optionalExperimentalAvailable: string[]
        debugOnlyMethods: string[]
      }
      runKitRail: {
        freshness: string
        source: string
        schemaVersion: string | null
        nextAllowedAction: string | null
        releaseAuthorization: boolean
      }
      hasDesktopShell: boolean
      hasProtocolContractSurface: boolean
      hasRunKitRail: boolean
      hasLiveRuntimeEvents: boolean
      hasLiveRuntimeItems: boolean
      hasToolOutputDelta: boolean
      hasApprovalSurface: boolean
      hasInteractionSurface: boolean
      hasReadOnlyRunKitRail: boolean
      hasProviderEvalReport: boolean
      hasRuntimeFactsSummary: boolean
    }

    expect(result).toMatchObject({
      ok: true,
      hasDesktopShell: true,
      hasProtocolContractSurface: true,
      hasRunKitRail: true,
      hasLiveRuntimeEvents: true,
      hasLiveRuntimeItems: true,
      hasToolOutputDelta: true,
      hasApprovalSurface: true,
      hasInteractionSurface: true,
      hasReadOnlyRunKitRail: true,
      hasProviderEvalReport: true,
      hasRuntimeFactsSummary: true,
    })
    expect(result.desktopUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desktop$/)
    expect(result.health.status).toBe('ok')
    expect(result.protocol).toMatchObject({
      schemaVersion: 'v1',
      protocolVersion: 'v1',
    })
    expect(result.protocol.methodCount).toBeGreaterThan(0)
    expect(result.protocol.stableMethodCount).toBeGreaterThan(0)
    expect(result.protocol.debugOnlyMethods).toEqual(['diagnostic/health'])
    expect(result.capabilityGate).toMatchObject({
      ok: true,
      protocolVersion: 'v1',
      requiredStableMissing: [],
      debugOnlyMethods: ['diagnostic/health'],
    })
    expect(result.capabilityGate.optionalExperimentalAvailable).toContain('benchmark/providerEvalReport/read')
    expect(result.runKitRail).toMatchObject({
      freshness: 'fresh',
      source: 'owlcoda_runkit_inspect_summary',
      schemaVersion: 'OwlCodaRunKitInspectSummaryV1',
      releaseAuthorization: false,
    })
    expect(result.runKitRail.nextAllowedAction).toBeTruthy()
    expect(compileParentEntries).toEqual(['node_modules', 'scripts'])
  }, 60_000)

  it('rejects a nonexistent compile parent inside the source tree without creating it', async () => {
    const compileParent = join(process.cwd(), `.owlcoda-preview-invalid-${process.pid}-${Date.now()}`)
    rmSync(compileParent, { recursive: true, force: true })
    try {
      await expect(execFileAsync(process.execPath, [
        'scripts/start-owlcoda-desktop-preview.mjs',
        '--compile-dir',
        compileParent,
        '--no-open',
        '--smoke',
        '--port',
        '0',
      ], {
        cwd: process.cwd(),
        timeout: 10_000,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('--compile-dir must be outside the OwlCoda source tree'),
      })
      expect(existsSync(compileParent)).toBe(false)
    } finally {
      rmSync(compileParent, { recursive: true, force: true })
    }
  })

  it('rejects a compile parent that resolves through a symlink into the source tree', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-preview-symlink-parent-'))
    const sourceLink = join(sandbox, 'source-link')
    const sourceChildName = `.owlcoda-preview-symlink-invalid-${process.pid}-${Date.now()}`
    const sourceChild = join(process.cwd(), sourceChildName)
    symlinkSync(process.cwd(), sourceLink, 'dir')
    try {
      await expect(execFileAsync(process.execPath, [
        'scripts/start-owlcoda-desktop-preview.mjs',
        '--compile-dir',
        join(sourceLink, sourceChildName),
        '--no-open',
        '--smoke',
        '--port',
        '0',
      ], {
        cwd: process.cwd(),
        timeout: 10_000,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('--compile-dir must be outside the OwlCoda source tree'),
      })
      expect(existsSync(sourceChild)).toBe(false)
    } finally {
      rmSync(sourceChild, { recursive: true, force: true })
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('removes only its isolated child when App Server binding fails', async () => {
    const compileParent = mkdtempSync(join(tmpdir(), 'owlcoda-preview-bind-failure-'))
    const sentinel = join(compileParent, 'caller-owned.txt')
    writeFileSync(sentinel, 'preserve\n')
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('preview port reservation failed')

    try {
      await expect(execFileAsync(process.execPath, [
        'scripts/start-owlcoda-desktop-preview.mjs',
        '--compile-dir',
        compileParent,
        '--no-open',
        '--smoke',
        '--port',
        String(address.port),
      ], {
        cwd: process.cwd(),
        timeout: 45_000,
      })).rejects.toMatchObject({
        stderr: expect.stringMatching(/EADDRINUSE|address already in use/i),
      })
      expect(readdirSync(compileParent)).toEqual(['caller-owned.txt'])
      expect(existsSync(sentinel)).toBe(true)
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()))
      rmSync(compileParent, { recursive: true, force: true })
    }
  }, 60_000)
})
