export interface SwebenchRunRecord {
  instance_id: string
  repo: string
  workspace: string
  exit_code: number | null
  parse_ok: boolean
  approval_denials: unknown[]
  patch_bytes: number
  patch_path: string
  stdout_path: string
  stderr_path: string
  interactive_prompt_detected: boolean
  timed_out: boolean
  post_patch_timeout: boolean
  duration_ms: number
  session_id?: string
  error?: string
  infra_attempt?: number
  runtime_failure_kind?: string
  runtime_failure_status?: number
  runtime_failure_message?: string
  runtime_failure_detail?: string
  provider_failure?: boolean
  provider_quota_exhausted?: boolean
  task_no_progress?: boolean
  task_no_progress_recovery_attempted?: boolean
  task_no_progress_recovered?: boolean
  timeout_empty_stdout?: boolean
  post_patch_timeout_preserved_patch?: boolean
  port_collision?: boolean
  score_eligible?: boolean
}

export interface SwebenchRunDiagnostics {
  runtime_failure_kind?: string
  runtime_failure_status?: number
  runtime_failure_message?: string
  runtime_failure_detail?: string
  provider_failure?: boolean
  provider_quota_exhausted?: boolean
  task_no_progress?: boolean
  port_collision?: boolean
}

export function diagnoseSwebenchRun(finalJsonValue: unknown, fallbackText = ''): SwebenchRunDiagnostics {
  const root = asRecord(finalJsonValue)
  const runtimeFailure = asRecord(root?.['runtime_failure'])
  const diagnostic = asRecord(runtimeFailure?.['diagnostic'])
  const status = numberField(diagnostic, 'status') ?? numberField(runtimeFailure, 'status')
  const kind = stringField(runtimeFailure, 'kind') ?? stringField(diagnostic, 'kind')
  const message = stringField(runtimeFailure, 'message') ?? stringField(diagnostic, 'message')
  const detail = stringField(diagnostic, 'detail') ?? stringField(runtimeFailure, 'detail')
  const searchable = [kind, message, detail, fallbackText].filter(Boolean).join('\n')
  const providerFailure = Boolean(runtimeFailure)
  const quotaExhausted = providerFailure && status === 403 && /\b(usage limit|quota|billing cycle)\b/i.test(searchable)
  const stopReason = stringField(root, 'stop_reason')
  const taskNoProgress = stopReason === 'task_no_progress' || /\btask_no_progress\b/i.test(searchable)
  const portCollision = /\b(EADDRINUSE|address already in use|Port \d+ is already in use)\b/i.test(searchable)

  return {
    runtime_failure_kind: kind,
    runtime_failure_status: status,
    runtime_failure_message: message,
    runtime_failure_detail: detail,
    provider_failure: providerFailure || undefined,
    provider_quota_exhausted: quotaExhausted || undefined,
    task_no_progress: taskNoProgress || undefined,
    port_collision: portCollision || undefined,
  }
}

export function shouldWriteSwebenchPrediction(record: SwebenchRunRecord): boolean {
  if (record.patch_bytes > 0) return true
  return false
}

export function isPostPatchTimeoutPreservedPatch(record: SwebenchRunRecord): boolean {
  if (record.post_patch_timeout_preserved_patch) return true
  return record.post_patch_timeout &&
    record.patch_bytes > 0 &&
    !record.parse_ok &&
    /\bstdout was empty\b/i.test(record.error ?? '')
}

export function summarizeSwebenchRecords(
  rows: SwebenchRunRecord[],
  expected: number,
  label: string,
): Record<string, unknown> {
  const scoreEligibleRows = rows.filter(shouldWriteSwebenchPrediction)
  return {
    label,
    expected,
    completed: rows.length,
    scoreEligiblePredictions: scoreEligibleRows.length,
    parseFailures: rows.filter((r) => !r.parse_ok && !isPostPatchTimeoutPreservedPatch(r)).length,
    emptyPatches: rows.filter((r) => r.patch_bytes === 0).length,
    unscoredEmptyPatches: rows.filter((r) => r.patch_bytes === 0 && !shouldWriteSwebenchPrediction(r)).length,
    providerFailures: rows.filter((r) => r.provider_failure).length,
    providerQuotaFailures: rows.filter((r) => r.provider_quota_exhausted).length,
    taskNoProgressStops: rows.filter((r) => r.task_no_progress).length,
    taskNoProgressRecoveryAttempts: rows.filter((r) => r.task_no_progress_recovery_attempted).length,
    taskNoProgressRecovered: rows.filter((r) => r.task_no_progress_recovered).length,
    timeoutEmptyStdout: rows.filter((r) => r.timeout_empty_stdout).length,
    postPatchTimeoutPreservedPatches: rows.filter(isPostPatchTimeoutPreservedPatch).length,
    portCollisions: rows.filter((r) => r.port_collision).length,
    instancesWithApprovalDenials: rows.filter((r) => r.approval_denials.length > 0).length,
    interactivePromptDetections: rows.filter((r) => r.interactive_prompt_detected).length,
    timeouts: rows.filter((r) => r.timed_out).length,
    postPatchTimeouts: rows.filter((r) => r.post_patch_timeout).length,
    totalDurationMs: rows.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0),
    avgDurationMs: rows.length > 0 ? Math.round(rows.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / rows.length) : 0,
    totalPatchBytes: rows.reduce((sum, r) => sum + r.patch_bytes, 0),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = value?.[key]
  return typeof raw === 'string' && raw.trim() ? raw : undefined
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = value?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
