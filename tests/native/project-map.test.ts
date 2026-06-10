import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildProjectMapSnapshot, isProjectMapEnabled, isProjectMapSnapshotStale } from '../../src/native/project-map.js'

describe('ProjectMapSnapshot builder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-project-map-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is default-on with explicit OWLCODA_PROJECT_MAP rollback values', () => {
    expect(isProjectMapEnabled({})).toBe(true)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: '1' })).toBe(true)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'true' })).toBe(true)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'yes' })).toBe(true)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'on' })).toBe(true)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: '0' })).toBe(false)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'false' })).toBe(false)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'no' })).toBe(false)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: 'off' })).toBe(false)
    expect(isProjectMapEnabled({ OWLCODA_PROJECT_MAP: '' })).toBe(false)
  })

  it('detects git head, package metadata, instruction sources, entry dirs, and verification scripts', () => {
    initGit(tmpDir, '0123456789abcdef0123456789abcdef01234567')
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'fixture-app',
      version: '1.2.3',
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'root agent rules')
    fs.mkdirSync(path.join(tmpDir, '.owlcoda'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.owlcoda', 'OWLCODA.md'), 'owl local rules')
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true })

    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T00:00:00.000Z',
    })

    expect(snapshot).toMatchObject({
      version: 1,
      createdAt: '2026-05-30T00:00:00.000Z',
      cwd: tmpDir,
      gitRoot: tmpDir,
      gitHead: '0123456789abcdef0123456789abcdef01234567',
      packageName: 'fixture-app',
      packageVersion: '1.2.3',
    })
    expect(snapshot.sourceFiles.map((source) => [source.kind, source.path, source.bytesRead])).toEqual([
      ['AGENTS.md', path.join(tmpDir, 'AGENTS.md'), 16],
      ['.owlcoda/OWLCODA.md', path.join(tmpDir, '.owlcoda', 'OWLCODA.md'), 15],
      ['package', path.join(tmpDir, 'package.json'), fs.statSync(path.join(tmpDir, 'package.json')).size],
    ])
    expect(snapshot.sourceFiles.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true)
    expect(snapshot.entrypoints.map((entry) => [entry.kind, entry.path])).toEqual([
      ['source_dir', path.join(tmpDir, 'src')],
      ['test_dir', path.join(tmpDir, 'tests')],
      ['docs_dir', path.join(tmpDir, 'docs')],
      ['package_script', 'package.json#scripts.test'],
      ['package_script', 'package.json#scripts.typecheck'],
    ])
    expect(snapshot.truthSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'git', path: path.join(tmpDir, '.git', 'HEAD'), safeReadonly: true }),
      expect.objectContaining({ kind: 'package', path: path.join(tmpDir, 'package.json'), safeReadonly: true }),
      expect.objectContaining({ kind: 'file', path: path.join(tmpDir, 'AGENTS.md'), safeReadonly: true }),
    ]))
    expect(snapshot.evidenceSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'instruction', path: path.join(tmpDir, 'AGENTS.md') }),
      expect.objectContaining({ kind: 'package_script', command: 'npm test' }),
    ]))
    expect(snapshot.writeBoundaries).toEqual([
      expect.objectContaining({ kind: 'ask', scope: 'directory', origin: 'detected', path: tmpDir }),
    ])
    expect(snapshot.verificationProfiles).toEqual([
      expect.objectContaining({
        id: 'npm-test',
        appliesTo: 'code_change',
        commands: ['npm test'],
        requiredBeforeDone: true,
      }),
      expect.objectContaining({
        id: 'npm-typecheck',
        appliesTo: 'code_change',
        commands: ['npm run typecheck'],
        requiredBeforeDone: true,
      }),
    ])
    expect(snapshot.freshness).toMatchObject({
      status: 'fresh',
      checkedAt: '2026-05-30T00:00:00.000Z',
      gitHead: '0123456789abcdef0123456789abcdef01234567',
    })
  })

  it('derives structured build profile checks from package artifact metadata', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'artifact-fixture',
      version: '1.0.0',
      main: 'dist/server.js',
      bin: {
        artifact: 'dist/cli.js',
      },
      files: [
        'dist/',
        'README.md',
      ],
      scripts: {
        build: 'tsc',
      },
    })

    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T00:30:00.000Z',
    })

    expect(snapshot.verificationProfiles).toEqual([
      expect.objectContaining({
        id: 'npm-build',
        appliesTo: 'code_change',
        commands: ['npm run build'],
        artifactPacks: ['package-build-artifacts'],
        taskVerifyChecks: [
          expect.objectContaining({
            id: 'project-map-package-main',
            kind: 'file_exists',
            path: 'dist/server.js',
          }),
          expect.objectContaining({
            id: 'project-map-package-bin-artifact',
            kind: 'file_exists',
            path: 'dist/cli.js',
          }),
          expect.objectContaining({
            id: 'project-map-package-files-dist',
            kind: 'artifact_count',
            root: 'dist',
            glob: '**/*',
            min: 1,
          }),
        ],
      }),
    ])
  })

  it('is deterministic for the same fixture when createdAt is supplied', () => {
    initGit(tmpDir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'deterministic',
      version: '0.0.1',
      scripts: { test: 'vitest run' },
    })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'stable rules')
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })

    const first = buildProjectMapSnapshot(tmpDir, { createdAt: '2026-05-30T01:00:00.000Z' })
    const second = buildProjectMapSnapshot(tmpDir, { createdAt: '2026-05-30T01:00:00.000Z' })

    expect(JSON.stringify(first, null, 2)).toBe(JSON.stringify(second, null, 2))
  })

  it('searches upward from nested cwd and caps bytes read per source file', () => {
    initGit(tmpDir, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'abcdef')
    const nested = path.join(tmpDir, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), 'nested instructions')

    const snapshot = buildProjectMapSnapshot(nested, {
      createdAt: '2026-05-30T02:00:00.000Z',
      maxSourceBytes: 3,
    })

    expect(snapshot.cwd).toBe(nested)
    expect(snapshot.gitRoot).toBe(tmpDir)
    expect(snapshot.sourceFiles.map((source) => [source.kind, source.path, source.bytesRead])).toEqual([
      ['CLAUDE.md', path.join(nested, 'CLAUDE.md'), 3],
      ['AGENTS.md', path.join(tmpDir, 'AGENTS.md'), 3],
    ])
    expect(snapshot.sourceFiles.map((source) => snapshot.freshness.sourceHashes[source.path])).toEqual(
      snapshot.sourceFiles.map((source) => source.sha256),
    )
  })

  it('tolerates directories without git metadata or package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'standalone rules')

    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T03:00:00.000Z',
    })

    expect(snapshot.gitRoot).toBeUndefined()
    expect(snapshot.gitHead).toBeUndefined()
    expect(snapshot.packageName).toBeUndefined()
    expect(snapshot.packageVersion).toBeUndefined()
    expect(snapshot.sourceFiles.map((source) => source.kind)).toEqual(['AGENTS.md'])
    expect(snapshot.truthSources).toEqual([
      expect.objectContaining({ kind: 'file', path: path.join(tmpDir, 'AGENTS.md') }),
    ])
    expect(snapshot.verificationProfiles).toEqual([])
    expect(snapshot.freshness.status).toBe('fresh')
  })

  it('marks cached snapshots stale when bounded source evidence changes without a git head change', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'stale-fixture',
      version: '1.0.0',
      scripts: { test: 'vitest run' },
    })
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'first rules')
    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:00:00.000Z',
    })

    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'changed rules')
    expect(isProjectMapSnapshotStale(snapshot, tmpDir)).toBe(true)

    const packageOnlySnapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:01:00.000Z',
    })
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'stale-fixture',
      version: '1.0.1',
      scripts: { test: 'vitest run' },
    })
    expect(isProjectMapSnapshotStale(packageOnlySnapshot, tmpDir)).toBe(true)
  })

  it('detects an edit BEYOND the bounded evidence window (freshness fingerprints full content)', () => {
    // Same first `maxSourceBytes` bytes ("AAAA") and same total length before and
    // after — only bytes past the bounded window change. A hash of just the
    // bounded slice would miss this; the staleness detector must cover the whole
    // file so a large instruction file edited past the window is still refreshed.
    const file = path.join(tmpDir, 'AGENTS.md')
    fs.writeFileSync(file, 'AAAAxxxx')
    const snapshot = buildProjectMapSnapshot(tmpDir, { maxSourceBytes: 4, createdAt: '2026-05-30T06:00:00.000Z' })

    fs.writeFileSync(file, 'AAAAyyyy')
    expect(isProjectMapSnapshotStale(snapshot, tmpDir, { maxSourceBytes: 4 })).toBe(true)
  })

  it('marks cached snapshots stale when new instruction sources appear', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'root rules')
    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:02:00.000Z',
    })

    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'new scoped rules')

    expect(isProjectMapSnapshotStale(snapshot, tmpDir)).toBe(true)
  })

  it('includes a bounded Project Map runtime implementation manifest in freshness', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'runtime-source-fixture',
      version: '1.0.0',
      scripts: { test: 'vitest run' },
    })
    const runtimeFiles = [
      path.join('src', 'native', 'project-map.ts'),
      path.join('src', 'native', 'project-instructions.ts'),
      path.join('src', 'native', 'protocol', 'project-map-types.ts'),
      path.join('src', 'native', 'tools', 'project-map.ts'),
      path.join('src', 'native', 'headless.ts'),
      path.join('src', 'native', 'conversation.ts'),
      path.join('src', 'native', 'run-workspace.ts'),
    ]
    for (const relativePath of runtimeFiles) {
      const filePath = path.join(tmpDir, relativePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, `// ${relativePath}\n`)
    }

    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:02:30.000Z',
    })
    const runtimeSourcePaths = snapshot.sourceFiles
      .filter((source) => source.kind === 'runtime')
      .map((source) => path.relative(tmpDir, source.path))

    expect(runtimeSourcePaths).toEqual(runtimeFiles)
    for (const relativePath of runtimeFiles) {
      const absolutePath = path.join(tmpDir, relativePath)
      expect(snapshot.freshness.sourceHashes[absolutePath]).toMatch(/^[a-f0-9]{64}$/)
    }

    fs.appendFileSync(path.join(tmpDir, runtimeFiles[0]!), '// changed\n')
    expect(isProjectMapSnapshotStale(snapshot, tmpDir)).toBe(true)
  })

  it('includes settings and project agent definitions as bounded control-plane evidence', () => {
    initGit(tmpDir, 'cccccccccccccccccccccccccccccccccccccccc')
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'control-plane-fixture',
      version: '2.0.0',
      scripts: { test: 'vitest run' },
    })
    fs.mkdirSync(path.join(tmpDir, '.owlcoda'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, '.owlcoda', 'agents'), { recursive: true })
    writeJson(path.join(tmpDir, '.owlcoda', 'settings.json'), { projectMap: { enabled: true } })
    writeJson(path.join(tmpDir, '.owlcoda', 'settings.local.json'), { projectMap: { refresh: 'manual' } })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', 'reviewer.md'), '# Reviewer')
    fs.writeFileSync(path.join(tmpDir, '.owlcoda', 'agents', 'verifier.md'), '# Verifier')

    const snapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:03:00.000Z',
    })

    const sourceKindsAndPaths = snapshot.sourceFiles.map((source) => [
      source.kind,
      path.relative(tmpDir, source.path),
    ])
    expect(sourceKindsAndPaths).toEqual(expect.arrayContaining([
      ['settings', path.join('.owlcoda', 'settings.json')],
      ['settings', path.join('.owlcoda', 'settings.local.json')],
      ['agent', path.join('.claude', 'agents', 'reviewer.md')],
      ['agent', path.join('.owlcoda', 'agents', 'verifier.md')],
    ]))
    expect(snapshot.evidenceSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'settings', path: path.join(tmpDir, '.owlcoda', 'settings.json') }),
      expect.objectContaining({ kind: 'agent', path: path.join(tmpDir, '.claude', 'agents', 'reviewer.md') }),
    ]))
    expect(snapshot.truthSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file', path: path.join(tmpDir, '.owlcoda', 'settings.local.json') }),
      expect.objectContaining({ kind: 'file', path: path.join(tmpDir, '.owlcoda', 'agents', 'verifier.md') }),
    ]))
  })
})

function initGit(repo: string, head: string): void {
  const refsDir = path.join(repo, '.git', 'refs', 'heads')
  fs.mkdirSync(refsDir, { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(refsDir, 'main'), `${head}\n`)
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
