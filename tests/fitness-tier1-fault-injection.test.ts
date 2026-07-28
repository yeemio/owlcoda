import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPortInUseMessage, forceStopOrphanDaemon } from '../src/daemon.js'
import { buildFitnessCellTelemetry, listTier1FaultInjectionCells } from '../src/fitness-matrix.js'
import { classifyBinaryFreshness } from '../src/version.js'
import { findImportedUntracked } from '../src/native/import-integrity.js'
import { findInkSideChannelWrites } from '../scripts/ink-write-boundary.mjs'
import {
  TELEMETRY_ENVELOPE_REQUIRED_FIELDS,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
} from '../src/native/telemetry-envelope.js'
import { loadConfig } from '../src/config.js'
import { checkRouterHealth } from '../src/preflight.js'
import { createProviderHttpDiagnostic } from '../src/provider-error.js'
import { dispatchRequestSafely } from '../src/server.js'
// The mirror tooling itself is held back from the public source tree
// (manifest deny, 2026-06-11), so this guard must not hard-import it.
// Private tree: manifest-aware strictness, every shipped evidence ref
// asserted. Public tree (module absent): a missing ref is by definition a
// manifest-denied path, so existence is asserted only for refs that ship.
const isPublicPath: ((path: string) => boolean) | null = await import(
  '../src/public-mirror/manifest.js'
).then((m) => m.isPublicPath).catch(() => null)

const repoRoot = join(import.meta.dirname, '..')
// The public GPL source tree intentionally omits manifest-denied paths (e.g.
// .github/workflows/ci.yml — private self-hosted CI infra must not ship in a
// public repo). In that tree, denied evidence refs cannot exist, so the
// existence assertion skips them; the private repo (docs/ present) still
// asserts every ref at full strength.
const inPublicSourceTree = !existsSync(join(repoRoot, 'docs'))

function makeRes(headersSent = false): ServerResponse {
  return {
    headersSent,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse
}

describe('Fitness Matrix Tier-1 fault-injection contract', () => {
  it('keeps Tier-1 cells CI-runnable and grounded in observable behavior', () => {
    const cells = listTier1FaultInjectionCells()
    expect(cells.length).toBeGreaterThanOrEqual(6)

    for (const cell of cells) {
      expect(cell.tier).toBe('tier1_fault_injection')
      expect(cell.gate).toBe('ci')
      expect(cell.injectionPoint.trim()).not.toBe('')
      expect(cell.observableAssertions.length).toBeGreaterThan(0)
      expect(cell.surfaces.length).toBeGreaterThan(0)
      expect(cell.currentEvidence.length).toBeGreaterThan(0)
      expect(typeof cell.directProbe).toBe('boolean')

      // directProbe is the load-bearing coverage signal. The regex below is a
      // secondary intent-tripwire on assertion prose, NOT the guarantee. The
      // guarantee is structural: a directly-probed cell MUST cite this file
      // (its inline probe lives here) and a reference-only cell MUST NOT — so
      // the matrix can never claim a strong guarantee it does not carry.
      const citesThisFile = cell.currentEvidence.includes(
        'tests/fitness-tier1-fault-injection.test.ts',
      )
      expect(cell.directProbe).toBe(citesThisFile)

      for (const assertion of cell.observableAssertions) {
        expect(assertion).not.toMatch(/\b(flag|boolean|ctx\.|private state|internal flag)\b/i)
      }
      for (const ref of cell.currentEvidence) {
        if (inPublicSourceTree && isPublicPath !== null && !isPublicPath(ref)) continue
        if (inPublicSourceTree && isPublicPath === null && !existsSync(join(repoRoot, ref))) continue
        expect(existsSync(join(repoRoot, ref)), `evidence ref ${ref}`).toBe(true)
      }
    }
  })

  it('tracks the release-critical Tier-1 cells explicitly', () => {
    expect(listTier1FaultInjectionCells().map(cell => cell.id)).toEqual([
      'runtime.unreachable',
      'runtime.upstream_502',
      'config.router_url_v1',
      'daemon.orphan',
      'daemon.request_throw',
      'task.no_progress_advisory',
      'config.migration_preserves_models',
      'build.stale_binary',
      'build.imported_untracked',
      'arch.ink_write_boundary',
    ])
  })
})

describe('Fitness Matrix Tier-1 observable probes', () => {
  let tmpDir: string
  const oldEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owlcoda-fitness-tier1-'))
    for (const key of ['OWLCODA_CATALOG_PATH', 'OWLCODA_HOME', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
      oldEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env['OWLCODA_CATALOG_PATH'] = join(tmpDir, 'missing-catalog.json')
    process.env['OWLCODA_HOME'] = tmpDir
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('config.router_url_v1: loadConfig stores the bare router base', () => {
    const configFile = join(tmpDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({
      routerUrl: 'http://127.0.0.1:11434/v1',
      models: [
        { id: 'local-qwen', backendModel: 'qwen2.5-coder:7b', tier: 'local' },
      ],
    }))

    const config = loadConfig(configFile)

    expect(config.routerUrl).toBe('http://127.0.0.1:11434')
    expect(config.models.map(model => model.id)).toEqual(['local-qwen'])
  })

  it('runtime.unreachable: preflight reports missing instead of throwing', async () => {
    const check = await checkRouterHealth('http://127.0.0.1:1')

    expect(check.status).toBe('missing')
    expect(check.name).toBe('Local runtime')
    expect(check.detail).toContain('Not reachable at http://127.0.0.1:1')
  })

  it('daemon.request_throw: a thrown handler becomes one JSON 500 and does not escape', () => {
    const res = makeRes()
    const onError = vi.fn()

    expect(() => dispatchRequestSafely(() => {
      throw new Error('fitness boom')
    }, res, onError)).not.toThrow()

    expect(onError).toHaveBeenCalledOnce()
    expect(res.writeHead as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ 'content-type': 'application/json' }),
    )
    expect(String((res.end as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('api_error')
  })

  it('daemon.orphan: user-facing message identifies OwlCoda and stop --force can recover PID', async () => {
    expect(buildPortInUseMessage(8019, 'http://127.0.0.1:8019', 4242)).toContain(
      'stale OwlCoda daemon (PID 4242)',
    )

    const signals: Array<[number, string]> = []
    const stopped = await forceStopOrphanDaemon('http://127.0.0.1:8019', {
      fetchHealthz: async () => ({
        status: 'healthy',
        version: '0.15.30',
        pid: 4242,
        runtimeToken: 'trusted-orphan-token',
        host: '127.0.0.1',
        port: 8019,
        routerUrl: 'http://127.0.0.1:11434',
      }),
      readRuntimeMeta: () => ({
        pid: 4242,
        runtimeToken: 'trusted-orphan-token',
        host: '127.0.0.1',
        port: 8019,
        routerUrl: 'http://127.0.0.1:11434',
        version: '0.15.30',
        startedAt: new Date(0).toISOString(),
      }),
      signal: (pid, signal) => { signals.push([pid, signal]); return true },
      waitGone: async () => true,
      isAlive: () => false,
    })

    expect(stopped).toBe(4242)
    expect(signals).toEqual([[4242, 'SIGTERM']])
  })

  it('config.migration_preserves_models: legacy config keeps models, fills backendModel, keeps port', () => {
    const configFile = join(tmpDir, 'legacy-config.json')
    writeFileSync(configFile, JSON.stringify({
      routerUrl: 'http://127.0.0.1:8009',
      port: 9000,
      models: [
        { id: 'qwen3:32b', tier: 'balanced' },
        { id: 'my-model', backendModel: 'custom-backend', tier: 'balanced' },
      ],
    }))

    const config = loadConfig(configFile)

    expect(config.port).toBe(9000)
    const byId = new Map(config.models.map(model => [model.id, model]))
    expect(byId.get('qwen3:32b')?.backendModel).toBe('qwen3:32b')
    expect(byId.get('my-model')?.backendModel).toBe('custom-backend')
  })

  it('runtime.upstream_502: createProviderHttpDiagnostic classifies a 5xx as retryable http_5xx', () => {
    const diag = createProviderHttpDiagnostic(502, 'Bad Gateway', {
      model: 'probe-model',
      endpointUrl: 'https://example.test/v1',
    })

    expect(diag.kind).toBe('http_5xx')
    expect(diag.retryable).toBe(true)
    expect(diag.status).toBe(502)
  })
})

describe('build.stale_binary directProbe (F8)', () => {
  it('classifies a baked SHA that matches HEAD as fresh', () => {
    expect(classifyBinaryFreshness('abc1234', false, 'abc1234def567890')).toBe('fresh')
  })

  it('classifies a baked SHA that differs from HEAD as stale', () => {
    expect(classifyBinaryFreshness('abc1234', false, 'def5678aaaa1111')).toBe('stale')
  })

  it('classifies a matching SHA built from a dirty tree as dirty, not fresh', () => {
    expect(classifyBinaryFreshness('abc1234', true, 'abc1234def567890')).toBe('dirty')
  })

  it('cannot judge a dev/unknown build or an empty HEAD (unknown)', () => {
    expect(classifyBinaryFreshness('dev', false, 'abc1234')).toBe('unknown')
    expect(classifyBinaryFreshness('unknown', false, 'abc1234')).toBe('unknown')
    expect(classifyBinaryFreshness('abc1234', false, '')).toBe('unknown')
  })
})

describe('build.imported_untracked directProbe (#2)', () => {
  it('flags a tracked file importing an untracked sibling', () => {
    const tracked = new Set(['src/a.ts', 'src/b.ts'])
    const graph = [
      { file: 'src/a.ts', resolvedImports: ['src/b.ts', 'src/c.ts'] },
    ]
    expect(findImportedUntracked(graph, tracked)).toEqual([
      { file: 'src/a.ts', missingImport: 'src/c.ts' },
    ])
  })

  it('reports no violations when every imported module is tracked', () => {
    const tracked = new Set(['src/a.ts', 'src/b.ts'])
    const graph = [{ file: 'src/a.ts', resolvedImports: ['src/b.ts'] }]
    expect(findImportedUntracked(graph, tracked)).toEqual([])
  })

  it('collects every untracked import across the graph', () => {
    const tracked = new Set(['src/a.ts'])
    const graph = [
      { file: 'src/a.ts', resolvedImports: ['src/missing1.ts'] },
      { file: 'src/a.ts', resolvedImports: ['src/missing2.ts'] },
    ]
    expect(findImportedUntracked(graph, tracked)).toEqual([
      { file: 'src/a.ts', missingImport: 'src/missing1.ts' },
      { file: 'src/a.ts', missingImport: 'src/missing2.ts' },
    ])
  })
})

describe('arch.ink_write_boundary directProbe (F7)', () => {
  it('flags a stdout.write inside an effect hook and ignores renderer writes outside one', () => {
    const offending = 'useLayoutEffect(() => { terminal.stdout.write("x") }, [])'
    const legit = 'function flush(b) { this.options.stdout.write(b) }'
    expect(findInkSideChannelWrites(offending, 'a.tsx')).toHaveLength(1)
    expect(findInkSideChannelWrites(legit, 'b.tsx')).toEqual([])
  })
})

describe('Fitness cell telemetry mapping', () => {
  it('projects every Tier-1 cell onto the shared telemetry envelope', () => {
    for (const cell of listTier1FaultInjectionCells()) {
      const event = buildFitnessCellTelemetry(cell, {
        decision: cell.directProbe ? 'pass' : 'observe',
        reasonCode: 'tier1_probe',
      })

      expect(event.schemaVersion).toBe(TELEMETRY_ENVELOPE_SCHEMA_VERSION)
      expect(event.origin).toBe(cell.telemetryOrigin)
      expect(event.eventType).toBe(`fitness.${cell.id}`)
      for (const field of TELEMETRY_ENVELOPE_REQUIRED_FIELDS) {
        expect(event[field as keyof typeof event]).toBeDefined()
      }
      expect((event.attributes as Record<string, unknown>)['tier']).toBe(cell.tier)
    }
  })
})
