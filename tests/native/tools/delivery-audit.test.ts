/**
 * Tests for DeliveryAudit tool.
 *
 * Pin the claim-verification heuristics and ownership-bucket logic.
 * Avoid live-git assertions — the tests run inside the owlcoda repo
 * itself, so we focus on path resolution + claim parsing rather than
 * specific git status output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createDeliveryAuditTool } from '../../../src/native/tools/delivery-audit.js'

describe('DeliveryAudit tool', () => {
  let workDir = ''
  const originalCwd = process.cwd()

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'owlcoda-audit-'))
    spawnSync('git', ['init', '-q'], { cwd: workDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: workDir })
    process.chdir(workDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  it('reports clean working tree when nothing changed', async () => {
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {})
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(/Delivery Audit/)
    expect((r.metadata as any).buckets.touchedThisTurn).toEqual([])
  })

  it('buckets a new untracked deliverable as touched + new', async () => {
    await writeFile(join(workDir, 'delivered.ts'), 'export const x = 1\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {
      taskState: { contract: { touchedPaths: ['delivered.ts'] } } as any,
    })
    expect(r.isError).toBe(false)
    const buckets = (r.metadata as any).buckets
    expect(buckets.newUntrackedDeliverables).toContain('delivered.ts')
    expect(buckets.unrelatedResidue).not.toContain('delivered.ts')
  })

  it('build artifacts (e.g. .log) are filtered out of residue', async () => {
    await writeFile(join(workDir, 'leftover.log'), 'log content\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {
      taskState: { contract: { touchedPaths: [] } } as any,
    })
    const buckets = (r.metadata as any).buckets
    expect(buckets.buildArtifacts).toContain('leftover.log')
    expect(buckets.unrelatedResidue).not.toContain('leftover.log')
  })

  it('non-touched untracked file lands in unrelated residue', async () => {
    await writeFile(join(workDir, 'sidecar.txt'), 'unrelated note\n')
    await writeFile(join(workDir, 'delivered.ts'), 'export const x = 1\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {
      taskState: { contract: { touchedPaths: ['delivered.ts'] } } as any,
    })
    const buckets = (r.metadata as any).buckets
    expect(buckets.newUntrackedDeliverables).toContain('delivered.ts')
    expect(buckets.unrelatedResidue).toContain('sidecar.txt')
  })

  it('package-lock.json is NOT filtered as a build artifact (0.13.47 fix)', async () => {
    // 0.13.46 hostile-QA caught lockfile drift hiding behind the build-
    // artifact filter. A tracked lockfile is a release-truth artefact
    // and silently filtering it from the audit is the exact "delivery
    // looks clean but isn't" failure DeliveryAudit exists to prevent.
    await writeFile(join(workDir, 'package-lock.json'), '{}\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {
      taskState: { contract: { touchedPaths: [] } } as any,
    })
    const buckets = (r.metadata as any).buckets
    expect(buckets.buildArtifacts).not.toContain('package-lock.json')
    expect(buckets.unrelatedResidue).toContain('package-lock.json')
  })

  it('verifies file-existence claim by extracting path tokens', async () => {
    await writeFile(join(workDir, 'src.ts'), 'export const x = 1\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['added src.ts'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string }>
    expect(verdicts[0]!.verdict).toBe('confirmed')
  })

  it('marks file-existence claim as unsupported when file missing', async () => {
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['added src/native/missing-file.ts'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string }>
    expect(verdicts[0]!.verdict).toBe('unsupported')
  })

  it('verifies version-shipped claim against package.json', async () => {
    await writeFile(join(workDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['shipped 1.2.3'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string }>
    expect(verdicts[0]!.verdict).toBe('confirmed')
  })

  it('marks version-shipped claim as unsupported when package.json disagrees', async () => {
    await writeFile(join(workDir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['shipped 9.9.9'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string }>
    expect(verdicts[0]!.verdict).toBe('unsupported')
    expect(verdicts[0]!).toMatchObject({ evidence: expect.stringContaining('1.0.0') })
  })

  it('marks version-shipped claim unsupported when lockfile drifts (0.13.47 regression)', async () => {
    await writeFile(join(workDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    await writeFile(join(workDir, 'package-lock.json'), JSON.stringify({
      name: 'test',
      version: '1.0.0',
      packages: { '': { name: 'test', version: '1.0.0' } },
    }))
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['shipped 1.2.3'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string; evidence: string }>
    expect(verdicts[0]!.verdict).toBe('unsupported')
    expect(verdicts[0]!.evidence).toMatch(/package-lock\.json/)
    expect(verdicts[0]!.evidence).toMatch(/1\.0\.0/)
    expect(verdicts[0]!.evidence).toMatch(/npm install --package-lock-only/)
  })

  it('confirms version-shipped claim when both package.json AND lockfile agree (0.13.47 happy path)', async () => {
    await writeFile(join(workDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    await writeFile(join(workDir, 'package-lock.json'), JSON.stringify({
      name: 'test',
      version: '1.2.3',
      packages: { '': { name: 'test', version: '1.2.3' } },
    }))
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['shipped 1.2.3'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string; evidence: string }>
    expect(verdicts[0]!.verdict).toBe('confirmed')
    expect(verdicts[0]!.evidence).toMatch(/both at 1\.2\.3/)
  })

  it('marks tests-pass claim as unverifiable (does not run tests)', async () => {
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['all tests pass'],
    }, {})
    const verdicts = (r.metadata as any).claimVerdicts as Array<{ verdict: string }>
    expect(verdicts[0]!.verdict).toBe('unverifiable')
    expect(verdicts[0]!).toMatchObject({ evidence: expect.stringMatching(/test/) })
  })

  it('verifies expectedFiles input', async () => {
    await writeFile(join(workDir, 'a.ts'), 'a\n')
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      expectedFiles: ['a.ts', 'b.ts'],
    }, {})
    const verdicts = (r.metadata as any).expectedFileVerdicts as Array<{ verdict: string; claim: string }>
    expect(verdicts.find((v) => v.claim === 'a.ts')!.verdict).toBe('confirmed')
    expect(verdicts.find((v) => v.claim === 'b.ts')!.verdict).toBe('unsupported')
  })

  it('emits recommendations when there are unsupported claims', async () => {
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({
      claims: ['added src/missing-1.ts', 'shipped 9.9.9'],
    }, {})
    const recs = (r.metadata as any).recommendations as string[]
    expect(recs.some((rec) => /unsupported/i.test(rec))).toBe(true)
  })

  it('emits no recommendations when working tree is clean and no claims supplied', async () => {
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {})
    const recs = (r.metadata as any).recommendations as string[]
    expect(recs).toEqual([])
  })

  it('reports no-git mode outside a git repo', async () => {
    process.chdir(originalCwd)
    const noGitDir = await mkdtemp(join(tmpdir(), 'owlcoda-audit-nogit-'))
    process.chdir(noGitDir)
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {})
    expect(r.isError).toBe(false)
    expect((r.metadata as any).mode).toBe('no-git')
    process.chdir(originalCwd)
    await rm(noGitDir, { recursive: true, force: true })
    process.chdir(workDir)
  })

  it('auto-lints touched test files for vacuous assertions', async () => {
    const testFile = join(workDir, 'foo.test.ts')
    await writeFile(testFile,
      `it('covers source=model annotation', () => {\n` +
      `  const r = { source: 'model' }\n` +
      `  expect(r.source).toBeDefined()\n` +
      `})\n`,
    )
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({}, {
      taskState: { contract: { touchedPaths: ['foo.test.ts'] } } as any,
    })
    const vacuous = (r.metadata as any).vacuousAssertions as Array<{ testName: string }>
    expect(vacuous.length).toBe(1)
    expect(vacuous[0]!.testName).toMatch(/covers/)
    expect(r.output).toMatch(/Vacuous test assertions/)
  })

  it('respects empty lintTestFiles to skip the lint', async () => {
    const testFile = join(workDir, 'foo.test.ts')
    await writeFile(testFile,
      `it('covers source=model annotation', () => {\n` +
      `  expect({}).toBeDefined()\n` +
      `})\n`,
    )
    const tool = createDeliveryAuditTool()
    const r = await tool.execute({ lintTestFiles: [] }, {
      taskState: { contract: { touchedPaths: ['foo.test.ts'] } } as any,
    })
    expect((r.metadata as any).vacuousAssertions).toEqual([])
    expect((r.metadata as any).testFilesLinted).toBe(0)
  })
})
