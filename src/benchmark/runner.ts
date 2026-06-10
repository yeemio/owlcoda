/**
 * Release Smoke Runner — live execution benchmark (0.14.24)
 *
 * Executes benchmark fixture prompts against a scripted mock provider,
 * runs the real `runConversationLoop`, and diffs actual vs expected
 * gate signals, artifacts, and final status.
 *
 * Gate telemetry is isolated to a per-run temp OWLCODA_HOME so that
 * smoke runs never pollute the user's ~/.owlcoda/telemetry.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createConversation, addUserMessage, runConversationLoop } from '../native/conversation.js'
import { ToolDispatcher } from '../native/dispatch.js'
import { ensureTaskExecutionState } from '../native/task-state.js'
import { listTasks, resetTaskStore } from '../native/tools/task-store.js'
import { BENCHMARK_CASE_FIXTURES } from './fixtures.js'
import { renderBenchmarkTaskPrompt } from './eval-policy.js'
import { BENCHMARK_CASE_IDS } from './types.js'
import type {
  BenchmarkArtifact,
  BenchmarkCaseId,
  BenchmarkDryRunResult,
  BenchmarkFinalStatus,
  BenchmarkTaskNoProgress,
  BenchmarkVerification,
  ScriptedResponse,
} from './types.js'
import { traceFromTurns, diffTrace, type TraceDiffEntry, type ToolCallTraceEntry } from '../native/transcript-trace.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BenchmarkResultDiff {
  taskNoProgressMismatch?: { expected: BenchmarkTaskNoProgress; actual: BenchmarkTaskNoProgress }
  finalStatusMismatch?: { expected: BenchmarkFinalStatus; actual: BenchmarkFinalStatus }
  artifactMismatches: Array<{ path: string; expected: BenchmarkArtifact; actual?: BenchmarkArtifact }>
  verificationMismatches: Array<{ id: string; expected: BenchmarkVerification; actual?: BenchmarkVerification }>
  timeToFirstWriteToleranceExceeded?: { expected: number; actual: number; toleranceMs: number }
  traceMismatches?: TraceDiffEntry[]
}

export interface LiveBenchmarkResult {
  caseId: BenchmarkCaseId
  ranLive: boolean
  skippedReason?: string
  actual?: BenchmarkDryRunResult
  expected: BenchmarkDryRunResult
  diff?: BenchmarkResultDiff
  passed: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TIME_TO_FIRST_WRITE_TOLERANCE_MS = 5000

/** Recursively replace the per-run workspace dir with __WORKSPACE__ in every
 *  nested string. Deep (not just top-level) so paths buried in TaskCreate
 *  deliverables/steps normalize too — otherwise a recorded golden trace drifts
 *  per run on those nested paths. */
function deepNormalizeWorkspace(value: unknown, workspaceDir: string): unknown {
  if (typeof value === 'string') return value.split(workspaceDir).join('__WORKSPACE__')
  if (Array.isArray(value)) return value.map(v => deepNormalizeWorkspace(v, workspaceDir))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepNormalizeWorkspace(v, workspaceDir)
    }
    return out
  }
  return value
}

/** Canonicalize a tool input for the trace so it compares across runs. */
function normalizeTraceInput(workspaceDir: string) {
  return (input: Record<string, unknown>): Record<string, unknown> =>
    deepNormalizeWorkspace(input, workspaceDir) as Record<string, unknown>
}

/**
 * The expected tool-call trace for a scripted case IS the sequence of tool calls
 * the cassette scripts — the mock returns exactly these, so a faithful run
 * reproduces them. Comparing the actual loop-processed trace against this golden
 * catches a loop-deviation regression (a dropped / reordered / early-terminated
 * tool call) on EVERY scripted case, with no separately stored or hand-recorded
 * golden. Verified: derived == actual for all 9 fixtures.
 */
export function traceFromMockSequence(sequence: readonly ScriptedResponse[]): ToolCallTraceEntry[] {
  return sequence.flatMap(r => (r.toolUse ?? []).map(tc => ({ name: tc.toolName, input: tc.input })))
}

/**
 * Build an application/json Response for one ScriptedResponse turn.
 * Substitutes `__WORKSPACE__` placeholders in tool input paths with the
 * actual workspace directory.
 */
function buildMockResponse(scripted: ScriptedResponse, workspaceDir: string): Response {
  const usage = scripted.usage ?? { input_tokens: 5, output_tokens: 5 }
  const content: unknown[] = []

  if (scripted.text) {
    content.push({ type: 'text', text: scripted.text })
  }

  for (const tu of scripted.toolUse ?? []) {
    // Substitute workspace placeholder in every string value of input
    const resolvedInput = substituteWorkspace(tu.input, workspaceDir)
    content.push({
      type: 'tool_use',
      id: `mock-${tu.toolName}-${Math.random().toString(36).slice(2, 8)}`,
      name: tu.toolName,
      input: resolvedInput,
    })
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const body = JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'mock-model',
    content,
    stop_reason: scripted.stopReason,
    usage,
  })

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function substituteWorkspace(input: Record<string, unknown>, workspaceDir: string): Record<string, unknown> {
  return substituteWorkspaceValue(input, workspaceDir) as Record<string, unknown>
}

function substituteWorkspaceValue(value: unknown, workspaceDir: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/__WORKSPACE__/g, workspaceDir)
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteWorkspaceValue(item, workspaceDir))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = substituteWorkspaceValue(child, workspaceDir)
    }
    return result
  }
  return value
}

/**
 * Read gate events from the isolated telemetry dir and tally
 * task_no_progress_hard / task_no_progress_suppressed counts.
 */
function tallGateNoProgress(telemetryDir: string): BenchmarkTaskNoProgress {
  const result: BenchmarkTaskNoProgress = { hard: 0, suppressed: 0 }
  const dir = join(telemetryDir, 'telemetry')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return result
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    try {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { kind?: string }
          if (event.kind === 'task_no_progress_hard') result.hard++
          if (event.kind === 'task_no_progress_suppressed') result.suppressed++
        } catch {
          // malformed line — skip
        }
      }
    } catch {
      // unreadable file — skip
    }
  }

  return result
}

/**
 * Scan the workspace directory for actual artifacts and return them
 * as BenchmarkArtifact records.
 */
function scanWorkspaceArtifacts(workspaceDir: string): BenchmarkArtifact[] {
  const artifacts: BenchmarkArtifact[] = []

  function walk(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
        } else if (stat.isFile()) {
          const rel = full.slice(workspaceDir.length + 1)
          const kind = inferArtifactKind(entry)
          artifacts.push({
            path: rel,
            kind,
            exists: true,
            bytes: stat.size,
            source: 'write',
          })
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  walk(workspaceDir)
  return artifacts
}

function inferArtifactKind(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.html')) return 'html_deck'
  if (lower === 'build-notes.md') return 'build_notes'
  if (lower.endsWith('.md')) return 'markdown_report'
  if (lower.endsWith('.csv')) return 'data_table'
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'patch'
  if (lower.endsWith('.txt')) return 'test_result'
  return basename(filename)
}

/**
 * Infer the final status from the conversation loop result and artifacts.
 * This is purely derived from the actual run — it does NOT use expectedFinalStatus
 * to avoid the expected result contaminating the actual measurement.
 */
function inferFinalStatus(
  stopReason: string | null,
  runtimeFailure: unknown,
  actualArtifacts: BenchmarkArtifact[],
  expectedArtifacts: BenchmarkArtifact[],
): BenchmarkFinalStatus {
  if (runtimeFailure !== null) return 'failed'
  if (stopReason === 'terminal_tool_failure' || stopReason === 'tool_loop') return 'failed'

  // For file-delivery cases: if expected artifacts exist and we found all of them → passed
  if (expectedArtifacts.length > 0) {
    const allPresent = expectedArtifacts.every((expected) =>
      actualArtifacts.some((actual) => actual.path === expected.path || basename(actual.path) === basename(expected.path))
    )
    if (allPresent) return 'passed'
    return 'failed'
  }

  // For read-only / chat-final cases, no artifacts expected → passed when no loop failure
  return 'passed'
}

/**
 * Diff actual vs expected result, producing a BenchmarkResultDiff.
 */
export function diffResults(
  expected: Omit<BenchmarkDryRunResult, 'caseId' | 'packageVersion' | 'binaryBuild'>,
  actual: Omit<BenchmarkDryRunResult, 'caseId' | 'packageVersion' | 'binaryBuild'>,
): BenchmarkResultDiff {
  const diff: BenchmarkResultDiff = {
    artifactMismatches: [],
    verificationMismatches: [],
  }

  // taskNoProgress
  if (
    actual.taskNoProgress.hard !== expected.taskNoProgress.hard ||
    actual.taskNoProgress.suppressed !== expected.taskNoProgress.suppressed
  ) {
    diff.taskNoProgressMismatch = {
      expected: expected.taskNoProgress,
      actual: actual.taskNoProgress,
    }
  }

  // finalStatus
  if (actual.finalStatus !== expected.finalStatus) {
    diff.finalStatusMismatch = {
      expected: expected.finalStatus,
      actual: actual.finalStatus,
    }
  }

  // artifacts — check each expected artifact is present in actual
  for (const expectedArtifact of expected.artifacts) {
    const actualArtifact = actual.artifacts.find(
      (a) => a.path === expectedArtifact.path || basename(a.path) === basename(expectedArtifact.path)
    )
    if (!actualArtifact || !actualArtifact.exists) {
      diff.artifactMismatches.push({ path: expectedArtifact.path, expected: expectedArtifact, actual: actualArtifact })
    }
  }

  // verification — compare only when the live run produced verification
  // evidence. Read-only/chat cases do not call TaskVerify and remain valid.
  if (actual.verification.some((v) => v.status !== 'not_run')) {
    for (const expectedVerification of expected.verification) {
      const actualVerification = actual.verification.find((v) => v.id === expectedVerification.id)
      if (
        !actualVerification ||
        actualVerification.status !== expectedVerification.status ||
        actualVerification.passed !== expectedVerification.passed
      ) {
        diff.verificationMismatches.push({
          id: expectedVerification.id,
          expected: expectedVerification,
          actual: actualVerification,
        })
      }
    }
  }

  // timeToFirstWriteMs — tolerance check only when fixture value > 0
  if (expected.timeToFirstWriteMs > 0) {
    const delta = Math.abs(actual.timeToFirstWriteMs - expected.timeToFirstWriteMs)
    if (delta > TIME_TO_FIRST_WRITE_TOLERANCE_MS) {
      diff.timeToFirstWriteToleranceExceeded = {
        expected: expected.timeToFirstWriteMs,
        actual: actual.timeToFirstWriteMs,
        toleranceMs: TIME_TO_FIRST_WRITE_TOLERANCE_MS,
      }
    }
  }

  // tool-call trace — the runner supplies the golden derived from the cassette.
  // Catches a tool-orchestration deviation the outcome diff above would miss.
  if (expected.trace && expected.trace.length > 0) {
    const td = diffTrace(expected.trace, actual.trace ?? [])
    if (td.length > 0) diff.traceMismatches = td
  }

  return diff
}

export function diffIsClean(diff: BenchmarkResultDiff): boolean {
  return (
    diff.taskNoProgressMismatch === undefined &&
    diff.finalStatusMismatch === undefined &&
    diff.artifactMismatches.length === 0 &&
    diff.verificationMismatches.length === 0 &&
    diff.timeToFirstWriteToleranceExceeded === undefined &&
    (diff.traceMismatches?.length ?? 0) === 0
  )
}

function collectTaskVerificationResults(): BenchmarkVerification[] {
  const results: BenchmarkVerification[] = []
  for (const task of listTasks()) {
    for (const step of task.steps ?? []) {
      for (const verificationResult of step.verificationResults) {
        results.push({
          id: verificationResult.checkId,
          kind: 'task_verify',
          status: verificationResult.passed ? 'passed' : 'failed',
          passed: verificationResult.passed,
          expected: true,
          actual: verificationResult.passed,
          message: verificationResult.detail ?? (verificationResult.passed ? 'passed' : 'failed'),
        })
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

export async function runBenchmarkCaseLive(
  caseId: BenchmarkCaseId,
  opts?: { workspaceDir?: string },
): Promise<LiveBenchmarkResult> {
  const fixture = BENCHMARK_CASE_FIXTURES.find((f) => f.caseId === caseId)
  if (!fixture) {
    throw new Error(`Unknown benchmark case: ${caseId}`)
  }

  // Build expected result shape from fixture dryRun (sans caseId/packageVersion/binaryBuild)
  const expectedDryRun = fixture.dryRun

  const expected: BenchmarkDryRunResult = {
    caseId,
    packageVersion: 'smoke',
    binaryBuild: 'smoke',
    selectedSkill: expectedDryRun.selectedSkill,
    timeToFirstWriteMs: expectedDryRun.timeToFirstWriteMs,
    readCallsBeforeFirstWrite: expectedDryRun.readCallsBeforeFirstWrite,
    artifacts: expectedDryRun.artifacts.map((a) => ({ ...a })),
    verification: expectedDryRun.verification.map((v) => ({ ...v })),
    taskNoProgress: { ...expectedDryRun.taskNoProgress },
    finalStatus: expectedDryRun.finalStatus,
  }

  // No mockResponseSequence → skip
  if (!expectedDryRun.mockResponseSequence || expectedDryRun.mockResponseSequence.length === 0) {
    return {
      caseId,
      ranLive: false,
      skippedReason: 'skipped: needs mock trajectory',
      expected,
      passed: true, // clean skip is not a failure
    }
  }

  const sequence: ScriptedResponse[] = expectedDryRun.mockResponseSequence

  // Create isolated workspace dir
  const workspaceDir = opts?.workspaceDir ?? mkdtempSync(join(tmpdir(), `owlcoda-smoke-${caseId}-`))
  const ownedWorkspace = !opts?.workspaceDir

  // Create isolated telemetry dir
  const isolatedHome = mkdtempSync(join(tmpdir(), `owlcoda-smoke-telemetry-`))
  const prevOwlcodaHome = process.env['OWLCODA_HOME']
  process.env['OWLCODA_HOME'] = isolatedHome

  // Allow writes to the workspace dir (fs-policy uses OWLCODA_ALLOW_FS_ROOTS to
  // extend the allowed write roots beyond process.cwd()). This is required because
  // the write tool defaults workspaceRoot to process.cwd() but our smoke workspace
  // lives under /tmp.
  const prevAllowFsRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
  process.env['OWLCODA_ALLOW_FS_ROOTS'] = workspaceDir

  const envOverrides = fixture.evalPolicy.envOverrides ?? {}
  const prevEnvOverrides: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(envOverrides)) {
    prevEnvOverrides[key] = process.env[key]
    process.env[key] = value
  }

  resetTaskStore()

  // Install fetch mock
  let callIndex = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const idx = callIndex++
    if (idx < sequence.length) {
      return buildMockResponse(sequence[idx]!, workspaceDir)
    }
    // Extra call beyond sequence: return end_turn with empty text
    return new Response(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  let actual: BenchmarkDryRunResult | undefined
  let diff: BenchmarkResultDiff | undefined
  let passed = false

  try {
    const conv = createConversation({
      system: 'You are a helpful assistant.',
      model: 'mock-model',
      maxTokens: 4096,
    })
    addUserMessage(conv, renderBenchmarkTaskPrompt(fixture, workspaceDir))
    ensureTaskExecutionState(conv, workspaceDir)

    const startMs = Date.now()
    let firstWriteMs = 0
    let readCallsBeforeFirstWrite = 0
    let firstWriteLanded = false

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'mock-key',
      maxIterations: sequence.length + 4,
      cwd: workspaceDir,
      callbacks: {
        onToolStart: (toolName: string, _input: Record<string, unknown>) => {
          if (!firstWriteLanded) {
            if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
              readCallsBeforeFirstWrite++
            } else if (toolName === 'write' || toolName === 'edit') {
              firstWriteMs = Date.now() - startMs
              firstWriteLanded = true
            }
          }
        },
      },
    })

    // Collect actual artifacts from workspace
    const actualArtifacts = scanWorkspaceArtifacts(workspaceDir)

    // Collect gate telemetry from isolated home
    const actualTaskNoProgress = tallGateNoProgress(isolatedHome)

    // Infer final status
    const actualFinalStatus = inferFinalStatus(
      result.stopReason,
      result.runtimeFailure,
      actualArtifacts,
      expectedDryRun.artifacts,
    )

    const actualVerification = collectTaskVerificationResults()

    // Build actual BenchmarkDryRunResult
    const actualDryRun: Omit<BenchmarkDryRunResult, 'caseId' | 'packageVersion' | 'binaryBuild'> = {
      selectedSkill: null,
      timeToFirstWriteMs: firstWriteLanded ? firstWriteMs : 0,
      readCallsBeforeFirstWrite,
      artifacts: actualArtifacts,
      verification: actualVerification.length > 0
        ? actualVerification
        : expectedDryRun.verification.map((v) => ({ ...v, status: 'not_run' as const, passed: false, actual: null })),
      taskNoProgress: actualTaskNoProgress,
      finalStatus: actualFinalStatus,
      trace: traceFromTurns(conv.turns, normalizeTraceInput(workspaceDir)),
    }

    actual = {
      caseId,
      packageVersion: 'smoke',
      binaryBuild: 'smoke',
      ...actualDryRun,
    }

    diff = diffResults(
      { ...expectedDryRun, trace: traceFromMockSequence(fixture.dryRun.mockResponseSequence ?? []) },
      actualDryRun,
    )
    passed = diffIsClean(diff)
  } finally {
    // Restore fetch
    globalThis.fetch = originalFetch

    // Restore OWLCODA_HOME
    if (prevOwlcodaHome === undefined) {
      delete process.env['OWLCODA_HOME']
    } else {
      process.env['OWLCODA_HOME'] = prevOwlcodaHome
    }

    // Restore OWLCODA_ALLOW_FS_ROOTS
    if (prevAllowFsRoots === undefined) {
      delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    } else {
      process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllowFsRoots
    }

    // Restore per-case env overrides
    for (const [key, prev] of Object.entries(prevEnvOverrides)) {
      if (prev === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prev
      }
    }

    // Clean up workspace if we created it
    if (ownedWorkspace) {
      try { rmSync(workspaceDir, { recursive: true, force: true }) } catch { /* swallow */ }
    }

    // Clean up isolated telemetry
    try { rmSync(isolatedHome, { recursive: true, force: true }) } catch { /* swallow */ }

    resetTaskStore()
  }

  return {
    caseId,
    ranLive: true,
    actual,
    expected,
    diff,
    passed,
  }
}

export async function runBenchmarkSuiteLive(
  opts?: { workspaceDir?: string },
): Promise<LiveBenchmarkResult[]> {
  const results: LiveBenchmarkResult[] = []
  for (const caseId of BENCHMARK_CASE_IDS) {
    results.push(await runBenchmarkCaseLive(caseId, opts))
  }
  return results
}
