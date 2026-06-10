/**
 * Release Smoke Runner CLI (0.14.24)
 *
 * Usage:
 *   npx tsx scripts/release-smoke.ts
 *   npx tsx scripts/release-smoke.ts --case=readonly-review
 *   npx tsx scripts/release-smoke.ts --json
 *   npx tsx scripts/release-smoke.ts --case=deck-12p --json
 *
 * Exit codes:
 *   0 — all cases passed or cleanly skipped (no mock trajectory)
 *   1 — any case failed, or any case that has a mockResponseSequence was skipped unexpectedly
 */

import { isBenchmarkCaseId, BENCHMARK_CASE_IDS } from '../src/benchmark/index.js'
import { runBenchmarkCaseLive, runBenchmarkSuiteLive } from '../src/benchmark/runner.js'
import type { LiveBenchmarkResult } from '../src/benchmark/runner.js'

function parseArgs(): { caseId: string | null; jsonMode: boolean } {
  const args = process.argv.slice(2)
  let caseId: string | null = null
  let jsonMode = false

  for (const arg of args) {
    if (arg.startsWith('--case=')) {
      caseId = arg.slice('--case='.length)
    } else if (arg === '--json') {
      jsonMode = true
    }
  }

  return { caseId, jsonMode }
}

function resultSummaryLine(r: LiveBenchmarkResult): string {
  if (!r.ranLive) {
    return `  SKIP  ${r.caseId}  (${r.skippedReason ?? 'no mock'})`
  }
  if (r.passed) {
    return `  PASS  ${r.caseId}`
  }
  const problems: string[] = []
  if (r.diff?.finalStatusMismatch) {
    problems.push(`finalStatus: expected=${r.diff.finalStatusMismatch.expected} actual=${r.diff.finalStatusMismatch.actual}`)
  }
  if (r.diff?.taskNoProgressMismatch) {
    const e = r.diff.taskNoProgressMismatch.expected
    const a = r.diff.taskNoProgressMismatch.actual
    problems.push(`taskNoProgress: expected={hard:${e.hard},suppressed:${e.suppressed}} actual={hard:${a.hard},suppressed:${a.suppressed}}`)
  }
  if (r.diff?.artifactMismatches && r.diff.artifactMismatches.length > 0) {
    problems.push(`missing artifacts: ${r.diff.artifactMismatches.map((m) => m.path).join(', ')}`)
  }
  if (r.diff?.timeToFirstWriteToleranceExceeded) {
    const t = r.diff.timeToFirstWriteToleranceExceeded
    problems.push(`timeToFirstWriteMs out of tolerance: expected=${t.expected} actual=${t.actual} tolerance=±${t.toleranceMs}`)
  }
  return `  FAIL  ${r.caseId}  ${problems.join(' | ')}`
}

async function main(): Promise<void> {
  const { caseId, jsonMode } = parseArgs()

  let results: LiveBenchmarkResult[]

  if (caseId !== null) {
    if (!isBenchmarkCaseId(caseId)) {
      console.error(`Unknown case id: ${caseId}. Valid ids: ${BENCHMARK_CASE_IDS.join(', ')}`)
      process.exit(1)
    }
    results = [await runBenchmarkCaseLive(caseId)]
  } else {
    results = await runBenchmarkSuiteLive()
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else {
    console.log('\nOwlCoda Release Smoke Runner\n')
    for (const r of results) {
      console.log(resultSummaryLine(r))
    }
    console.log()
  }

  const failed = results.filter((r) => r.ranLive && !r.passed)
  const cleanSkips = results.filter((r) => !r.ranLive)

  if (!jsonMode) {
    console.log(`${results.filter((r) => r.ranLive && r.passed).length} passed, ${failed.length} failed, ${cleanSkips.length} skipped`)
  }

  if (failed.length > 0) {
    process.exit(1)
  }

  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('Smoke runner fatal:', err)
  process.exit(1)
})
