/**
 * Live benchmark runner tests (0.14.24)
 *
 * These tests use the scripted mock fetch installed by the runner
 * (globalThis.fetch override), so they run fully offline and are
 * deterministic. Each test restores globalThis.fetch after the run.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBenchmarkCaseLive, runBenchmarkSuiteLive } from '../../src/benchmark/runner.js'
import { BENCHMARK_CASE_FIXTURES } from '../../src/benchmark/fixtures.js'
import { countHtmlDeckSections } from '../../src/benchmark/deck.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runBenchmarkCaseLive', () => {
  it('readonly-review: ranLive=true, passed=true', async () => {
    const result = await runBenchmarkCaseLive('readonly-review')

    expect(result.caseId).toBe('readonly-review')
    expect(result.ranLive).toBe(true)
    expect(result.skippedReason).toBeUndefined()
    expect(result.actual).toBeDefined()
    expect(result.passed).toBe(true)
    expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
    expect(result.diff?.finalStatusMismatch).toBeUndefined()
    expect(result.diff?.artifactMismatches).toHaveLength(0)
  }, 30_000)

  it('deck-12p: ranLive=true, passed=true, artifacts land on disk', async () => {
    // Provide an explicit workspace dir so we can verify artifacts before cleanup
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-test-deck12p-'))

    try {
      const result = await runBenchmarkCaseLive('deck-12p', { workspaceDir })

      expect(result.caseId).toBe('deck-12p')
      expect(result.ranLive).toBe(true)
      expect(result.actual).toBeDefined()
      expect(result.passed).toBe(true)

      // Verify artifacts actually landed on disk
      expect(existsSync(join(workspaceDir, 'deck.html'))).toBe(true)
      expect(existsSync(join(workspaceDir, 'build-notes.md'))).toBe(true)

      // Diff should be clean
      expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
      expect(result.diff?.finalStatusMismatch).toBeUndefined()
      expect(result.diff?.artifactMismatches).toHaveLength(0)
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('deck-46p: ranLive=true, passed=true, covers long-deck structured progress', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-test-deck46p-'))

    try {
      const result = await runBenchmarkCaseLive('deck-46p', { workspaceDir })

      expect(result.caseId).toBe('deck-46p')
      expect(result.ranLive).toBe(true)
      expect(result.skippedReason).toBeUndefined()
      expect(result.actual).toBeDefined()
      expect(result.passed).toBe(true)

      const deckPath = join(workspaceDir, 'deck.html')
      expect(existsSync(deckPath)).toBe(true)
      expect(existsSync(join(workspaceDir, 'build-notes.md'))).toBe(true)
      expect(countHtmlDeckSections(readFileSync(deckPath, 'utf8'))).toBe(46)

      expect(result.actual?.taskNoProgress.hard).toBe(0)
      expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
      expect(result.diff?.finalStatusMismatch).toBeUndefined()
      expect(result.diff?.artifactMismatches).toHaveLength(0)

      const sequence = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === 'deck-46p')!.dryRun.mockResponseSequence!
      const toolNames = sequence.flatMap((turn) => (turn.toolUse ?? []).map((tool) => tool.toolName))
      expect(toolNames).toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate', 'ArtifactVerify', 'TaskVerify']))
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('code-fix-tests: ranLive=true, passed=true, writes patch and test artifacts', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-test-codefix-'))

    try {
      const result = await runBenchmarkCaseLive('code-fix-tests', { workspaceDir })

      expect(result.caseId).toBe('code-fix-tests')
      expect(result.ranLive).toBe(true)
      expect(result.skippedReason).toBeUndefined()
      expect(result.actual).toBeDefined()
      expect(result.passed).toBe(true)

      const patchPath = join(workspaceDir, 'code-fix-tests', 'patch.diff')
      const testResultPath = join(workspaceDir, 'code-fix-tests', 'test-result.txt')
      expect(existsSync(patchPath)).toBe(true)
      expect(existsSync(testResultPath)).toBe(true)
      expect(readFileSync(testResultPath, 'utf8')).toContain('PASS tests/unit/score.test.ts')

      expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
      expect(result.diff?.finalStatusMismatch).toBeUndefined()
      expect(result.diff?.artifactMismatches).toHaveLength(0)

      const sequence = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === 'code-fix-tests')!.dryRun.mockResponseSequence!
      const toolNames = sequence.flatMap((turn) => (turn.toolUse ?? []).map((tool) => tool.toolName))
      expect(toolNames).toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate', 'write', 'TaskVerify']))
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('smoke-provenance-article: blocks invented write, workspace stays empty, passed=true', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-test-smoke-prov-article-'))

    try {
      const result = await runBenchmarkCaseLive('smoke-provenance-article', { workspaceDir })

      expect(result.caseId).toBe('smoke-provenance-article')
      expect(result.ranLive).toBe(true)
      expect(result.skippedReason).toBeUndefined()
      expect(result.actual).toBeDefined()
      expect(result.passed).toBe(true)

      // Write was blocked by the provenance gate — invented file must not exist.
      expect(existsSync(join(workspaceDir, 'src', 'invented.ts'))).toBe(false)
      expect(result.actual?.artifacts ?? []).toEqual([])

      expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
      expect(result.diff?.finalStatusMismatch).toBeUndefined()
      expect(result.diff?.artifactMismatches).toHaveLength(0)
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('smoke-provenance-known-file: declared path admits, write lands, passed=true', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'owlcoda-test-smoke-prov-known-'))

    try {
      const result = await runBenchmarkCaseLive('smoke-provenance-known-file', { workspaceDir })

      expect(result.caseId).toBe('smoke-provenance-known-file')
      expect(result.ranLive).toBe(true)
      expect(result.skippedReason).toBeUndefined()
      expect(result.actual).toBeDefined()
      expect(result.passed).toBe(true)

      const notesPath = join(workspaceDir, 'notes.md')
      expect(existsSync(notesPath)).toBe(true)
      expect(readFileSync(notesPath, 'utf8')).toContain('export const SMOKE = true')

      expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
      expect(result.diff?.finalStatusMismatch).toBeUndefined()
      expect(result.diff?.artifactMismatches).toHaveLength(0)
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('research-note and data-report: ranLive=true, passed=true, writes deliverables through task verification', async () => {
    for (const caseId of ['research-note', 'data-report'] as const) {
      const workspaceDir = mkdtempSync(join(tmpdir(), `owlcoda-test-${caseId}-`))

      try {
        const result = await runBenchmarkCaseLive(caseId, { workspaceDir })

        expect(result.caseId).toBe(caseId)
        expect(result.ranLive).toBe(true)
        expect(result.skippedReason).toBeUndefined()
        expect(result.actual).toBeDefined()
        expect(result.passed).toBe(true)
        expect(result.diff?.taskNoProgressMismatch).toBeUndefined()
        expect(result.diff?.finalStatusMismatch).toBeUndefined()
        expect(result.diff?.artifactMismatches).toHaveLength(0)

        const sequence = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === caseId)!.dryRun.mockResponseSequence!
        const toolNames = sequence.flatMap((turn) => (turn.toolUse ?? []).map((tool) => tool.toolName))
        expect(toolNames).toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate', 'write', 'TaskVerify']))
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    }
  }, 45_000)
})

describe('runBenchmarkSuiteLive', () => {
  it('returns 9 results: all cases ran live with no skips', async () => {
    const results = await runBenchmarkSuiteLive()

    expect(results).toHaveLength(9)

    const live = results.filter((r) => r.ranLive)
    const skipped = results.filter((r) => !r.ranLive)

    expect(live).toHaveLength(9)
    expect(skipped).toHaveLength(0)

    expect(results.every((r) => r.passed)).toBe(true)

    // deck-46p-realistic must pass (Patch 1 regression gate)
    const realisticResult = results.find((r) => r.caseId === 'deck-46p-realistic')
    expect(realisticResult?.ranLive).toBe(true)
    expect(realisticResult?.passed).toBe(true)
  }, 60_000)
})

describe('mismatch detection', () => {
  it('passed=false and diff accurate when taskNoProgress.hard is injected as 1', async () => {
    // Temporarily patch the fixture's dryRun.taskNoProgress.hard to 1
    // so the runner's actual (0) diverges from expected (1).
    const fixture = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === 'readonly-review')!
    const originalHard = fixture.dryRun.taskNoProgress.hard
    fixture.dryRun.taskNoProgress.hard = 1

    try {
      const result = await runBenchmarkCaseLive('readonly-review')

      expect(result.ranLive).toBe(true)
      expect(result.passed).toBe(false)
      expect(result.diff?.taskNoProgressMismatch).toBeDefined()
      expect(result.diff!.taskNoProgressMismatch!.expected.hard).toBe(1)
      expect(result.diff!.taskNoProgressMismatch!.actual.hard).toBe(0)
    } finally {
      fixture.dryRun.taskNoProgress.hard = originalHard
    }
  }, 30_000)

  it('passed=false and diff accurate when finalStatus expected is "failed" but actual is "passed"', async () => {
    const fixture = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === 'readonly-review')!
    const originalStatus = fixture.dryRun.finalStatus
    fixture.dryRun.finalStatus = 'failed'

    try {
      const result = await runBenchmarkCaseLive('readonly-review')

      expect(result.ranLive).toBe(true)
      expect(result.passed).toBe(false)
      expect(result.diff?.finalStatusMismatch).toBeDefined()
      expect(result.diff!.finalStatusMismatch!.expected).toBe('failed')
      expect(result.diff!.finalStatusMismatch!.actual).toBe('passed')
    } finally {
      fixture.dryRun.finalStatus = originalStatus
    }
  }, 30_000)
})
