import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectMapSnapshot } from '../../src/native/protocol/project-map-types.js'
import {
  isProjectMapShadowSamplingEnabled,
  recordProjectMapSnapshotSample,
} from '../../src/native/project-map.js'

function makeSnapshot(overrides: Partial<ProjectMapSnapshot> = {}): ProjectMapSnapshot {
  const base = {
    version: 1,
    createdAt: '2026-06-04T00:00:00.000Z',
    cwd: '/tmp/example',
    gitHead: 'abc1234',
    packageName: 'example-pkg',
    sourceFiles: [{ path: 'src/a.ts', kind: 'source', scope: 'source', bytesRead: 10, sha256: 'h1' }],
    entrypoints: [],
    truthSources: [],
    evidenceSeeds: [],
    writeBoundaries: [{ path: 'dist', kind: 'deny', scope: 'path', origin: 'gitignore', reason: 'build output' }],
    verificationProfiles: [
      { id: 'npm-test', appliesTo: 'repo', commands: ['npm test'], taskVerifyChecks: [], artifactPacks: [], requiredBeforeDone: true },
    ],
    freshness: { status: 'fresh', checkedAt: '2026-06-04T00:00:00.000Z', sourceHashes: {} },
  }
  return { ...base, ...overrides } as unknown as ProjectMapSnapshot
}

function readEvents(home: string): Array<Record<string, unknown>> {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(home, 'telemetry', `gate-events-${date}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('Project Map day-0 shadow sampling', () => {
  let tmpHome: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'owlcoda-pmshadow-'))
    for (const key of ['OWLCODA_HOME', 'OWLCODA_PROJECT_MAP_SHADOW']) {
      prev[key] = process.env[key]
      delete process.env[key]
    }
    process.env['OWLCODA_HOME'] = tmpHome
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('records a snapshot_rebuilt sample carrying the freshness decision and map shape', () => {
    recordProjectMapSnapshotSample(makeSnapshot(), true, 'conv-1', 3)

    const events = readEvents(tmpHome)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e['kind']).toBe('project_map_snapshot_sampled')
    expect(e['reason']).toBe('snapshot_rebuilt')
    expect(e['projectMapWasStale']).toBe(true)
    expect(e['conversationId']).toBe('conv-1')
    expect(e['iteration']).toBe(3)
    expect(e['projectMapFreshnessStatus']).toBe('fresh')
    expect(e['projectMapSourceFileCount']).toBe(1)
    expect(e['projectMapWriteBoundaryCount']).toBe(1)
    expect(e['projectMapVerificationProfileCount']).toBe(1)
    expect(e['projectMapGitHead']).toBe('abc1234')
    expect(e['projectMapPackageName']).toBe('example-pkg')
  })

  it('records snapshot_reused when the snapshot was not stale', () => {
    recordProjectMapSnapshotSample(makeSnapshot(), false, 'conv-2', 0)

    const e = readEvents(tmpHome)[0]!
    expect(e['reason']).toBe('snapshot_reused')
    expect(e['projectMapWasStale']).toBe(false)
  })

  it('writes nothing when OWLCODA_PROJECT_MAP_SHADOW=0', () => {
    process.env['OWLCODA_PROJECT_MAP_SHADOW'] = '0'
    recordProjectMapSnapshotSample(makeSnapshot(), true, 'conv-3', 1)
    expect(readEvents(tmpHome)).toHaveLength(0)
  })

  it('shadow sampling defaults on and honors the off switch', () => {
    expect(isProjectMapShadowSamplingEnabled({})).toBe(true)
    expect(isProjectMapShadowSamplingEnabled({ OWLCODA_PROJECT_MAP_SHADOW: '0' })).toBe(false)
    expect(isProjectMapShadowSamplingEnabled({ OWLCODA_PROJECT_MAP_SHADOW: 'off' })).toBe(false)
    expect(isProjectMapShadowSamplingEnabled({ OWLCODA_PROJECT_MAP_SHADOW: '1' })).toBe(true)
  })
})
