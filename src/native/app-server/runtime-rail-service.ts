import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'

export type RunKitRailFreshness = 'missing' | 'fresh' | 'error'

export interface RuntimeRailReadInput {
  projectId: string
  projectRoot?: string
}

export interface RunKitInspectSummary {
  schemaVersion: 'OwlCodaRunKitInspectSummaryV1'
  currentExecution: {
    state: string
    selectedRunId: string | null
    activeRunIds: string[]
    openCount: number
  }
  latestIndexedCloseout: {
    runId: string
    decision: string
    trustLevel: string
  } | null
  source: {
    status: string
    sourceFingerprint: string | null
  }
  leases: {
    activeCount: number
    holders: Array<{
      runId: string
      workItemId: string
    }>
  }
  evidence: {
    status: string
    decision: string | null
    activeReceiptSha256: string | null
    trustLevel: string
  }
  resourcePreflight: {
    status: string
    preflightId: string | null
    sequence: number | null
    evaluatedAt: string | null
    validUntil: string | null
    decision: string | null
    nextAllowedAction: string | null
    blockers: string[]
    warnings: string[]
    receiptReuse: {
      reusableCount: number
      appliedCount: number
    }
    estimate: {
      calls: number
      inputTokens: number
      outputTokens: number
      totalTokens: number
      elapsedMs: number
      cost:
        | { status: 'known'; valueUsd: number }
        | { status: 'unknown'; knownSubtotalUsd: number; unknownResources: string[] }
    }
    resources: Array<{
      providerId: string
      modelId: string
      availability: { status: string; reason?: string }
      quota: {
        remainingCalls: RunKitTypedResourceValue<number>
        remainingTokens: RunKitTypedResourceValue<number>
        resetAt: RunKitTypedResourceValue<string>
      }
      demand: {
        calls: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        elapsedMs: number
      }
    }>
  }
  dominantGap: {
    code: string
    reasons: string[]
  }
  nextAllowedAction: string
  authorizationGranted: false
  gitAuthorization: false
  releaseAuthorization: false
}

type RunKitTypedResourceValue<T> =
  | { status: 'known'; value: T }
  | { status: 'unknown'; reason: string }

export type RunKitExecutionRailState =
  | 'active'
  | 'accepted'
  | 'blocked_or_rejected'
  | 'archived_historical'

export interface RunKitExecutionRailSummary {
  runId: string
  state: RunKitExecutionRailState
  decision: 'accepted' | 'blocked' | 'rejected' | null
  trustLevel: string
  nextAllowedAction: string
  authorizationGranted: false
}

export interface RunKitRailState {
  projectId: string
  freshness: RunKitRailFreshness
  summary: RunKitInspectSummary | null
  executionHistory: RunKitExecutionRailSummary[]
  source: 'not_connected' | 'owlcoda_runkit_inspect_summary' | 'owlcoda_runkit_error'
  error?: string
  repairAction?: string
}

interface RunKitCoreModule {
  runCli(argv: string[]): Promise<unknown>
}

let coreModulePromise: Promise<RunKitCoreModule> | null = null

export async function readRuntimeRail(input: string | RuntimeRailReadInput): Promise<RunKitRailState> {
  const projectId = typeof input === 'string' ? input : input.projectId
  const projectRoot = typeof input === 'string' ? undefined : input.projectRoot
  if (!projectRoot) return missingRail(projectId)

  try {
    if (!hasProjectRunKit(projectRoot)) return missingRail(projectId)
    const { runCli } = await loadRunKitCore()
    const inspected = await runCli(['inspect', '--json', '--workspace', projectRoot])
    return projectRunKitInspectResult(projectId, inspected)
  } catch (error) {
    return errorRail(
      projectId,
      null,
      error instanceof Error ? error.message : 'RunKit Core inspect failed.',
    )
  }
}

function hasProjectRunKit(projectRoot: string): boolean {
  const projectControlRoot = resolve(projectRoot, '.owlcoda')
  try {
    const controlStat = lstatSync(projectControlRoot)
    if (controlStat.isSymbolicLink() || !controlStat.isDirectory()) return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
  try {
    lstatSync(resolve(projectControlRoot, 'runkit'))
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function loadRunKitCore(): Promise<RunKitCoreModule> {
  const coreModuleUrl = new URL('../../../scripts/runkit-contract/runkit-cli.mjs', import.meta.url).href
  coreModulePromise ??= import(coreModuleUrl) as Promise<RunKitCoreModule>
  return coreModulePromise
}

function missingRail(projectId: string): RunKitRailState {
  return {
    projectId,
    freshness: 'missing',
    summary: null,
    executionHistory: [],
    source: 'not_connected',
  }
}

function errorRail(
  projectId: string,
  summary: RunKitInspectSummary | null,
  error: string,
  executionHistory: RunKitExecutionRailSummary[] = [],
): RunKitRailState {
  return {
    projectId,
    freshness: 'error',
    summary,
    executionHistory,
    source: 'owlcoda_runkit_error',
    error,
    repairAction: summary?.nextAllowedAction ?? 'repair_execution_artifacts',
  }
}

export function projectRunKitInspectResult(projectId: string, value: unknown): RunKitRailState {
  if (!isRecord(value) || value['status'] !== 'inspected') {
    return errorRail(projectId, null, 'RunKit Core returned an invalid inspect result.')
  }
  const summary = parseRunKitInspectSummary(value['summary'])
  if (!summary) {
    return errorRail(projectId, null, 'RunKit Core returned an invalid inspect summary.')
  }
  const executionHistory = parseExecutionHistory(value['executions'])
  if (!executionHistory) {
    return errorRail(projectId, summary, 'RunKit Core returned an invalid execution history.')
  }
  if (value['exitCode'] !== 0) {
    return errorRail(projectId, summary, errorFromInspectSummary(summary, value['exitCode']), executionHistory)
  }
  return {
    projectId,
    freshness: 'fresh',
    summary,
    executionHistory,
    source: 'owlcoda_runkit_inspect_summary',
  }
}

function errorFromInspectSummary(summary: RunKitInspectSummary, rawExitCode: unknown): string {
  if (summary.dominantGap.reasons.length > 0) {
    return [...new Set(summary.dominantGap.reasons)].join(' | ')
  }
  const exitCode = typeof rawExitCode === 'number' ? rawExitCode : 'unknown'
  return `RunKit Core inspect failed closed with exit code ${exitCode}.`
}

export function parseRunKitInspectSummary(value: unknown): RunKitInspectSummary | null {
  if (!isRecord(value) || value['schemaVersion'] !== 'OwlCodaRunKitInspectSummaryV1') return null
  const currentExecution = value['currentExecution']
  const latestIndexedCloseout = value['latestIndexedCloseout']
  const source = value['source']
  const leases = value['leases']
  const evidence = value['evidence']
  const resourcePreflight = value['resourcePreflight']
  const dominantGap = value['dominantGap']
  if (!isRecord(currentExecution)
    || !isNullableString(currentExecution['selectedRunId'])
    || !isStringArray(currentExecution['activeRunIds'])
    || typeof currentExecution['state'] !== 'string'
    || !isNonNegativeInteger(currentExecution['openCount'])
    || !isCloseoutSummary(latestIndexedCloseout)
    || !isRecord(source)
    || typeof source['status'] !== 'string'
    || !isNullableString(source['sourceFingerprint'])
    || !isRecord(leases)
    || !isNonNegativeInteger(leases['activeCount'])
    || !isLeaseHolders(leases['holders'])
    || !isRecord(evidence)
    || typeof evidence['status'] !== 'string'
    || !isNullableString(evidence['decision'])
    || !isNullableString(evidence['activeReceiptSha256'])
    || typeof evidence['trustLevel'] !== 'string'
    || !isResourcePreflightSummary(resourcePreflight)
    || !isRecord(dominantGap)
    || typeof dominantGap['code'] !== 'string'
    || !isStringArray(dominantGap['reasons'])
    || typeof value['nextAllowedAction'] !== 'string'
    || value['authorizationGranted'] !== false
    || value['gitAuthorization'] !== false
    || value['releaseAuthorization'] !== false) {
    return null
  }
  return value as unknown as RunKitInspectSummary
}

function parseExecutionHistory(value: unknown): RunKitExecutionRailSummary[] | null {
  if (!Array.isArray(value)) return null
  const history: RunKitExecutionRailSummary[] = []
  const runIds = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate)
      || !isSafeRunId(candidate['runId'])
      || runIds.has(candidate['runId'] as string)
      || (candidate['lifecycle'] !== 'active' && candidate['lifecycle'] !== 'closed')
      || typeof candidate['historical'] !== 'boolean'
      || !isRecord(candidate['recovery'])
      || !isEvidenceTrustLevel(candidate['recovery']['evidenceTrustLevel'])
      || !isAction(candidate['recovery']['nextAllowedAction'])) {
      return null
    }
    const runId = candidate['runId'] as string
    const trustLevel = candidate['recovery']['evidenceTrustLevel'] as string
    const nextAllowedAction = candidate['recovery']['nextAllowedAction'] as string
    if (candidate['lifecycle'] === 'active') {
      if (trustLevel === 'closed_accepted' || trustLevel === 'closed_nonaccepted') return null
      history.push({
        runId,
        state: 'active',
        decision: null,
        trustLevel,
        nextAllowedAction,
        authorizationGranted: false,
      })
      runIds.add(runId)
      continue
    }
    const closeout = candidate['closeout']
    if (!isRecord(closeout)
      || closeout['status'] !== 'valid'
      || !isCloseoutDecision(closeout['decision'])
      || closeout['authorizationGranted'] !== false) {
      return null
    }
    const decision = closeout['decision']
    if ((decision === 'accepted') !== (trustLevel === 'closed_accepted')
      || (decision !== 'accepted') !== (trustLevel === 'closed_nonaccepted')) {
      return null
    }
    history.push({
      runId,
      state: candidate['historical']
        ? 'archived_historical'
        : decision === 'accepted'
          ? 'accepted'
          : 'blocked_or_rejected',
      decision,
      trustLevel,
      nextAllowedAction,
      authorizationGranted: false,
    })
    runIds.add(runId)
  }
  return history
}

function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function isEvidenceTrustLevel(value: unknown): value is string {
  return typeof value === 'string' && new Set([
    'invalid',
    'planned',
    'work_in_progress',
    'delivery_fresh',
    'verification_passed',
    'closed_accepted',
    'closed_nonaccepted',
  ]).has(value)
}

function isAction(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)
}

function isCloseoutDecision(value: unknown): value is 'accepted' | 'blocked' | 'rejected' {
  return value === 'accepted' || value === 'blocked' || value === 'rejected'
}

function isResourcePreflightSummary(value: unknown): boolean {
  if (!isRecord(value)
    || !new Set(['none', 'current', 'expired', 'invalid']).has(String(value['status']))
    || !isNullableString(value['preflightId'])
    || !(value['sequence'] === null || isNonNegativeInteger(value['sequence']))
    || !isNullableString(value['evaluatedAt'])
    || !isNullableString(value['validUntil'])
    || !isNullableString(value['decision'])
    || !isNullableString(value['nextAllowedAction'])
    || !isStringArray(value['blockers'])
    || !isStringArray(value['warnings'])
    || !isRecord(value['receiptReuse'])
    || !isNonNegativeInteger(value['receiptReuse']['reusableCount'])
    || !isNonNegativeInteger(value['receiptReuse']['appliedCount'])
    || !isRecord(value['estimate'])
    || !isNonNegativeInteger(value['estimate']['calls'])
    || !isNonNegativeInteger(value['estimate']['inputTokens'])
    || !isNonNegativeInteger(value['estimate']['outputTokens'])
    || !isNonNegativeInteger(value['estimate']['totalTokens'])
    || !isNonNegativeInteger(value['estimate']['elapsedMs'])
    || !isResourceCost(value['estimate']['cost'])
    || !Array.isArray(value['resources'])
    || !value['resources'].every(isResourceSummary)) {
    return false
  }
  const selected = value['status'] === 'current' || value['status'] === 'expired'
  const estimate = value['estimate']
  if (selected !== (value['preflightId'] !== null)
    || selected !== (value['sequence'] !== null)
    || selected !== (value['evaluatedAt'] !== null)
    || selected !== (value['decision'] !== null)
    || selected !== (value['nextAllowedAction'] !== null)
    || (selected && !isPositiveInteger(value['sequence']))
    || (value['status'] === 'expired' && value['validUntil'] === null)
    || (!selected && (value['validUntil'] !== null || value['resources'].length > 0))
    || (!selected && (
      value['blockers'].length > 0
      || value['warnings'].length > 0
      || value['receiptReuse']['reusableCount'] > 0
      || value['receiptReuse']['appliedCount'] > 0
      || ['calls', 'inputTokens', 'outputTokens', 'totalTokens', 'elapsedMs']
        .some(key => estimate[key] !== 0)
    ))
    || value['receiptReuse']['appliedCount'] > value['receiptReuse']['reusableCount']) {
    return false
  }
  const decision = value['decision']
  const nextAllowedAction = value['nextAllowedAction']
  if (selected && !(
    (decision === 'ready_for_model_execution'
      && nextAllowedAction === 'begin_model_execution'
      && value['blockers'].length === 0)
    || (decision === 'ready_without_model_execution'
      && nextAllowedAction === 'continue_without_model_calls'
      && value['blockers'].length === 0)
    || (decision === 'blocked_by_resource'
      && nextAllowedAction === 'pause_at_deterministic_stage'
      && value['blockers'].length > 0)
  )) return false
  const resourceKeys = value['resources'].map(resource => {
    const item = resource as Record<string, unknown>
    return `${String(item['providerId'])}/${String(item['modelId'])}`
  })
  if (new Set(resourceKeys).size !== resourceKeys.length) return false
  const demandTotals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 }
  for (const resource of value['resources']) {
    const demand = (resource as Record<string, unknown>)['demand'] as Record<string, number>
    for (const key of Object.keys(demandTotals) as Array<keyof typeof demandTotals>) {
      demandTotals[key] += demand[key]
    }
  }
  const estimateInputTokens = estimate['inputTokens'] as number
  const estimateOutputTokens = estimate['outputTokens'] as number
  const estimateTotalTokens = estimate['totalTokens'] as number
  return estimateTotalTokens === estimateInputTokens + estimateOutputTokens
    && (!selected || Object.entries(demandTotals).every(([key, total]) => estimate[key] === total))
}

function isResourceCost(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value['status'] === 'known') {
    return typeof value['valueUsd'] === 'number' && Number.isFinite(value['valueUsd']) && value['valueUsd'] >= 0
  }
  return value['status'] === 'unknown'
    && typeof value['knownSubtotalUsd'] === 'number'
    && Number.isFinite(value['knownSubtotalUsd'])
    && value['knownSubtotalUsd'] >= 0
    && isStringArray(value['unknownResources'])
}

function isResourceSummary(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value['providerId'] !== 'string' || value['providerId'].length === 0
    || typeof value['modelId'] !== 'string' || value['modelId'].length === 0
    || !isRecord(value['availability'])
    || !new Set(['available', 'unavailable', 'unknown']).has(String(value['availability']['status']))
    || (value['availability']['status'] === 'available' && value['availability']['reason'] !== undefined)
    || (value['availability']['status'] !== 'available'
      && (typeof value['availability']['reason'] !== 'string' || value['availability']['reason'].length === 0))
    || !isRecord(value['quota'])
    || !isTypedResourceValue(value['quota']['remainingCalls'], 'number')
    || !isTypedResourceValue(value['quota']['remainingTokens'], 'number')
    || !isTypedResourceValue(value['quota']['resetAt'], 'string')
    || !isRecord(value['demand'])) {
    return false
  }
  const demand = value['demand']
  const calls = demand['calls']
  const inputTokens = demand['inputTokens']
  const outputTokens = demand['outputTokens']
  const totalTokens = demand['totalTokens']
  const elapsedMs = demand['elapsedMs']
  return isNonNegativeInteger(calls)
    && isNonNegativeInteger(inputTokens)
    && isNonNegativeInteger(outputTokens)
    && isNonNegativeInteger(totalTokens)
    && isNonNegativeInteger(elapsedMs)
    && totalTokens === inputTokens + outputTokens
}

function isTypedResourceValue(value: unknown, kind: 'number' | 'string'): boolean {
  if (!isRecord(value)) return false
  if (value['status'] === 'unknown') return typeof value['reason'] === 'string' && value['reason'].length > 0
  if (value['status'] !== 'known' || typeof value['value'] !== kind) return false
  if (kind === 'string') return (value['value'] as string).length > 0
  return Number.isInteger(value['value']) && (value['value'] as number) >= 0
}

function isCloseoutSummary(value: unknown): boolean {
  return value === null || (isRecord(value)
    && typeof value['runId'] === 'string'
    && typeof value['decision'] === 'string'
    && typeof value['trustLevel'] === 'string')
}

function isLeaseHolders(value: unknown): boolean {
  return Array.isArray(value) && value.every(holder => isRecord(holder)
    && typeof holder['runId'] === 'string'
    && typeof holder['workItemId'] === 'string')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error
}
