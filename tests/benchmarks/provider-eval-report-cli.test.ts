import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BenchmarkProviderEvalStoreRecord } from '../../src/benchmark/index.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts')
const runtimeDirs = new Set<string>()

describe('benchmark provider eval report CLI', () => {
  afterEach(() => {
    for (const dir of runtimeDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    runtimeDirs.clear()
  })

  it('prints a local-only markdown report from the default provider eval JSONL store', async () => {
    const home = makeRuntimeDir()
    seedProviderEvalRecords(home, [
      record({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'deck-12p', passed: true, score: 96 }),
      record({ providerId: 'moonshot', modelId: 'kimi-lite', caseId: 'deck-12p', passed: false, score: 55, error: 'missing verification' }),
    ])

    const result = await runCli(['benchmark', 'provider-eval-report'], home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Benchmark Provider Eval Batch Report')
    expect(result.stdout).toContain('local_only=true')
    expect(result.stdout).toContain('| openai/gpt-strong | 1 | 1 | 100% | 96 |')
    expect(result.stdout).toContain('| moonshot/kimi-lite | 1 | 0 | 0% | 55 |')
    expect(result.stdout).toContain('| deck-12p | moonshot/kimi-lite | fail | 55 | warn | missing verification |')
    expect(result.stderr).toBe('')
  })

  it('prints JSON when provider eval report is requested with --json', async () => {
    const home = makeRuntimeDir()
    seedProviderEvalRecords(home, [
      record({ providerId: 'openai', modelId: 'gpt-strong', caseId: 'deck-12p', passed: true, score: 96 }),
    ])

    const result = await runCli(['benchmark', 'provider-eval-report', '--json'], home)

    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      recordCount: 1,
      localOnly: true,
      trainingUse: 'not_collected',
      leaderboard: [{
        providerId: 'openai',
        modelId: 'gpt-strong',
        runCount: 1,
      }],
    })
  })

  it('supports an explicit --record-path without touching the default store', async () => {
    const home = makeRuntimeDir()
    const customPath = join(home, 'custom-provider-eval.jsonl')
    seedProviderEvalRecordsAt(customPath, [
      record({ providerId: 'anthropic', modelId: 'claude-test', caseId: 'readonly-review', passed: true, score: 91 }),
    ])

    const result = await runCli(['benchmark', 'provider-eval-report', '--record-path', customPath], home)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('anthropic/claude-test')
    expect(result.stdout).toContain('readonly-review')
  })
})

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owlcoda-provider-eval-report-cli-'))
  runtimeDirs.add(dir)
  return dir
}

function seedProviderEvalRecords(home: string, records: BenchmarkProviderEvalStoreRecord[]): void {
  seedProviderEvalRecordsAt(join(home, 'benchmark', 'provider-eval.jsonl'), records)
}

function seedProviderEvalRecordsAt(path: string, records: BenchmarkProviderEvalStoreRecord[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

async function runCli(
  args: string[],
  runtimeDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OWLCODA_HOME: runtimeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI command timed out: ${args.join(' ')}`))
    }, 20_000)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function record(input: {
  providerId: string
  modelId: string
  caseId: string
  passed: boolean
  score: number
  error?: string
}): BenchmarkProviderEvalStoreRecord {
  return {
    schemaVersion: 1,
    recordedAt: '2026-06-26T08:00:00.000Z',
    providerId: input.providerId,
    modelId: input.modelId,
    caseId: input.caseId,
    runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
    livePassed: input.passed,
    hasActualResult: input.passed,
    error: input.error,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      durationMs: 1000,
    },
    diffSummary: {
      artifactMismatchCount: input.passed ? 0 : 1,
      verificationMismatchCount: input.passed ? 0 : 1,
      hasFinalStatusMismatch: !input.passed,
      hasTaskNoProgressMismatch: false,
      hasTimeToFirstWriteMismatch: false,
      hasTraceMismatch: false,
    },
    scorecard: {
      runId: `benchmark:${input.caseId}:${input.providerId}:${input.modelId}`,
      overallScore: input.score,
      verdict: input.passed ? 'pass' : 'fail',
      antiCheat: input.passed ? 'pass' : 'warn',
    },
    trajectory: {
      recordCount: 1,
      localOnly: true,
      redactionMode: 'local_redacted_v0',
    },
    evidenceRefs: [`artifact:${input.caseId}`],
  }
}
