import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeFactRefs } from './native/protocol/types.js'
import {
  getRunWorkspacePathsFromRef,
  readArtifactLedger,
  readManifest,
  recordArtifact,
  recordEvent,
  type RunArtifactRecord,
} from './native/run-workspace.js'
import type { StructuredOutputRequest, StructuredOutputResponse } from './model-output-harness.js'

export interface PersistStructuredOutputResult {
  artifactId: string
  attemptLedgerId: string
  artifactPath: string
  attemptsPath: string
}

export interface StructuredOutputArtifactInput {
  record: RunArtifactRecord
  payload: unknown
}

export async function persistStructuredOutputResult(
  request: StructuredOutputRequest,
  response: StructuredOutputResponse,
  cwd = process.cwd(),
): Promise<PersistStructuredOutputResult> {
  if (!request.runRef) {
    throw new Error('runRef is required when persist=true')
  }

  const paths = getRunWorkspacePathsFromRef(request.runRef, cwd)
  const manifest = await readManifest(paths.runDir)
  const artifactId = `structured-output-${randomUUID()}`
  const attemptLedgerId = `${artifactId}-attempts`
  const structuredDir = join(paths.evidenceDir, 'structured-output')
  await mkdir(structuredDir, { recursive: true })

  const recordedAt = new Date().toISOString()
  const preset = request.preset ?? 'evidence-digest.v1'
  const parentArtifactId = request.previousArtifactId?.trim()
  const inputRef = request.inputRef?.trim()
  const artifactRef = request.artifactRef?.trim()
  const rerunReceiptRef = request.artifactRef?.trim()
  const coveredIds = uniqueStrings([
    parentArtifactId,
    inputRef,
    artifactRef,
  ].filter((value): value is string => Boolean(value && value.startsWith('structured-output-'))))
  const factRefs = compactRefs({
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId ?? manifest.runId,
    taskId: request.taskId,
    stepId: request.stepId ?? request.role,
    jobId: request.jobId,
    artifactId,
    proofId: request.proofId,
    coveredIds,
  })
  const hashes = requestHashes(request)
  const rerunLineage = parentArtifactId
    ? {
        rerunId: `rerun-${randomUUID()}`,
        role: request.role ?? null,
        stepId: request.stepId ?? request.role ?? null,
        parentArtifactId,
        previousAttemptLedgerRef: `${parentArtifactId}-attempts`,
        rerunReceiptRef: rerunReceiptRef ?? null,
        reason: 'role_step_rerun',
        createdAt: recordedAt,
      }
    : undefined
  const lineage = parentArtifactId
    ? {
        rerun: rerunLineage,
        parentArtifactId,
        rerunOf: parentArtifactId,
        inputRef: inputRef ?? null,
        artifactRef: artifactRef ?? null,
      }
    : {}

  const artifactPayload = {
    version: 1,
    artifactKind: 'structured_output_artifact',
    recordedAt,
    role: request.role ?? null,
    model: request.model,
    preset,
    presetId: response.presetId,
    presetVersion: response.presetVersion,
    schemaId: response.schemaId,
    schemaVersion: response.schemaVersion,
    repairPolicyVersion: response.repairPolicyVersion,
    providerMatrixVersion: response.providerMatrixVersion,
    providerMatrixProvenance: response.providerMatrixProvenance,
    requestFingerprint: hashes.requestFingerprint,
    schemaHash: hashes.schemaHash,
    policyHash: hashes.policyHash,
    factRefs,
    ok: response.ok,
    usable: response.usable,
    failureReason: response.failureReason ?? null,
    unusableReason: response.unusableReason,
    consumerReady: response.consumerReady,
    consumerReadiness: response.consumerReadiness,
    artifactCompleteness: response.artifactCompleteness,
    salvage: response.salvage,
    terminationKind: response.terminationKind,
    lastOutputAt: response.lastOutputAt ?? null,
    idleMs: response.idleMs ?? null,
    artifact: response.artifact,
    rawText: response.rawText,
    rawThinkingText: response.rawThinkingText ?? null,
    parsed: response.parsed,
    schemaValid: response.schemaValid,
    validationErrors: response.validationErrors,
    repairCount: response.repairCount,
    salvageUsed: response.salvageUsed,
    fallbackUsed: response.fallbackUsed,
    stopReason: response.stopReason,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    durationMs: response.durationMs,
    executionCounts: response.executionCounts ?? null,
    executionEconomics: response.executionEconomics ?? null,
    idempotency: response.idempotency ?? null,
    capabilityGate: response.capabilityGate ?? null,
    ...lineage,
  }

  const attemptsPayload = {
    version: 1,
    artifactKind: 'structured_output_attempts',
    recordedAt,
    artifactId,
    attemptLedgerId,
    role: request.role ?? null,
    model: request.model,
    preset,
    presetId: response.presetId,
    presetVersion: response.presetVersion,
    schemaId: response.schemaId,
    schemaVersion: response.schemaVersion,
    repairPolicyVersion: response.repairPolicyVersion,
    providerMatrixVersion: response.providerMatrixVersion,
    providerMatrixProvenance: response.providerMatrixProvenance,
    failureReason: response.failureReason ?? null,
    requestFingerprint: hashes.requestFingerprint,
    schemaHash: hashes.schemaHash,
    policyHash: hashes.policyHash,
    factRefs,
    attempts: response.attempts,
    executionCounts: response.executionCounts ?? null,
    executionEconomics: response.executionEconomics ?? null,
    idempotency: response.idempotency ?? null,
    artifactCompleteness: response.artifactCompleteness,
    consumerReadiness: response.consumerReadiness,
    capabilityGate: response.capabilityGate ?? null,
    ...lineage,
  }

  const artifactPath = join(structuredDir, `${artifactId}.json`)
  const attemptsPath = join(structuredDir, `${attemptLedgerId}.json`)
  await writeJsonFile(artifactPath, artifactPayload)
  await writeJsonFile(attemptsPath, attemptsPayload)

  await recordArtifact(paths.outputRoot, {
    id: artifactId,
    path: artifactPath,
    origin: 'model_output_harness',
    artifactType: 'structured_output_artifact',
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId ?? manifest.runId,
    taskId: request.taskId,
    stepId: request.stepId ?? request.role,
    jobId: request.jobId,
    proofId: request.proofId,
    factRefs,
    participatesInFinal: response.ok && response.schemaValid,
  }, cwd)

  await recordArtifact(paths.outputRoot, {
    id: attemptLedgerId,
    path: attemptsPath,
    origin: 'model_output_harness',
    artifactType: 'structured_output_attempts',
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId ?? manifest.runId,
    taskId: request.taskId,
    stepId: request.stepId ?? request.role,
    jobId: request.jobId,
    proofId: request.proofId,
    factRefs: {
      ...factRefs,
      artifactId: attemptLedgerId,
      coveredIds: uniqueStrings([...(factRefs.coveredIds ?? []), artifactId]),
    },
    participatesInFinal: false,
  }, cwd)

  await recordEvent(paths.outputRoot, {
    type: parentArtifactId ? 'structured_output_artifact_rerun_recorded' : 'structured_output_artifact_recorded',
    stepId: request.stepId ?? request.role,
    factRefs,
    data: {
      artifactId,
      attemptLedgerId,
      role: request.role ?? null,
      model: request.model,
      preset,
      ok: response.ok,
      usable: response.usable,
      failureReason: response.failureReason ?? null,
      consumerReady: response.consumerReady,
      artifactCompleteness: response.artifactCompleteness,
      consumerReadiness: response.consumerReadiness,
      terminationKind: response.terminationKind,
      schemaValid: response.schemaValid,
      validationErrors: response.validationErrors,
      repairCount: response.repairCount,
      salvageUsed: response.salvageUsed,
      fallbackUsed: response.fallbackUsed,
      stopReason: response.stopReason,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: response.durationMs,
      executionCounts: response.executionCounts ?? null,
      executionEconomics: response.executionEconomics ?? null,
      idempotency: response.idempotency ?? null,
      capabilityGate: response.capabilityGate ?? null,
      providerMatrixProvenance: response.providerMatrixProvenance,
      requestFingerprint: hashes.requestFingerprint,
      schemaHash: hashes.schemaHash,
      policyHash: hashes.policyHash,
      ...lineage,
    },
  }, cwd)

  return { artifactId, attemptLedgerId, artifactPath, attemptsPath }
}

export async function readStructuredOutputArtifactInput(
  runRef: string,
  artifactRef: string,
  cwd = process.cwd(),
): Promise<StructuredOutputArtifactInput> {
  const record = await findRunWorkspaceArtifact(runRef, artifactRef, cwd)
  const raw = await readFile(record.path, 'utf8')
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = raw
  }
  return { record, payload }
}

export async function findRunWorkspaceArtifact(
  runRef: string,
  artifactRef: string,
  cwd = process.cwd(),
): Promise<RunArtifactRecord> {
  const ref = artifactRef.trim()
  if (!ref) {
    throw new Error('artifactRef is required')
  }
  const ledger = await readArtifactLedger(runRef, {}, cwd)
  const record = ledger.artifacts.find(artifact =>
    artifact.id === ref
    || artifact.factRefs?.artifactId === ref
    || artifact.path === ref
    || artifact.factRefs?.artifactPath === ref,
  )
  if (!record) {
    throw new Error(`artifact not found in RunWorkspace ledger: ${ref}`)
  }
  return record
}

function requestHashes(request: StructuredOutputRequest): {
  requestFingerprint: string
  schemaHash: string | null
  policyHash: string | null
} {
  return {
    requestFingerprint: `sha256:${hashJson({
      model: request.model,
      preset: request.preset ?? 'evidence-digest.v1',
      system: request.system ?? null,
      user: request.user,
      maxTokens: request.maxTokens ?? null,
      schema: request.schema ?? null,
      policy: request.policy ?? null,
      repairPolicy: request.repairPolicy ?? null,
      salvagePolicy: request.salvagePolicy ?? null,
      modelCapabilities: request.modelCapabilities ?? null,
    })}`,
    schemaHash: request.schema ? `sha256:${hashJson(request.schema)}` : null,
    policyHash: request.policy ? `sha256:${hashJson(request.policy)}` : null,
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return out
}

function compactRefs(refs: RuntimeFactRefs): RuntimeFactRefs {
  const out: RuntimeFactRefs = {}
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === 'string' && value.trim()) {
      ;(out as Record<string, string>)[key] = value.trim()
    } else if (Array.isArray(value) && value.length > 0) {
      ;(out as Record<string, string[]>)[key] = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  }
  return out
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
