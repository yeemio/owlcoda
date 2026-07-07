/**
 * OwlCoda Native TaskVerify Tool — Slice 3, Task Execution Mode v1
 *
 * Deterministic verification for task step completion checks.
 * Supports: file_exists, file_contains, artifact_count, verification_pack,
 * run_verdict_gate, http_get (localhost only), command (safe_readonly only), none.
 *
 * By default (writeBack=true), verification results are written back to the step's
 * verificationResults via TaskUpdate semantics. Does NOT auto-transition step status —
 * the model must still call TaskUpdate to set stepStatus='completed' explicitly.
 *
 * Security: `command` checks are gated by classifyBashCommand and refused if
 * not safe_readonly. This mirrors the TaskCreate command gate.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { NativeToolDef, ToolResult } from './types.js'
import {
  getTask,
  getTaskStep,
  updateTaskStep,
  type TaskVerificationCheck,
  type TaskVerificationResult,
} from './task-store.js'
import { primaryBashRiskReason } from '../bash-risk.js'
import { buildBashExecutionEnv } from './bash.js'
import { classifyTaskVerifyCommand } from './task-verification-policy.js'
import { verifyHtmlDeck } from '../verification-packs/html-deck.js'
import { evaluateRunVerdictGate, formatRunVerdictGateResult } from '../run-verdict-gate.js'

const execFileAsync = promisify(execFile)

const VERIFY_COMMAND_TIMEOUT_MS = 30_000
const VERIFY_HTTP_TIMEOUT_MS = 10_000

interface VerificationRuntimeContext {
  cwd: string
}

interface VerificationPathEvidence {
  input: string
  cwd: string
  resolvedPath: string
  exists: boolean
  kind?: 'file' | 'directory' | 'other'
  statError?: string
}

export interface TaskVerifyInput {
  taskId: string
  stepId: string
  /** When true (default), write verification results back to step.verificationResults. */
  writeBack?: boolean
}

// ---------------------------------------------------------------------------
// Unsatisfiable-path heuristic
// ---------------------------------------------------------------------------

// A path segment that is an unresolved authoring placeholder: the task author
// templated the verification spec and never substituted the real path, so the
// check can never pass. Conservative tokens only — `xxx`(≥3), angle/curly
// brackets, `path/to/`, or a literal PLACEHOLDER/TODO/TBD segment.
const PLACEHOLDER_PATH_RE = /(?:^|[/_-])x{3,}(?:[/_.-]|$)|[<>]|\{\{|\}\}|(?:^|\/)path\/to\/|(?:^|[/_-])(?:PLACEHOLDER|TODO|TBD)(?:[/_.-]|$)/i

function placeholderReason(p: string): string | null {
  return PLACEHOLDER_PATH_RE.test(p)
    ? `path looks like an unresolved placeholder ("${p}") — substitute the real path in the step's verification`
    : null
}

function canonicalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function resolveVerificationPath(inputPath: string, ctx: VerificationRuntimeContext): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(ctx.cwd, inputPath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function inspectVerificationPath(inputPath: string, ctx: VerificationRuntimeContext): VerificationPathEvidence {
  const resolvedPath = resolveVerificationPath(inputPath, ctx)
  try {
    const stat = fs.statSync(resolvedPath)
    return {
      input: inputPath,
      cwd: ctx.cwd,
      resolvedPath,
      exists: true,
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    }
  } catch (err) {
    return {
      input: inputPath,
      cwd: ctx.cwd,
      resolvedPath,
      exists: false,
      statError: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Individual check runners
// ---------------------------------------------------------------------------

async function runFileExists(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult> {
  const p = check.path ?? ''
  if (!p) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.path is required for file_exists', checkedAt: now }
  }
  const placeholder = placeholderReason(p)
  if (placeholder) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: placeholder, checkedAt: now }
  }
  const evidence = inspectVerificationPath(p, ctx)
  if (evidence.exists) {
    return {
      checkId: check.id,
      passed: true,
      detail: `exists (${evidence.kind ?? 'other'})`,
      checkedAt: now,
      metadata: { path: evidence },
    }
  }
  return {
    checkId: check.id,
    passed: false,
    detail: `not found: ${p} (cwd=${ctx.cwd}, resolved=${evidence.resolvedPath})`,
    checkedAt: now,
    metadata: { path: evidence },
  }
}

async function runFileContains(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult> {
  const p = check.path ?? ''
  const pattern = check.pattern ?? ''
  if (!p || !pattern) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.path and check.pattern are required for file_contains', checkedAt: now }
  }
  const placeholder = placeholderReason(p)
  if (placeholder) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: placeholder, checkedAt: now }
  }
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: `invalid regex pattern: ${String(err)}`, checkedAt: now }
  }
  const evidence = inspectVerificationPath(p, ctx)
  try {
    const content = fs.readFileSync(evidence.resolvedPath, 'utf-8')
    const matched = re.test(content)
    return {
      checkId: check.id,
      passed: matched,
      detail: matched ? `pattern /${pattern}/ found` : `pattern /${pattern}/ not found in ${p}`,
      checkedAt: now,
      metadata: { path: evidence },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      checkId: check.id,
      passed: false,
      detail: `cannot read file: ${p} (cwd=${ctx.cwd}, resolved=${evidence.resolvedPath}): ${message}`,
      checkedAt: now,
      metadata: { path: evidence },
    }
  }
}

async function runArtifactCount(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult> {
  const root = check.root ?? ''
  const globPattern = check.glob ?? ''
  const min = check.min ?? 1
  if (!root || !globPattern) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.root and check.glob are required for artifact_count', checkedAt: now }
  }

  // Simple glob matching: support basic patterns like *.html or **/*.ts
  // We use fs.readdirSync with recursive (Node 18.17+) or walk manually
  let count = 0
  const rootEvidence = inspectVerificationPath(root, ctx)
  try {
    count = countMatchingFiles(rootEvidence.resolvedPath, globPattern)
  } catch {
    return {
      checkId: check.id,
      passed: false,
      detail: `cannot list directory: ${root} (cwd=${ctx.cwd}, resolved=${rootEvidence.resolvedPath})`,
      checkedAt: now,
      metadata: { root: rootEvidence },
    }
  }

  const passed = count >= min
  return {
    checkId: check.id,
    passed,
    detail: passed ? `found ${count} matching files (min=${min})` : `expected >=${min}, got ${count}`,
    checkedAt: now,
    metadata: { root: rootEvidence },
  }
}

/**
 * Count files matching a simple glob pattern under root.
 * Supports: *.ext, **\/*.ext, literal filenames.
 */
function countMatchingFiles(root: string, globPattern: string): number {
  // Convert simple glob to regex
  const escaped = globPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * and ?
    .replace(/\*\*\//g, '(?:.+/)?')        // **/ matches any depth
    .replace(/\*/g, '[^/]*')               // * matches non-separator
    .replace(/\?/g, '[^/]')               // ? matches single non-separator
  const re = new RegExp(`^${escaped}$`)

  let count = 0

  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath)
      } else if (entry.isFile()) {
        if (re.test(relPath)) count++
      }
    }
  }

  walk(root, '')
  return count
}

async function runCommand(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult> {
  const cmd = check.command ?? ''
  if (!cmd) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.command is required for command check', checkedAt: now }
  }

  // Gate: must be safe_readonly. A refused command is unsatisfiable — it will
  // be refused on every re-run; only an edit to the verification spec helps.
  const policy = classifyTaskVerifyCommand(cmd)
  if (!policy.allowed) {
    return {
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: `command refused by risk classifier: ${policy.risk.level} (${primaryBashRiskReason(policy.risk)}). Only safe_readonly commands are allowed for TaskVerify.`,
      checkedAt: now,
      metadata: { commandPolicy: policy },
    }
  }

  const expectedCode = check.expectedExitCode ?? 0

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', cmd], {
      timeout: VERIFY_COMMAND_TIMEOUT_MS,
      encoding: 'utf-8',
      cwd: ctx.cwd,
      env: buildBashExecutionEnv(),
    })
    const detail = stdout.trim().slice(0, 500) || stderr.trim().slice(0, 500) || '(no output)'
    return {
      checkId: check.id,
      passed: true,
      detail: `exit 0: ${detail}`,
      checkedAt: now,
      metadata: { cwd: ctx.cwd, commandPolicy: policy },
    }
  } catch (err: unknown) {
    const anyErr = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string }
    const exitCode = anyErr.code ?? -1
    if (anyErr.killed) {
      return { checkId: check.id, passed: false, detail: `command timed out after ${VERIFY_COMMAND_TIMEOUT_MS}ms`, checkedAt: now }
    }
    if (exitCode === expectedCode) {
      return {
        checkId: check.id,
        passed: true,
        detail: `exit ${exitCode} (expected)`,
        checkedAt: now,
        metadata: { cwd: ctx.cwd, commandPolicy: policy },
      }
    }
    const output = (anyErr.stdout ?? '').trim().slice(0, 300) || (anyErr.stderr ?? '').trim().slice(0, 300)
    return {
      checkId: check.id,
      passed: false,
      detail: `exit ${exitCode} (expected ${expectedCode})${output ? ': ' + output : ''}`,
      checkedAt: now,
      metadata: { cwd: ctx.cwd, commandPolicy: policy },
    }
  }
}

async function runRunVerdictGate(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult> {
  const p = check.path ?? ''
  if (!p) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.path is required for run_verdict_gate', checkedAt: now }
  }
  const placeholder = placeholderReason(p)
  if (placeholder) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: placeholder, checkedAt: now }
  }
  const evidence = inspectVerificationPath(p, ctx)
  try {
    const raw = fs.readFileSync(evidence.resolvedPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const gate = evaluateRunVerdictGate(parsed, { scorePath: evidence.resolvedPath })
    return {
      checkId: check.id,
      passed: gate.status === 'pass',
      detail: formatRunVerdictGateResult(gate),
      checkedAt: now,
      metadata: { runVerdictGate: gate, path: evidence },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      checkId: check.id,
      passed: false,
      detail: `cannot read or parse run verdict artifact ${p} (cwd=${ctx.cwd}, resolved=${evidence.resolvedPath}): ${message}`,
      checkedAt: now,
      metadata: { path: evidence },
    }
  }
}

async function runHttpGet(check: TaskVerificationCheck, now: string): Promise<TaskVerificationResult> {
  const rawUrl = check.url ?? ''
  if (!rawUrl) {
    return { checkId: check.id, passed: false, unsatisfiable: true, detail: 'check.url is required for http_get', checkedAt: now }
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (err) {
    return {
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: `invalid http_get url "${rawUrl}": ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: now,
    }
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return {
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: `http_get supports only http/https URLs (got ${url.protocol})`,
      checkedAt: now,
    }
  }
  if (!isLocalHttpHost(url.hostname)) {
    return {
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: `http_get verification allows only localhost/127.0.0.1/::1 URLs, got ${url.hostname}`,
      checkedAt: now,
    }
  }

  let bodyRe: RegExp | undefined
  if (check.bodyPattern?.trim()) {
    try {
      bodyRe = new RegExp(check.bodyPattern)
    } catch (err) {
      return {
        checkId: check.id,
        passed: false,
        unsatisfiable: true,
        detail: `invalid bodyPattern regex: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt: now,
      }
    }
  }

  const expectedStatus = check.expectedStatus ?? 200
  try {
    const res = await fetch(url.href, {
      method: 'GET',
      signal: AbortSignal.timeout(VERIFY_HTTP_TIMEOUT_MS),
      headers: { Accept: 'application/json, text/plain, text/html, */*' },
    })
    const text = await res.text()
    const statusPassed = res.status === expectedStatus
    const bodyPassed = bodyRe ? bodyRe.test(text) : true
    return {
      checkId: check.id,
      passed: statusPassed && bodyPassed,
      detail: statusPassed && bodyPassed
        ? `http ${res.status}: ${text.trim().slice(0, 300) || '(empty body)'}`
        : `http ${res.status} (expected ${expectedStatus})${bodyRe && !bodyPassed ? `; bodyPattern /${check.bodyPattern}/ not found` : ''}`,
      checkedAt: now,
      metadata: {
        http: {
          url: url.href,
          status: res.status,
          expectedStatus,
          bodyBytes: text.length,
        },
      },
    }
  } catch (err) {
    return {
      checkId: check.id,
      passed: false,
      detail: `http_get failed for ${url.href}: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: now,
    }
  }
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
}

function runNone(check: TaskVerificationCheck, now: string): TaskVerificationResult {
  return {
    checkId: check.id,
    passed: true,
    detail: `no verification performed: ${check.reason ?? '(no reason given)'}`,
    checkedAt: now,
  }
}

function packCheckId(check: TaskVerificationCheck, packCheckId: string): string {
  return `${check.id}.${packCheckId}`
}

async function runVerificationPack(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult[]> {
  if (check.packId !== 'html_deck') {
    return [{
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: `unknown verification pack: ${check.packId ?? '(missing packId)'}`,
      checkedAt: now,
    }]
  }

  if (!check.deckPath) {
    return [{
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: 'check.deckPath is required for verification_pack/html_deck',
      checkedAt: now,
    }]
  }

  if (
    typeof check.expectedSections !== 'number'
    || !Number.isInteger(check.expectedSections)
    || check.expectedSections < 0
  ) {
    return [{
      checkId: check.id,
      passed: false,
      unsatisfiable: true,
      detail: 'check.expectedSections must be a non-negative integer for verification_pack/html_deck',
      checkedAt: now,
    }]
  }

  const packResult = verifyHtmlDeck({
    deckPath: resolveVerificationPath(check.deckPath, ctx),
    expectedSections: check.expectedSections,
    ...(typeof check.buildNotesPath === 'string' && check.buildNotesPath.trim()
      ? { buildNotesPath: resolveVerificationPath(check.buildNotesPath, ctx) }
      : {}),
    ...(Array.isArray(check.requiredMarkers) ? { requiredMarkers: check.requiredMarkers } : {}),
    ...(typeof check.minFileSizeBytes === 'number' ? { minFileSizeBytes: check.minFileSizeBytes } : {}),
    ...(typeof check.minSectionBytes === 'number' ? { minSectionBytes: check.minSectionBytes } : {}),
    ...(Array.isArray(check.forbiddenTerms) ? { forbiddenTerms: check.forbiddenTerms } : {}),
  })

  return packResult.checks.map(packCheck => ({
    checkId: packCheckId(check, packCheck.checkId),
    passed: packCheck.passed,
    detail: `[${packResult.packId}] ${packCheck.detail}`,
    checkedAt: packResult.checkedAt || now,
    metadata: {
      packId: packResult.packId,
      packStatus: packResult.status,
      artifactPath: packResult.artifactPath,
      packCheckId: packCheck.checkId,
      severity: packCheck.severity,
      ...(packCheck.metadata ? { packCheckMetadata: packCheck.metadata } : {}),
    },
  }))
}

async function runCheck(check: TaskVerificationCheck, now: string, ctx: VerificationRuntimeContext): Promise<TaskVerificationResult[]> {
  switch (check.kind) {
    case 'file_exists': return [await runFileExists(check, now, ctx)]
    case 'file_contains': return [await runFileContains(check, now, ctx)]
    case 'artifact_count': return [await runArtifactCount(check, now, ctx)]
    case 'verification_pack': return runVerificationPack(check, now, ctx)
    case 'run_verdict_gate': return [await runRunVerdictGate(check, now, ctx)]
    case 'http_get': return [await runHttpGet(check, now)]
    case 'command': return [await runCommand(check, now, ctx)]
    case 'none': return [runNone(check, now)]
    default:
      return [{
        checkId: check.id,
        passed: false,
        unsatisfiable: true,
        detail: `unknown check kind: ${(check as TaskVerificationCheck).kind}`,
        checkedAt: now,
      }]
  }
}

interface TaskVerifyRepairCheckpoint {
  taskId: string
  stepId: string
  status: 'verification_failed'
  failedCheckIds: string[]
  retryableCheckIds: string[]
  unsatisfiableCheckIds: string[]
  nextAction:
    | 'fix_artifact_or_service_then_reverify'
    | 'update_verification_spec_then_reverify'
    | 'fix_blocking_artifact_or_runtime_then_reverify'
  reverifyCommand: string
  taskUpdateCommand?: string
}

function buildRepairCheckpoint(
  taskId: string,
  stepId: string,
  results: TaskVerificationResult[],
  runVerdictBlocked: TaskVerificationResult[],
): TaskVerifyRepairCheckpoint | undefined {
  const failed = results.filter(r => !r.passed)
  if (failed.length === 0) return undefined

  const unsatisfiable = failed.filter(r => r.unsatisfiable)
  const retryable = failed.filter(r => !r.unsatisfiable)
  const nextAction = unsatisfiable.length > 0
    ? 'update_verification_spec_then_reverify'
    : runVerdictBlocked.length > 0
      ? 'fix_blocking_artifact_or_runtime_then_reverify'
      : 'fix_artifact_or_service_then_reverify'

  return {
    taskId,
    stepId,
    status: 'verification_failed',
    failedCheckIds: failed.map(r => r.checkId),
    retryableCheckIds: retryable.map(r => r.checkId),
    unsatisfiableCheckIds: unsatisfiable.map(r => r.checkId),
    nextAction,
    reverifyCommand: `TaskVerify({ taskId: "${taskId}", stepId: "${stepId}", writeBack: true })`,
    ...(unsatisfiable.length > 0
      ? { taskUpdateCommand: `TaskUpdate({ taskId: "${taskId}", stepId: "${stepId}", verification: [...] })` }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTaskVerifyTool(): NativeToolDef<TaskVerifyInput> {
  return {
    name: 'TaskVerify',
    description:
      'Run deterministic verification checks defined on a task step. ' +
      'Supports: file_exists, file_contains, artifact_count, verification_pack/html_deck, run_verdict_gate, http_get (localhost only), command (safe_readonly only), none. ' +
      'By default (writeBack=true), results are written back to step.verificationResults so subsequent ' +
      'TaskUpdate can check them before allowing stepStatus=completed. ' +
      'Does NOT auto-transition step status — use TaskUpdate(stepStatus="completed") after all checks pass. ' +
      'Use this after every step that touches files to build deterministic artifact evidence.',
    maturity: 'beta' as const,

    async execute(input: TaskVerifyInput): Promise<ToolResult> {
      const { taskId, stepId, writeBack = true } = input

      if (!taskId || !stepId) {
        return { output: 'taskId and stepId are both required.', isError: true }
      }

      const task = getTask(taskId)
      if (!task) {
        return { output: `Task "${taskId}" not found.`, isError: true }
      }

      const step = getTaskStep(taskId, stepId)
      if (!step) {
        const stepIds = (task.steps ?? []).map(s => s.id)
        const hint = stepIds.length > 0
          ? ` Available steps: ${stepIds.join(', ')}.`
          : ' This task has no steps.'
        return { output: `Step "${stepId}" not found in task "${taskId}".${hint}`, isError: true }
      }

      if (!step.verification || step.verification.length === 0) {
        const msg = `Step "${stepId}" has no verification checks defined.`
        return {
          output: msg,
          isError: false,
          metadata: { taskId, stepId, passed: true, results: [] },
        }
      }

      const now = new Date().toISOString()
      const verificationContext: VerificationRuntimeContext = {
        cwd: canonicalizeCwd(task.cwd ?? process.cwd()),
      }
      const results: TaskVerificationResult[] = []

      for (const check of step.verification) {
        results.push(...await runCheck(check, now, verificationContext))
      }

      const passedCount = results.filter(r => r.passed).length
      const overallPassed = passedCount === results.length

      // Write results back to step if requested
      if (writeBack) {
        updateTaskStep(taskId, stepId, { verificationResults: results })
      }

      // Build output text
      const lines = [
        `Verification for ${taskId} ${stepId}: ${passedCount}/${results.length} passed`,
      ]
      for (const r of results) {
        const icon = r.passed ? '✓' : '✗'
        lines.push(`${icon} ${r.checkId}: ${r.detail ?? (r.passed ? 'passed' : 'failed')}`)
      }

      // Unsatisfiable checks can never pass as authored — re-running TaskVerify
      // is futile. Surface that plainly AND tag a failureCategory so the loop
      // guard's same-class counter stops a model that keeps re-verifying a
      // broken spec (2026-06-13 kimi-code dogfood: a placeholder-path / missing
      // root+glob check was re-run 3-6× because TaskVerify always reported
      // isError:false with no failure signal).
      const unsatisfiable = results.filter(r => r.unsatisfiable)
      const runVerdictBlocked = results.filter(r =>
        (r.metadata as Record<string, unknown> | undefined)?.['runVerdictGate']
        && ((r.metadata as Record<string, unknown>)['runVerdictGate'] as Record<string, unknown>)['status'] === 'blocked',
      )
      const repairCheckpoint = buildRepairCheckpoint(taskId, stepId, results, runVerdictBlocked)
      const metadata: Record<string, unknown> = {
        taskId,
        stepId,
        passed: overallPassed,
        results,
        writeBack,
        cwd: verificationContext.cwd,
        ...(repairCheckpoint ? { repairCheckpoint } : {}),
      }
      if (runVerdictBlocked.length > 0) {
        metadata['failureCategory'] = 'verify:run-verdict-blocked'
      }
      if (unsatisfiable.length > 0) {
        lines.push(
          '',
          `⚠ ${unsatisfiable.length} check(s) can never pass as written — re-running TaskVerify will not help.`,
          'Fix the step\'s verification spec via TaskUpdate({ taskId, stepId, verification: [...] }) (correct the path/fields/command), then re-verify:',
          ...unsatisfiable.map(r => `  · ${r.checkId}: ${r.detail ?? 'unsatisfiable'}`),
        )
        metadata['failureCategory'] = metadata['failureCategory'] ?? 'verify:unsatisfiable-spec'
      }
      if (repairCheckpoint) {
        lines.push(
          '',
          'Repair checkpoint:',
          `  failedCheckIds=${repairCheckpoint.failedCheckIds.join(', ') || '(none)'}`,
          `  retryableCheckIds=${repairCheckpoint.retryableCheckIds.join(', ') || '(none)'}`,
          `  unsatisfiableCheckIds=${repairCheckpoint.unsatisfiableCheckIds.join(', ') || '(none)'}`,
          `  nextAction=${repairCheckpoint.nextAction}`,
          `  reverify=${repairCheckpoint.reverifyCommand}`,
        )
        if (repairCheckpoint.taskUpdateCommand) {
          lines.push(`  updateSpec=${repairCheckpoint.taskUpdateCommand}`)
        }
      }

      return {
        output: lines.join('\n'),
        isError: false,
        metadata,
      }
    },
  }
}
