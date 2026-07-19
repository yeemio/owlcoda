import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli as runRunKitCore } from '../../../scripts/runkit-contract/runkit-cli.mjs'

const execFileAsync = promisify(execFile)

describe('desktop preview script', () => {
  it('starts the App Server desktop renderer in smoke mode', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'owlcoda-preview-runkit-'))
    expect((await runRunKitCore(['init', '--workspace', projectRoot])).exitCode).toBe(0)
    let stdout = ''
    try {
      const result = await execFileAsync(process.execPath, [
        'scripts/start-owlcoda-desktop-preview.mjs',
        '--project-root',
        projectRoot,
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
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }

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
  }, 60_000)
})
