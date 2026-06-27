import { readFile } from 'node:fs/promises'
import type { RuntimeFactArtifactLike } from '../runtime-facts.js'
import type {
  AppServerRuntimeFactsReadResult,
  AppServerStructuredOutputArtifactItem,
  AppServerStructuredOutputArtifactsReadResult,
  AppServerStructuredOutputArtifactStatus,
  AppServerStructuredOutputAttemptItem,
  AppServerStructuredOutputRerunAction,
} from './protocol-contract.js'

export interface BuildStructuredOutputArtifactsPanelInput {
  facts: AppServerRuntimeFactsReadResult
  threadId: string
  projectId?: string
  runRef?: string
  artifactId?: string
}

interface StructuredOutputArtifactPayload {
  artifactKind?: string
  role?: string | null
  model?: string
  preset?: string
  requestFingerprint?: string | null
  schemaHash?: string | null
  policyHash?: string | null
  ok?: boolean
  artifact?: unknown
  rawText?: string
  rawThinkingText?: string | null
  parsed?: boolean
  schemaValid?: boolean
  validationErrors?: string[]
  repairCount?: number
  salvageUsed?: boolean
  fallbackUsed?: boolean
  stopReason?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  durationMs?: number | null
}

interface StructuredOutputAttemptsPayload {
  artifactKind?: string
  artifactId?: string
  attemptLedgerId?: string
  attempts?: AppServerStructuredOutputAttemptItem[]
}

export async function buildStructuredOutputArtifactsPanel(
  input: BuildStructuredOutputArtifactsPanelInput,
): Promise<AppServerStructuredOutputArtifactsReadResult> {
  const warnings: string[] = []
  const attemptRecords = input.facts.artifacts.filter(isStructuredOutputAttemptsRecord)
  const attemptPayloads = new Map<string, StructuredOutputAttemptsPayload>()
  for (const record of attemptRecords) {
    const payload = await readAttemptsPayload(record, warnings)
    if (!payload) continue
    attemptPayloads.set(record.id, payload)
  }

  const items: AppServerStructuredOutputArtifactItem[] = []
  for (const record of input.facts.artifacts.filter(isStructuredOutputArtifactRecord)) {
    if (input.artifactId && record.id !== input.artifactId && record.factRefs?.artifactId !== input.artifactId) continue
    const payload = await readArtifactPayload(record, warnings)
    if (!payload) continue
    const attemptRecord = findAttemptRecord(record, attemptRecords, attemptPayloads)
    const attemptsPayload = attemptRecord ? attemptPayloads.get(attemptRecord.id) : undefined
    items.push(toPanelItem({
      record,
      payload,
      attemptsRecord: attemptRecord,
      attemptsPayload,
      runRef: input.runRef,
    }))
  }

  return {
    schemaVersion: 1,
    surface: 'structured-output-artifacts',
    threadId: input.threadId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    runId: input.facts.runId,
    artifactCount: items.length,
    successCount: items.filter(item => item.status === 'success').length,
    failedCount: items.filter(item => item.status === 'failed').length,
    warningCount: items.filter(item => item.status === 'warning').length,
    items,
    warnings,
  }
}

function toPanelItem(input: {
  record: RuntimeFactArtifactLike
  payload: StructuredOutputArtifactPayload
  attemptsRecord?: RuntimeFactArtifactLike
  attemptsPayload?: StructuredOutputAttemptsPayload
  runRef?: string
}): AppServerStructuredOutputArtifactItem {
  const status = structuredOutputStatus(input.payload)
  const validationErrors = input.payload.validationErrors ?? []
  const attempts = input.attemptsPayload?.attempts ?? []
  const attemptLedgerId = input.attemptsRecord?.id ?? input.attemptsPayload?.attemptLedgerId
  const rerunAction = buildRerunAction({
    artifactId: input.record.id,
    payload: input.payload,
    runRef: input.runRef,
  })
  return {
    artifactId: input.record.id,
    ...(attemptLedgerId ? { attemptLedgerId } : {}),
    status,
    ok: booleanOrNull(input.payload.ok),
    parsed: booleanOrNull(input.payload.parsed),
    schemaValid: booleanOrNull(input.payload.schemaValid),
    repairCount: input.payload.repairCount ?? 0,
    salvageUsed: input.payload.salvageUsed === true,
    fallbackUsed: input.payload.fallbackUsed === true,
    ...(input.payload.role !== undefined ? { role: input.payload.role } : {}),
    ...(input.payload.model ? { model: input.payload.model } : {}),
    ...(input.payload.preset ? { preset: input.payload.preset } : {}),
    ...(input.payload.requestFingerprint !== undefined ? { requestFingerprint: input.payload.requestFingerprint } : {}),
    ...(input.payload.schemaHash !== undefined ? { schemaHash: input.payload.schemaHash } : {}),
    ...(input.payload.policyHash !== undefined ? { policyHash: input.payload.policyHash } : {}),
    validationErrors,
    ...(input.payload.stopReason !== undefined ? { stopReason: input.payload.stopReason } : {}),
    ...(input.payload.inputTokens !== undefined ? { inputTokens: input.payload.inputTokens } : {}),
    ...(input.payload.outputTokens !== undefined ? { outputTokens: input.payload.outputTokens } : {}),
    ...(input.payload.durationMs !== undefined ? { durationMs: input.payload.durationMs } : {}),
    artifactPreview: previewArtifact(input.payload.artifact),
    ...(typeof input.payload.rawText === 'string' ? { rawText: input.payload.rawText } : {}),
    ...(input.payload.rawThinkingText !== undefined ? { rawThinkingText: input.payload.rawThinkingText } : {}),
    attempts,
    rerunAction,
  }
}

function structuredOutputStatus(payload: StructuredOutputArtifactPayload): AppServerStructuredOutputArtifactStatus {
  const validationErrors = payload.validationErrors ?? []
  if (payload.ok === false || payload.fallbackUsed === true || payload.schemaValid === false || validationErrors.some(isPolicyViolation)) {
    return 'failed'
  }
  if (payload.repairCount && payload.repairCount > 0) return 'warning'
  if (payload.salvageUsed === true) return 'warning'
  if (validationErrors.length > 0) return 'warning'
  return 'success'
}

function buildRerunAction(input: {
  artifactId: string
  payload: StructuredOutputArtifactPayload
  runRef?: string
}): AppServerStructuredOutputRerunAction {
  const role = input.payload.role ?? undefined
  if (!input.runRef) {
    return {
      available: false,
      httpEndpoint: '/v1/structured-output/rerun',
      unavailableReason: 'missing_run_workspace_ref',
    }
  }
  if (!input.payload.model || !input.payload.preset) {
    return {
      available: false,
      httpEndpoint: '/v1/structured-output/rerun',
      unavailableReason: 'missing_model_or_preset',
    }
  }
  return {
    available: true,
    httpEndpoint: '/v1/structured-output/rerun',
    request: {
      runRef: input.runRef,
      previousArtifactId: input.artifactId,
      ...(role ? { role } : {}),
      model: input.payload.model,
      preset: input.payload.preset,
      artifactRef: input.artifactId,
    },
  }
}

function findAttemptRecord(
  artifact: RuntimeFactArtifactLike,
  attempts: RuntimeFactArtifactLike[],
  payloads: Map<string, StructuredOutputAttemptsPayload>,
): RuntimeFactArtifactLike | undefined {
  return attempts.find(record => {
    const payload = payloads.get(record.id)
    return record.id === `${artifact.id}-attempts`
      || record.factRefs?.coveredIds?.includes(artifact.id)
      || payload?.artifactId === artifact.id
  })
}

async function readArtifactPayload(
  record: RuntimeFactArtifactLike,
  warnings: string[],
): Promise<StructuredOutputArtifactPayload | null> {
  const parsed = await readJsonRecord(record, warnings)
  if (!isRecord(parsed)) return null
  if (parsed['artifactKind'] !== 'structured_output_artifact') return null
  return {
    artifactKind: stringField(parsed['artifactKind']),
    role: nullableStringField(parsed['role']),
    model: stringField(parsed['model']),
    preset: stringField(parsed['preset']),
    requestFingerprint: nullableStringField(parsed['requestFingerprint']),
    schemaHash: nullableStringField(parsed['schemaHash']),
    policyHash: nullableStringField(parsed['policyHash']),
    ok: booleanField(parsed['ok']),
    artifact: parsed['artifact'],
    rawText: stringField(parsed['rawText']),
    rawThinkingText: nullableStringField(parsed['rawThinkingText']),
    parsed: booleanField(parsed['parsed']),
    schemaValid: booleanField(parsed['schemaValid']),
    validationErrors: stringArrayField(parsed['validationErrors']),
    repairCount: numberField(parsed['repairCount']),
    salvageUsed: booleanField(parsed['salvageUsed']),
    fallbackUsed: booleanField(parsed['fallbackUsed']),
    stopReason: nullableStringField(parsed['stopReason']),
    inputTokens: nullableNumberField(parsed['inputTokens']),
    outputTokens: nullableNumberField(parsed['outputTokens']),
    durationMs: nullableNumberField(parsed['durationMs']),
  }
}

async function readAttemptsPayload(
  record: RuntimeFactArtifactLike,
  warnings: string[],
): Promise<StructuredOutputAttemptsPayload | null> {
  const parsed = await readJsonRecord(record, warnings)
  if (!isRecord(parsed)) return null
  if (parsed['artifactKind'] !== 'structured_output_attempts') return null
  return {
    artifactKind: stringField(parsed['artifactKind']),
    artifactId: stringField(parsed['artifactId']),
    attemptLedgerId: stringField(parsed['attemptLedgerId']),
    attempts: arrayField(parsed['attempts'])
      .map(item => isRecord(item) ? toAttemptItem(item) : null)
      .filter((item): item is AppServerStructuredOutputAttemptItem => item !== null),
  }
}

async function readJsonRecord(record: RuntimeFactArtifactLike, warnings: string[]): Promise<unknown> {
  if (!record.path) {
    warnings.push(`${record.id}: missing artifact path`)
    return null
  }
  try {
    return JSON.parse(await readFile(record.path, 'utf8'))
  } catch (error) {
    warnings.push(`${record.id}: ${error instanceof Error ? error.message : 'could not read artifact JSON'}`)
    return null
  }
}

function toAttemptItem(value: Record<string, unknown>): AppServerStructuredOutputAttemptItem {
  return {
    label: stringField(value['label']) ?? 'unknown',
    ...(stringField(value['model']) ? { model: stringField(value['model']) } : {}),
    ...(numberField(value['durationMs']) !== undefined ? { durationMs: numberField(value['durationMs']) } : {}),
    ...(numberField(value['inputTokens']) !== undefined ? { inputTokens: numberField(value['inputTokens']) } : {}),
    ...(numberField(value['outputTokens']) !== undefined ? { outputTokens: numberField(value['outputTokens']) } : {}),
    ...(stringField(value['stopReason']) ? { stopReason: stringField(value['stopReason']) } : {}),
    ...(booleanField(value['parsed']) !== undefined ? { parsed: booleanField(value['parsed']) } : {}),
    ...(booleanField(value['schemaValid']) !== undefined ? { schemaValid: booleanField(value['schemaValid']) } : {}),
    ...(stringField(value['error']) ? { error: stringField(value['error']) } : {}),
  }
}

function isStructuredOutputArtifactRecord(record: RuntimeFactArtifactLike): boolean {
  return record.artifactType === 'structured_output_artifact'
}

function isStructuredOutputAttemptsRecord(record: RuntimeFactArtifactLike): boolean {
  return record.artifactType === 'structured_output_attempts'
}

function previewArtifact(value: unknown): unknown {
  return truncateValue(value, 0)
}

function truncateValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > 1200 ? `${value.slice(0, 1200)}...` : value
  }
  if (Array.isArray(value)) return value.slice(0, 12).map(item => truncateValue(item, depth + 1))
  if (isRecord(value)) {
    if (depth >= 4) return '[truncated]'
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      out[key] = truncateValue(item, depth + 1)
    }
    return out
  }
  return value
}

function isPolicyViolation(error: string): boolean {
  return /(?:forbidden|policy|business execution|chain-of-thought|cot|建议买|入串|EV|Kelly|fair odds)/i.test(error)
}

function booleanOrNull(value: boolean | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null
  return stringField(value)
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullableNumberField(value: unknown): number | null | undefined {
  if (value === null) return null
  return numberField(value)
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringArrayField(value: unknown): string[] {
  return arrayField(value).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
