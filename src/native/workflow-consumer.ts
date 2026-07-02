import { createHash } from 'node:crypto'
import { statSync, type Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  WorkflowEndpointCallReceipt,
  WorkflowFailedStepReceipt,
  WorkflowRunReceipt,
} from './workflow-runner.js'

export type WorkflowConsumerState =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'incomplete'
  | 'recoverable'
  | 'retryable'
  | 'unsatisfiable'
  | 'fallback'
  | 'unknown'

export type WorkflowStructuredOutputStatus = 'success' | 'warning' | 'failed' | 'unknown'

export interface WorkflowConsumerDiagnostic {
  code: string
  message: string
  path?: string
  stepId?: string
  artifactId?: string
}

export interface WorkflowFinalReportBlocker extends WorkflowConsumerDiagnostic {}

export interface WorkflowRef {
  stepId?: string
  path: string
  exists: boolean
  kind: 'response_artifact' | 'artifact_ref' | 'raw_ref' | 'structured_output_artifact'
}

export interface WorkflowStructuredOutputArtifactRef {
  artifactId: string
  attemptLedgerId?: string
  role?: string | null
  status: WorkflowStructuredOutputStatus
  fallbackUsed?: boolean
  schemaValid?: boolean | null
  ok?: boolean | null
  path?: string
  ref?: string
}

export interface WorkflowEndpointCallConsumerView extends WorkflowEndpointCallReceipt {
  artifactRefs: WorkflowRef[]
  rawRefs: WorkflowRef[]
}

export interface WorkflowConsumerManifest {
  schemaVersion: 1
  kind: 'workflow_consumer_manifest'
  runId: string
  workflowRoot: string
  updatedAt?: string
  plan: {
    exists: boolean
    path?: string
    digest?: string
    version?: string
  }
  receipt: {
    exists: boolean
    path?: string
    digest?: string
    acceptance: 'pass' | 'fail' | 'unknown'
  }
  acceptance: {
    status: 'pass' | 'fail' | 'unknown'
  }
  normalizedState: WorkflowConsumerState
  requiredCounts: {
    total: number
    completed: number
    failed: number
    skipped: number
  }
  stepSummary: {
    failed: Array<{ stepId: string; required: boolean; reason?: string }>
    skipped: Array<{ stepId: string; reason?: string }>
    resumed: string[]
  }
  endpointCalls: WorkflowEndpointCallConsumerView[]
  artifactRefs: WorkflowRef[]
  rawRefs: WorkflowRef[]
  structuredOutputArtifacts: WorkflowStructuredOutputArtifactRef[]
  resume: {
    possible: boolean
    command?: string
    previousRunId?: string
    resumedStepIds: string[]
  }
  finalReportEligibility: {
    allowed: boolean
    blockers: WorkflowFinalReportBlocker[]
  }
  diagnostics: WorkflowConsumerDiagnostic[]
}

export interface WorkflowRunListResult {
  schemaVersion: 1
  workflowRoot: string
  count: number
  runs: WorkflowConsumerManifest[]
}

export interface WorkflowRunReadOptions {
  cwd?: string
  workflowRoot?: string
  runId: string
}

export interface WorkflowRunListOptions {
  cwd?: string
  workflowRoot?: string
  limit?: number
}

interface ReceiptCandidate {
  path: string
  runId: string
  updatedAtMs: number
  updatedAt?: string
}

interface ParsedJson {
  value?: unknown
  raw?: string
  digest?: string
  error?: string
}

export class WorkflowRunNotFoundError extends Error {
  readonly runId: string
  readonly workflowRoot: string

  constructor(runId: string, workflowRoot: string) {
    super(`Workflow run not found: ${runId}`)
    this.name = 'WorkflowRunNotFoundError'
    this.runId = runId
    this.workflowRoot = workflowRoot
  }
}

export async function listWorkflowRuns(options: WorkflowRunListOptions = {}): Promise<WorkflowRunListResult> {
  const workflowRoot = resolveWorkflowRoot(options)
  const candidates = await findReceiptCandidates(workflowRoot)
  const manifests = await Promise.all(candidates.map(candidate =>
    buildManifestFromCandidate({ workflowRoot, candidate, cwd: options.cwd }),
  ))
  manifests.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : undefined
  const runs = limit ? manifests.slice(0, limit) : manifests
  return {
    schemaVersion: 1,
    workflowRoot,
    count: runs.length,
    runs,
  }
}

export async function buildWorkflowConsumerManifest(options: WorkflowRunReadOptions): Promise<WorkflowConsumerManifest> {
  const workflowRoot = resolveWorkflowRoot(options)
  const candidates = await findReceiptCandidates(workflowRoot)
  const candidate = candidates.find(item => item.runId === options.runId)
  if (!candidate) throw new WorkflowRunNotFoundError(options.runId, workflowRoot)
  return buildManifestFromCandidate({ workflowRoot, candidate, cwd: options.cwd })
}

function resolveWorkflowRoot(options: { cwd?: string; workflowRoot?: string }): string {
  const cwd = options.cwd && options.cwd.trim() ? resolve(options.cwd) : process.cwd()
  if (options.workflowRoot && options.workflowRoot.trim()) {
    return isAbsolute(options.workflowRoot) ? resolve(options.workflowRoot) : resolve(cwd, options.workflowRoot)
  }
  return join(cwd, '.owlcoda-workflows')
}

async function findReceiptCandidates(workflowRoot: string): Promise<ReceiptCandidate[]> {
  const files = await walkFiles(workflowRoot)
  const receipts = files.filter(path => {
    const name = basename(path)
    return name === 'receipt.json' || name.endsWith('-receipt.json')
  })
  const candidates = await Promise.all(receipts.map(async path => {
    const observed = await statOrNull(path)
    return {
      path,
      runId: runIdFromReceiptPath(path),
      updatedAtMs: observed?.mtimeMs ?? 0,
      ...(observed?.mtime ? { updatedAt: observed.mtime.toISOString() } : {}),
    }
  }))
  const deduped = new Map<string, ReceiptCandidate>()
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.runId)
    if (!existing || candidate.updatedAtMs > existing.updatedAtMs) {
      deduped.set(candidate.runId, candidate)
    }
  }
  return [...deduped.values()]
}

async function walkFiles(root: string): Promise<string[]> {
  const observed = await statOrNull(root)
  if (!observed?.isDirectory()) return []
  const out: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...await walkFiles(path))
    } else if (entry.isFile()) {
      out.push(path)
    }
  }
  return out
}

async function buildManifestFromCandidate(args: {
  workflowRoot: string
  candidate: ReceiptCandidate
  cwd?: string
}): Promise<WorkflowConsumerManifest> {
  const diagnostics: WorkflowConsumerDiagnostic[] = []
  const receiptJson = await readJson(args.candidate.path)
  if (receiptJson.error) {
    diagnostics.push({
      code: 'receipt_parse_failed',
      message: receiptJson.error,
      path: args.candidate.path,
    })
    return emptyManifest({
      workflowRoot: args.workflowRoot,
      runId: args.candidate.runId,
      receiptPath: args.candidate.path,
      receiptDigest: receiptJson.digest,
      updatedAt: args.candidate.updatedAt,
      diagnostics,
    })
  }

  const receipt = isRecord(receiptJson.value) ? receiptJson.value as unknown as Partial<WorkflowRunReceipt> : undefined
  if (!receipt) {
    diagnostics.push({
      code: 'receipt_not_object',
      message: 'Workflow receipt is not a JSON object',
      path: args.candidate.path,
    })
    return emptyManifest({
      workflowRoot: args.workflowRoot,
      runId: args.candidate.runId,
      receiptPath: args.candidate.path,
      receiptDigest: receiptJson.digest,
      updatedAt: args.candidate.updatedAt,
      diagnostics,
    })
  }

  const runId = typeof receipt.run_id === 'string' && receipt.run_id.trim()
    ? receipt.run_id.trim()
    : args.candidate.runId
  const receiptPath = typeof receipt.receipt_path === 'string' && receipt.receipt_path.trim()
    ? resolveFrom(args.workflowRoot, receipt.receipt_path)
    : args.candidate.path
  const artifactDir = typeof receipt.artifact_dir === 'string' && receipt.artifact_dir.trim()
    ? resolveFrom(dirname(receiptPath), receipt.artifact_dir)
    : join(dirname(receiptPath), `${runId}-artifacts`)
  const planPath = typeof receipt.plan_path === 'string' && receipt.plan_path.trim()
    ? resolveFrom(dirname(receiptPath), receipt.plan_path)
    : join(dirname(receiptPath), 'plan.json')
  const planJson = await readJson(planPath)
  if (planJson.error) {
    diagnostics.push({
      code: 'plan_read_failed',
      message: planJson.error,
      path: planPath,
    })
  }

  const plan = isRecord(planJson.value) ? planJson.value : undefined
  const failedSteps = normalizeFailedSteps(receipt.failed_steps)
  const skippedSteps = normalizeSkippedSteps(receipt.skipped_steps)
  for (const step of skippedSteps) {
    if (!step.reason) {
      diagnostics.push({
        code: 'skipped_step_missing_reason',
        message: `Skipped workflow step ${step.stepId} is missing a reason`,
        stepId: step.stepId,
      })
    }
  }

  const endpointCalls = normalizeEndpointCalls(receipt.endpoint_calls, diagnostics)
  const artifactRefs = uniqueRefs(endpointCalls.flatMap(call => call.artifactRefs))
  const rawRefs = uniqueRefs(endpointCalls.flatMap(call => call.rawRefs))
  const structuredOutputArtifacts = await collectStructuredOutputArtifacts({
    artifactDir,
    endpointCalls,
  })
  const requiredCounts = {
    total: numberOrZero(receipt.required_steps_total),
    completed: numberOrZero(receipt.required_steps_completed),
    failed: failedSteps.filter(step => step.required).length,
    skipped: skippedSteps.length,
  }
  const acceptance = normalizeAcceptance(receipt.acceptance)
  const resumedStepIds = isRecord(receipt.resume) && Array.isArray(receipt.resume.resumed_step_ids)
    ? receipt.resume.resumed_step_ids.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  const manifestWithoutGate: Omit<WorkflowConsumerManifest, 'finalReportEligibility' | 'normalizedState'> = {
    schemaVersion: 1,
    kind: 'workflow_consumer_manifest',
    runId,
    workflowRoot: args.workflowRoot,
    updatedAt: stringField(receipt.finished_at) ?? args.candidate.updatedAt,
    plan: {
      exists: !planJson.error,
      path: planPath,
      ...(planJson.digest ? { digest: planJson.digest } : {}),
      ...(stringField(plan?.['plan_version']) ?? stringField(receipt.plan_version)
        ? { version: stringField(plan?.['plan_version']) ?? stringField(receipt.plan_version) }
        : {}),
    },
    receipt: {
      exists: true,
      path: receiptPath,
      ...(receiptJson.digest ? { digest: receiptJson.digest } : {}),
      acceptance,
    },
    acceptance: {
      status: acceptance,
    },
    requiredCounts,
    stepSummary: {
      failed: failedSteps,
      skipped: skippedSteps,
      resumed: resumedStepIds,
    },
    endpointCalls,
    artifactRefs,
    rawRefs,
    structuredOutputArtifacts,
    resume: {
      possible: !planJson.error,
      ...(planJson.error ? {} : { command: `owlcoda workflow resume --run-id ${runId}` }),
      ...(isRecord(receipt.resume) && typeof receipt.resume.previous_run_id === 'string'
        ? { previousRunId: receipt.resume.previous_run_id }
        : {}),
      resumedStepIds,
    },
    diagnostics,
  }
  const finalReportEligibility = evaluateWorkflowFinalReportEligibility(manifestWithoutGate)
  return {
    ...manifestWithoutGate,
    normalizedState: normalizeConsumerState(manifestWithoutGate, finalReportEligibility),
    finalReportEligibility,
  }
}

function emptyManifest(args: {
  workflowRoot: string
  runId: string
  receiptPath?: string
  receiptDigest?: string
  updatedAt?: string
  diagnostics: WorkflowConsumerDiagnostic[]
}): WorkflowConsumerManifest {
  const manifestWithoutGate: Omit<WorkflowConsumerManifest, 'finalReportEligibility' | 'normalizedState'> = {
    schemaVersion: 1,
    kind: 'workflow_consumer_manifest',
    runId: args.runId,
    workflowRoot: args.workflowRoot,
    updatedAt: args.updatedAt,
    plan: { exists: false },
    receipt: {
      exists: Boolean(args.receiptPath),
      ...(args.receiptPath ? { path: args.receiptPath } : {}),
      ...(args.receiptDigest ? { digest: args.receiptDigest } : {}),
      acceptance: 'unknown',
    },
    acceptance: { status: 'unknown' },
    requiredCounts: { total: 0, completed: 0, failed: 0, skipped: 0 },
    stepSummary: { failed: [], skipped: [], resumed: [] },
    endpointCalls: [],
    artifactRefs: [],
    rawRefs: [],
    structuredOutputArtifacts: [],
    resume: { possible: false, resumedStepIds: [] },
    diagnostics: args.diagnostics,
  }
  const finalReportEligibility = evaluateWorkflowFinalReportEligibility(manifestWithoutGate)
  return {
    ...manifestWithoutGate,
    normalizedState: 'unknown',
    finalReportEligibility,
  }
}

export function evaluateWorkflowFinalReportEligibility(
  manifest: Omit<WorkflowConsumerManifest, 'finalReportEligibility' | 'normalizedState'>,
): WorkflowConsumerManifest['finalReportEligibility'] {
  const blockers: WorkflowFinalReportBlocker[] = []
  if (!manifest.receipt.exists) {
    blockers.push({ code: 'missing_required_receipt', message: 'Workflow receipt is missing' })
  }
  if (manifest.receipt.exists && manifest.receipt.acceptance === 'fail') {
    blockers.push({ code: 'receipt_acceptance_failed', message: 'Workflow receipt acceptance is fail' })
  }
  if (manifest.receipt.exists && manifest.receipt.acceptance === 'unknown') {
    blockers.push({ code: 'receipt_acceptance_unknown', message: 'Workflow receipt acceptance is unknown' })
  }
  for (const step of manifest.stepSummary.failed) {
    if (step.required) {
      blockers.push({
        code: 'required_step_failed',
        message: step.reason ? `Required workflow step failed: ${step.reason}` : 'Required workflow step failed',
        stepId: step.stepId,
      })
    }
  }
  for (const step of manifest.stepSummary.skipped) {
    if (!step.reason) {
      blockers.push({
        code: 'skipped_step_missing_reason',
        message: 'Skipped workflow step is missing a reason',
        stepId: step.stepId,
      })
    }
  }
  for (const ref of [...manifest.artifactRefs, ...manifest.rawRefs]) {
    if (!ref.exists) {
      blockers.push({
        code: 'missing_required_artifact',
        message: `Workflow artifact reference is missing: ${ref.path}`,
        path: ref.path,
        stepId: ref.stepId,
      })
    }
  }
  for (const artifact of manifest.structuredOutputArtifacts) {
    if (artifact.status === 'failed' || artifact.fallbackUsed === true || artifact.schemaValid === false || artifact.ok === false) {
      blockers.push({
        code: 'failed_fallback_structured_output',
        message: `Structured-output artifact is not a successful final artifact: ${artifact.artifactId}`,
        artifactId: artifact.artifactId,
        path: artifact.path,
      })
    }
  }
  return {
    allowed: blockers.length === 0,
    blockers,
  }
}

function normalizeConsumerState(
  manifest: Omit<WorkflowConsumerManifest, 'finalReportEligibility' | 'normalizedState'>,
  gate: WorkflowConsumerManifest['finalReportEligibility'],
): WorkflowConsumerState {
  if (!manifest.receipt.exists || manifest.receipt.acceptance === 'unknown') return 'unknown'
  if (manifest.acceptance.status === 'fail' || manifest.stepSummary.failed.some(step => step.required)) return 'failed'
  if (manifest.structuredOutputArtifacts.some(artifact => artifact.status === 'failed' || artifact.fallbackUsed === true)) return 'fallback'
  if (gate.blockers.some(blocker => blocker.code === 'missing_required_artifact')) return 'incomplete'
  if (manifest.stepSummary.skipped.length > 0) return 'skipped'
  return gate.allowed ? 'completed' : 'unknown'
}

function normalizeFailedSteps(value: unknown): WorkflowConsumerManifest['stepSummary']['failed'] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((step): { stepId: string; required: boolean; reason?: string } => ({
    stepId: stringField(step['step_id']) ?? 'unknown_step',
    required: step['required'] !== false,
    ...(stringField(step['reason']) ? { reason: stringField(step['reason']) } : {}),
  }))
}

function normalizeSkippedSteps(value: unknown): WorkflowConsumerManifest['stepSummary']['skipped'] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((step): { stepId: string; reason?: string } => ({
    stepId: stringField(step['step_id']) ?? 'unknown_step',
    ...(stringField(step['reason']) ? { reason: stringField(step['reason']) } : {}),
  }))
}

function normalizeEndpointCalls(value: unknown, diagnostics: WorkflowConsumerDiagnostic[]): WorkflowEndpointCallConsumerView[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((call): WorkflowEndpointCallConsumerView => {
    const stepId = stringField(call['step_id']) ?? 'unknown_step'
    const responseArtifact = stringField(call['response_artifact'])
    const rawRef = stringField(call['raw_ref'])
    const artifactRef = stringField(call['artifact_ref'])
    const artifactRefs = uniqueRefs([
      ...(responseArtifact ? [refFor(stepId, responseArtifact, 'response_artifact')] : []),
      ...(artifactRef ? [refFor(stepId, artifactRef, 'artifact_ref')] : []),
    ])
    const rawRefs = uniqueRefs([
      ...(rawRef ? [refFor(stepId, rawRef, 'raw_ref')] : []),
      ...(responseArtifact ? [refFor(stepId, responseArtifact, 'response_artifact')] : []),
    ])
    if (call['response_truncated'] === true && artifactRefs.length === 0 && rawRefs.length === 0) {
      diagnostics.push({
        code: 'truncated_response_without_ref',
        message: 'Workflow endpoint call was truncated without an artifact/raw ref',
        stepId,
      })
    }
    return {
      ...(call as unknown as WorkflowEndpointCallReceipt),
      step_id: stepId,
      artifactRefs,
      rawRefs,
    }
  })
}

function refFor(stepId: string, path: string, kind: WorkflowRef['kind']): WorkflowRef {
  return {
    stepId,
    path,
    exists: false,
    kind,
  }
}

function uniqueRefs(refs: WorkflowRef[]): WorkflowRef[] {
  const byKey = new Map<string, WorkflowRef>()
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.stepId ?? ''}:${ref.path}`
    if (!byKey.has(key)) byKey.set(key, ref)
  }
  const values = [...byKey.values()]
  for (const ref of values) {
    ref.exists = false
  }
  values.forEach(ref => {
    void statOrNull(ref.path).then(observed => {
      ref.exists = Boolean(observed)
    })
  })
  return values.map(ref => ({
    ...ref,
    exists: requireExistsSync(ref.path),
  }))
}

async function collectStructuredOutputArtifacts(args: {
  artifactDir: string
  endpointCalls: WorkflowEndpointCallConsumerView[]
}): Promise<WorkflowStructuredOutputArtifactRef[]> {
  const files = await walkFiles(args.artifactDir)
  const artifactFiles = files.filter(path => basename(path).startsWith('structured-output') && path.endsWith('.json'))
  const fromFiles: WorkflowStructuredOutputArtifactRef[] = []
  for (const path of artifactFiles) {
    const parsed = await readJson(path)
    if (!isRecord(parsed.value)) continue
    if (parsed.value['artifactKind'] !== 'structured_output_artifact') continue
    const artifactId = basename(path).replace(/\.json$/u, '')
    fromFiles.push({
      artifactId,
      role: nullableStringField(parsed.value['role']),
      status: structuredOutputStatus(parsed.value),
      fallbackUsed: booleanField(parsed.value['fallbackUsed']),
      schemaValid: nullableBooleanField(parsed.value['schemaValid']),
      ok: nullableBooleanField(parsed.value['ok']),
      path,
      ref: path,
    })
  }

  const byId = new Map(fromFiles.map(item => [item.artifactId, item]))
  for (const call of args.endpointCalls) {
    const projected = isRecord(call.projected_response) ? call.projected_response : undefined
    const artifactId = stringField(projected?.['artifactId'])
    if (!projected || !artifactId) continue
    const existing = byId.get(artifactId)
    byId.set(artifactId, {
      artifactId,
      ...(stringField(projected?.['attemptLedgerId']) ? { attemptLedgerId: stringField(projected?.['attemptLedgerId']) } : {}),
      status: existing?.status ?? structuredOutputStatus(projected),
      fallbackUsed: existing?.fallbackUsed ?? booleanField(projected?.['fallbackUsed']),
      schemaValid: existing?.schemaValid ?? nullableBooleanField(projected?.['schemaValid']),
      ok: existing?.ok ?? nullableBooleanField(projected?.['ok']),
      ...(existing?.role !== undefined ? { role: existing.role } : {}),
      ...(existing?.path ? { path: existing.path, ref: existing.ref ?? existing.path } : {}),
    })
  }
  return [...byId.values()]
}

function structuredOutputStatus(payload: Record<string, unknown>): WorkflowStructuredOutputStatus {
  const artifact = isRecord(payload['artifact']) ? payload['artifact'] : undefined
  if (
    payload['fallbackUsed'] === true
    || payload['ok'] === false
    || payload['schemaValid'] === false
    || artifact?.['artifact'] === 'failed_fallback.v1'
  ) {
    return 'failed'
  }
  if (payload['salvageUsed'] === true || numberOrZero(payload['repairCount']) > 0) return 'warning'
  if (payload['ok'] === true || payload['schemaValid'] === true) return 'success'
  return 'unknown'
}

async function readJson(path: string): Promise<ParsedJson> {
  try {
    const raw = await readFile(path, 'utf8')
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`
    try {
      return { raw, digest, value: JSON.parse(raw) }
    } catch (err) {
      return { raw, digest, error: err instanceof Error ? err.message : String(err) }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function runIdFromReceiptPath(path: string): string {
  const name = basename(path)
  if (name.endsWith('-receipt.json')) return name.replace(/-receipt\.json$/u, '')
  const parent = basename(dirname(path))
  if (parent.endsWith('-artifacts')) return parent.replace(/-artifacts$/u, '')
  return parent || 'unknown-run'
}

function normalizeAcceptance(value: unknown): 'pass' | 'fail' | 'unknown' {
  return value === 'pass' || value === 'fail' ? value : 'unknown'
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

function requireExistsSync(path: string): boolean {
  try {
    return Boolean(statSync(path))
  } catch {
    return false
  }
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function nullableBooleanField(value: unknown): boolean | null | undefined {
  return value === null ? null : booleanField(value)
}

function nullableStringField(value: unknown): string | null | undefined {
  return value === null ? null : stringField(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
