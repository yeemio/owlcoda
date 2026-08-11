import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { RuntimeFactRefs } from '../protocol/types.js'
import {
  getRunWorkspacePathsFromRef,
  readArtifactLedger,
  readManifest,
  recordArtifact,
  recordEvent,
  type ArtifactLedger,
  type RunArtifactRecord,
  type RunWorkspacePaths,
} from '../run-workspace.js'
import { InvariantSpineError } from './evidence.js'
import type { WorkCaseExecutionReceipt } from './work-case.js'

export type AdjudicationDisposition = 'accept' | 'correct' | 'reject' | 'need_evidence'

export interface ArtifactContentBinding {
  readonly ref: string
  readonly sha256: string
}

export interface AdjudicationReceipt {
  readonly schemaVersion: 1
  readonly kind: 'adjudication_receipt'
  readonly id: string
  readonly workCaseId: string
  readonly evidenceSnapshotRef: string
  readonly runRef: string
  readonly findingOrArtifactRef: string
  readonly findingOrArtifactSha256: string
  readonly disposition: AdjudicationDisposition
  readonly note: string
  readonly correctedArtifactRef?: string
  readonly correctedArtifactSha256?: string
  readonly adjudicatorRef: string
  readonly timestamp: string
}

export interface VerifiedOutcome {
  readonly schemaVersion: 1
  readonly kind: 'verified_outcome'
  readonly outcomeId: string
  readonly workCaseId: string
  readonly evidenceSnapshotRef: string
  readonly runRef: string
  readonly adjudicationRefs: readonly string[]
  readonly verificationStatus: 'verified'
  readonly resultArtifactRefs: readonly string[]
  readonly resultArtifactBindings: readonly ArtifactContentBinding[]
  readonly verifiedAt: string
  readonly systemOfRecordWriteBack: false
}

export interface WorkCaseExecutionRecord {
  readonly receipt: WorkCaseExecutionReceipt
  readonly receiptPath: string
}

export interface RecordedAdjudicationReceipt {
  readonly receipt: AdjudicationReceipt
  readonly receiptPath: string
  readonly artifact: RunArtifactRecord
}

export interface RecordedVerifiedOutcome {
  readonly outcome: VerifiedOutcome
  readonly outcomePath: string
  readonly artifact: RunArtifactRecord
}

export interface CreateAdjudicationReceiptInput {
  executionReceipt: WorkCaseExecutionReceipt
  findingOrArtifactRef: string
  findingOrArtifactSha256: string
  disposition: AdjudicationDisposition
  note: string
  correctedArtifactRef?: string
  correctedArtifactSha256?: string
  adjudicatorRef: string
  timestamp?: string
}

export interface RecordAdjudicationReceiptInput {
  execution: WorkCaseExecutionRecord
  findingOrArtifactRef: string
  disposition: AdjudicationDisposition
  note: string
  correctedArtifactRef?: string
  adjudicatorRef: string
  timestamp?: string
  runRef: string
  cwd?: string
}

export interface CreateVerifiedOutcomeInput {
  executionReceipt: WorkCaseExecutionReceipt
  adjudicationReceipts: readonly AdjudicationReceipt[]
  resultArtifactRefs: readonly string[]
  verifiedAt?: string
}

export interface RecordVerifiedOutcomeInput {
  execution: WorkCaseExecutionRecord
  adjudications: readonly RecordedAdjudicationReceipt[]
  resultArtifactRefs: readonly string[]
  verifiedAt?: string
  runRef: string
  cwd?: string
}

export function createAdjudicationReceipt(input: CreateAdjudicationReceiptInput): AdjudicationReceipt {
  assertRecordWithKeys(input, new Set([
    'executionReceipt',
    'findingOrArtifactRef',
    'findingOrArtifactSha256',
    'disposition',
    'note',
    'correctedArtifactRef',
    'correctedArtifactSha256',
    'adjudicatorRef',
    'timestamp',
  ]), 'ADJUDICATION_INVALID', 'Adjudication input')
  const executionReceipt = normalizeExecutionReceipt(input.executionReceipt)
  const findingOrArtifactRef = requiredString(
    input.findingOrArtifactRef,
    'ADJUDICATION_INVALID',
    'findingOrArtifactRef',
  )
  if (!executionArtifactRefs(executionReceipt).has(findingOrArtifactRef)) {
    throw new InvariantSpineError(
      'ADJUDICATION_ARTIFACT_UNBOUND',
      `Adjudication target is not retained by WorkCase ${executionReceipt.workCaseId}: ${findingOrArtifactRef}`,
    )
  }
  const findingOrArtifactSha256 = normalizeSha256(
    input.findingOrArtifactSha256,
    'ADJUDICATION_INVALID',
    'findingOrArtifactSha256',
  )
  const disposition = normalizeDisposition(input.disposition)
  const correctedArtifactRef = input.correctedArtifactRef === undefined
    ? undefined
    : requiredString(input.correctedArtifactRef, 'ADJUDICATION_INVALID', 'correctedArtifactRef')
  const correctedArtifactSha256 = input.correctedArtifactSha256 === undefined
    ? undefined
    : normalizeSha256(input.correctedArtifactSha256, 'ADJUDICATION_INVALID', 'correctedArtifactSha256')
  if (disposition === 'correct' && (!correctedArtifactRef || !correctedArtifactSha256)) {
    throw new InvariantSpineError(
      'ADJUDICATION_INVALID',
      'A correct disposition requires correctedArtifactRef and correctedArtifactSha256',
    )
  }
  if (disposition !== 'correct' && (correctedArtifactRef || correctedArtifactSha256)) {
    throw new InvariantSpineError(
      'ADJUDICATION_INVALID',
      'Corrected artifact bindings are only valid for a correct disposition',
    )
  }
  const evidenceSnapshotRef = requiredString(
    executionReceipt.evidenceContextSnapshotRef,
    'ADJUDICATION_INVALID',
    'execution evidenceContextSnapshotRef',
  )
  const payload = {
    schemaVersion: 1 as const,
    kind: 'adjudication_receipt' as const,
    workCaseId: executionReceipt.workCaseId,
    evidenceSnapshotRef,
    runRef: executionReceipt.executionRunId,
    findingOrArtifactRef,
    findingOrArtifactSha256,
    disposition,
    note: requiredString(input.note, 'ADJUDICATION_INVALID', 'note'),
    ...(correctedArtifactRef ? { correctedArtifactRef } : {}),
    ...(correctedArtifactSha256 ? { correctedArtifactSha256 } : {}),
    adjudicatorRef: requiredString(input.adjudicatorRef, 'ADJUDICATION_INVALID', 'adjudicatorRef'),
    timestamp: normalizeTimestamp(input.timestamp ?? new Date().toISOString(), 'ADJUDICATION_INVALID', 'timestamp'),
  }
  return deepFreeze({
    ...payload,
    id: `adjudication-receipt:sha256:${sha256(stableJson(payload))}`,
  })
}

export async function recordAdjudicationReceipt(
  input: RecordAdjudicationReceiptInput,
): Promise<RecordedAdjudicationReceipt> {
  assertRecordWithKeys(input, new Set([
    'execution',
    'findingOrArtifactRef',
    'disposition',
    'note',
    'correctedArtifactRef',
    'adjudicatorRef',
    'timestamp',
    'runRef',
    'cwd',
  ]), 'ADJUDICATION_INVALID', 'Adjudication record input')
  const cwd = resolve(input.cwd ?? process.cwd())
  const inspected = await inspectExecutionRecord(input.execution, input.runRef, cwd)
  const findingOrArtifactRef = requiredString(
    input.findingOrArtifactRef,
    'ADJUDICATION_INVALID',
    'findingOrArtifactRef',
  )
  const findingArtifact = requirePresentArtifact(
    inspected.ledger,
    findingOrArtifactRef,
    'ADJUDICATION_ARTIFACT_UNBOUND',
  )
  const correctedArtifactRef = input.correctedArtifactRef === undefined
    ? undefined
    : requiredString(input.correctedArtifactRef, 'ADJUDICATION_INVALID', 'correctedArtifactRef')
  const correctedArtifact = correctedArtifactRef
    ? requirePresentArtifact(inspected.ledger, correctedArtifactRef, 'ADJUDICATION_ARTIFACT_UNBOUND')
    : undefined
  const receipt = createAdjudicationReceipt({
    executionReceipt: inspected.receipt,
    findingOrArtifactRef,
    findingOrArtifactSha256: await hashArtifactContent(
      findingArtifact,
      'ADJUDICATION_ARTIFACT_UNBOUND',
    ),
    disposition: input.disposition,
    note: input.note,
    ...(correctedArtifactRef && correctedArtifact
      ? {
          correctedArtifactRef,
          correctedArtifactSha256: await hashArtifactContent(
            correctedArtifact,
            'ADJUDICATION_ARTIFACT_UNBOUND',
          ),
        }
      : {}),
    adjudicatorRef: input.adjudicatorRef,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  })

  const receiptPath = join(
    inspected.paths.evidenceDir,
    'invariant-spine',
    safeSegment(receipt.workCaseId),
    safeSegment(receipt.runRef),
    'adjudications',
    `${receipt.id.slice('adjudication-receipt:sha256:'.length)}.json`,
  )
  const created = await writeImmutableJson(receiptPath, receipt, 'ADJUDICATION_RECEIPT_PERSISTENCE_FAILED')
  const artifact = await recordArtifact(inspected.paths.runDir, {
    id: receipt.id,
    path: receiptPath,
    origin: 'human_adjudication',
    runId: inspected.receipt.workspaceRunId,
    jobId: inspected.receipt.jobId,
    factRefs: factRefsFromExecution(inspected.receipt),
    artifactType: 'adjudication_receipt',
    participatesInFinal: false,
  }, cwd)
  if (created) {
    await recordEvent(inspected.paths.runDir, {
      type: 'human_adjudication_recorded',
      message: `Human adjudication ${receipt.disposition} recorded for WorkCase ${receipt.workCaseId}`,
      factRefs: factRefsFromExecution(inspected.receipt),
      data: {
        adjudicationRef: receipt.id,
        findingOrArtifactRef: receipt.findingOrArtifactRef,
        disposition: receipt.disposition,
        adjudicatorRef: receipt.adjudicatorRef,
        receiptPath,
        ...(receipt.correctedArtifactRef ? { correctedArtifactRef: receipt.correctedArtifactRef } : {}),
      },
    }, cwd)
  }
  return Object.freeze({ receipt, receiptPath, artifact })
}

export function createVerifiedOutcome(input: CreateVerifiedOutcomeInput): VerifiedOutcome {
  assertRecordWithKeys(input, new Set([
    'executionReceipt',
    'adjudicationReceipts',
    'resultArtifactRefs',
    'verifiedAt',
  ]), 'VERIFIED_OUTCOME_INVALID', 'VerifiedOutcome input')
  const executionReceipt = normalizeExecutionReceipt(input.executionReceipt)
  if (executionReceipt.status !== 'completed') {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_BLOCKED',
      `WorkCase ${executionReceipt.workCaseId} did not complete successfully`,
    )
  }
  const evidenceSnapshotRef = requiredString(
    executionReceipt.evidenceContextSnapshotRef,
    'VERIFIED_OUTCOME_BLOCKED',
    'execution evidenceContextSnapshotRef',
  )
  if (!Array.isArray(input.adjudicationReceipts) || input.adjudicationReceipts.length === 0) {
    throw new InvariantSpineError('VERIFIED_OUTCOME_BLOCKED', 'VerifiedOutcome requires a final human adjudication')
  }
  const adjudications = input.adjudicationReceipts.map(normalizeAdjudicationReceipt)
  const seenTargets = new Set<string>()
  const expectedResultRefs: string[] = []
  const expectedResultBindings: ArtifactContentBinding[] = []
  for (const receipt of adjudications) {
    if (
      receipt.workCaseId !== executionReceipt.workCaseId
      || receipt.evidenceSnapshotRef !== evidenceSnapshotRef
      || receipt.runRef !== executionReceipt.executionRunId
    ) {
      throw new InvariantSpineError(
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        `Adjudication ${receipt.id} does not belong to the selected WorkCase execution`,
      )
    }
    if (seenTargets.has(receipt.findingOrArtifactRef)) {
      throw new InvariantSpineError(
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        `VerifiedOutcome has more than one final adjudication for ${receipt.findingOrArtifactRef}`,
      )
    }
    seenTargets.add(receipt.findingOrArtifactRef)
    if (receipt.disposition === 'reject' || receipt.disposition === 'need_evidence') {
      throw new InvariantSpineError(
        'VERIFIED_OUTCOME_BLOCKED',
        `Adjudication ${receipt.id} has non-verifying disposition ${receipt.disposition}`,
      )
    }
    const resultRef = receipt.disposition === 'correct'
      ? requiredString(
          receipt.correctedArtifactRef,
          'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
          'correctedArtifactRef',
        )
      : receipt.findingOrArtifactRef
    const resultSha256 = receipt.disposition === 'correct'
      ? normalizeSha256(
          receipt.correctedArtifactSha256,
          'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
          'correctedArtifactSha256',
        )
      : receipt.findingOrArtifactSha256
    expectedResultRefs.push(resultRef)
    expectedResultBindings.push({ ref: resultRef, sha256: resultSha256 })
  }

  const resultArtifactRefs = uniqueSortedStrings(
    input.resultArtifactRefs,
    'VERIFIED_OUTCOME_INVALID',
    'resultArtifactRefs',
  )
  const expected = uniqueSortedStrings(
    expectedResultRefs,
    'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
    'adjudicated result refs',
  )
  if (stableJson(resultArtifactRefs) !== stableJson(expected)) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'VerifiedOutcome resultArtifactRefs must exactly match the selected positive adjudications',
    )
  }
  const resultArtifactBindings = uniqueArtifactBindings(expectedResultBindings)

  const payload = {
    schemaVersion: 1 as const,
    kind: 'verified_outcome' as const,
    workCaseId: executionReceipt.workCaseId,
    evidenceSnapshotRef,
    runRef: executionReceipt.executionRunId,
    adjudicationRefs: uniqueSortedStrings(
      adjudications.map(receipt => receipt.id),
      'VERIFIED_OUTCOME_INVALID',
      'adjudicationRefs',
    ),
    verificationStatus: 'verified' as const,
    resultArtifactRefs,
    resultArtifactBindings,
    verifiedAt: normalizeTimestamp(input.verifiedAt ?? new Date().toISOString(), 'VERIFIED_OUTCOME_INVALID', 'verifiedAt'),
    systemOfRecordWriteBack: false as const,
  }
  return deepFreeze({
    ...payload,
    outcomeId: `verified-outcome:sha256:${sha256(stableJson(payload))}`,
  })
}

export async function recordVerifiedOutcome(
  input: RecordVerifiedOutcomeInput,
): Promise<RecordedVerifiedOutcome> {
  assertRecordWithKeys(input, new Set([
    'execution',
    'adjudications',
    'resultArtifactRefs',
    'verifiedAt',
    'runRef',
    'cwd',
  ]), 'VERIFIED_OUTCOME_INVALID', 'VerifiedOutcome record input')
  const cwd = resolve(input.cwd ?? process.cwd())
  const inspected = await inspectExecutionRecord(input.execution, input.runRef, cwd)
  if (!Array.isArray(input.adjudications) || input.adjudications.length === 0) {
    throw new InvariantSpineError('VERIFIED_OUTCOME_BLOCKED', 'VerifiedOutcome requires recorded adjudication receipts')
  }
  for (const recorded of input.adjudications) {
    await inspectRecordedAdjudication(recorded, inspected.ledger)
  }
  const outcome = createVerifiedOutcome({
    executionReceipt: inspected.receipt,
    adjudicationReceipts: input.adjudications.map(recorded => recorded.receipt),
    resultArtifactRefs: input.resultArtifactRefs,
    ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
  })
  for (const binding of outcome.resultArtifactBindings) {
    const artifact = requirePresentArtifact(
      inspected.ledger,
      binding.ref,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
    )
    const currentSha256 = await hashArtifactContent(artifact, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH')
    if (currentSha256 !== binding.sha256) {
      throw new InvariantSpineError(
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        `Adjudicated artifact content changed before VerifiedOutcome: ${binding.ref}`,
      )
    }
  }

  const outcomePath = join(
    inspected.paths.evidenceDir,
    'invariant-spine',
    safeSegment(outcome.workCaseId),
    safeSegment(outcome.runRef),
    'verified-outcomes',
    `${outcome.outcomeId.slice('verified-outcome:sha256:'.length)}.json`,
  )
  const created = await writeImmutableJson(outcomePath, outcome, 'VERIFIED_OUTCOME_PERSISTENCE_FAILED')
  const artifact = await recordArtifact(inspected.paths.runDir, {
    id: outcome.outcomeId,
    path: outcomePath,
    origin: 'human_adjudication',
    runId: inspected.receipt.workspaceRunId,
    jobId: inspected.receipt.jobId,
    factRefs: factRefsFromExecution(inspected.receipt),
    artifactType: 'verified_outcome',
    participatesInFinal: true,
  }, cwd)
  if (created) {
    await recordEvent(inspected.paths.runDir, {
      type: 'verified_outcome_recorded',
      message: `VerifiedOutcome recorded for WorkCase ${outcome.workCaseId}`,
      factRefs: factRefsFromExecution(inspected.receipt),
      data: {
        outcomeId: outcome.outcomeId,
        adjudicationRefs: [...outcome.adjudicationRefs],
        resultArtifactRefs: [...outcome.resultArtifactRefs],
        verificationStatus: outcome.verificationStatus,
        systemOfRecordWriteBack: false,
        outcomePath,
      },
    }, cwd)
  }
  return Object.freeze({ outcome, outcomePath, artifact })
}

async function inspectExecutionRecord(
  execution: WorkCaseExecutionRecord,
  runRef: string,
  cwd: string,
): Promise<{
  receipt: WorkCaseExecutionReceipt
  paths: RunWorkspacePaths
  ledger: ArtifactLedger
}> {
  if (!isRecord(execution)) {
    throw new InvariantSpineError('VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'WorkCase execution record is invalid')
  }
  const receipt = normalizeExecutionReceipt(execution.receipt)
  const receiptPath = resolve(requiredString(
    execution.receiptPath,
    'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
    'execution receiptPath',
  ))
  const paths = getRunWorkspacePathsFromRef(
    requiredString(runRef, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'runRef'),
    cwd,
  )
  const manifest = await readManifest(paths.runDir, cwd)
  if (manifest.runId !== receipt.workspaceRunId) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `WorkCase receipt belongs to workspace ${receipt.workspaceRunId}, not ${manifest.runId}`,
    )
  }
  let persisted: unknown
  try {
    persisted = JSON.parse(await readFile(receiptPath, 'utf-8'))
  } catch (error) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `Could not read the retained WorkCase execution receipt: ${errorMessage(error)}`,
    )
  }
  if (stableJson(persisted) !== stableJson(receipt)) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'WorkCase execution receipt bytes do not match the supplied receipt',
    )
  }
  const ledger = await readArtifactLedger(paths.runDir, { refresh: true }, cwd)
  const receiptArtifact = ledger.artifacts.find(artifact =>
    resolve(artifact.path) === receiptPath
    && artifact.artifactType === 'work_case_execution_receipt'
    && artifact.status === 'present')
  if (!receiptArtifact || receiptArtifact.jobId !== receipt.jobId) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'WorkCase execution receipt is not retained in the selected RunWorkspace',
    )
  }
  return { receipt, paths, ledger }
}

async function inspectRecordedAdjudication(
  recorded: RecordedAdjudicationReceipt,
  ledger: ArtifactLedger,
): Promise<void> {
  if (!isRecord(recorded)) {
    throw new InvariantSpineError('VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'Recorded adjudication is invalid')
  }
  const receipt = normalizeAdjudicationReceipt(recorded.receipt)
  const receiptPath = resolve(requiredString(
    recorded.receiptPath,
    'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
    'adjudication receiptPath',
  ))
  let persisted: unknown
  try {
    persisted = JSON.parse(await readFile(receiptPath, 'utf-8'))
  } catch (error) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `Could not read adjudication ${receipt.id}: ${errorMessage(error)}`,
    )
  }
  if (stableJson(persisted) !== stableJson(receipt)) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `Adjudication receipt bytes do not match ${receipt.id}`,
    )
  }
  const artifact = ledger.artifacts.find(candidate =>
    candidate.id === receipt.id
    && resolve(candidate.path) === receiptPath
    && candidate.artifactType === 'adjudication_receipt'
    && candidate.status === 'present')
  if (!artifact) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `Adjudication ${receipt.id} is not retained in the selected RunWorkspace`,
    )
  }
}

function normalizeExecutionReceipt(receipt: WorkCaseExecutionReceipt): WorkCaseExecutionReceipt {
  if (!isRecord(receipt)) {
    throw new InvariantSpineError('VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'WorkCase execution receipt is invalid')
  }
  if (
    receipt.schemaVersion !== 1
    || receipt.kind !== 'work_case_execution_correlation_receipt'
    || !['completed', 'failed', 'cancelled'].includes(String(receipt.status))
    || receipt.executionMode !== 'local_read_only'
    || receipt.productionWriteCount !== 0
  ) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'WorkCase execution receipt contract is invalid',
    )
  }
  for (const [field, value] of Object.entries({
    workCaseId: receipt.workCaseId,
    evidenceContextId: receipt.evidenceContextId,
    executionRunId: receipt.executionRunId,
    driverId: receipt.driverId,
    executionId: receipt.executionId,
    attemptId: receipt.attemptId,
    runId: receipt.runId,
    jobId: receipt.jobId,
    workspaceRunId: receipt.workspaceRunId,
  })) {
    requiredString(value, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', field)
  }
  if (receipt.runId !== receipt.executionRunId) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'WorkCase receipt runId must equal executionRunId',
    )
  }
  if (!Array.isArray(receipt.workflowArtifactRefs) || !Array.isArray(receipt.registeredArtifactRefs)) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'WorkCase receipt artifact references are invalid',
    )
  }
  return receipt
}

function normalizeAdjudicationReceipt(receipt: AdjudicationReceipt): AdjudicationReceipt {
  assertRecordWithKeys(receipt, new Set([
    'schemaVersion',
    'kind',
    'id',
    'workCaseId',
    'evidenceSnapshotRef',
    'runRef',
    'findingOrArtifactRef',
    'findingOrArtifactSha256',
    'disposition',
    'note',
    'correctedArtifactRef',
    'correctedArtifactSha256',
    'adjudicatorRef',
    'timestamp',
  ]), 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'Adjudication receipt')
  const disposition = normalizeAdjudicationDisposition(
    receipt.disposition,
    'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
  )
  const correctedArtifactRef = receipt.correctedArtifactRef === undefined
    ? undefined
    : requiredString(
        receipt.correctedArtifactRef,
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        'correctedArtifactRef',
      )
  const correctedArtifactSha256 = receipt.correctedArtifactSha256 === undefined
    ? undefined
    : normalizeSha256(
        receipt.correctedArtifactSha256,
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        'correctedArtifactSha256',
      )
  if (
    (disposition === 'correct') !== Boolean(correctedArtifactRef)
    || (disposition === 'correct') !== Boolean(correctedArtifactSha256)
  ) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'Adjudication correction provenance is invalid',
    )
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: 'adjudication_receipt' as const,
    workCaseId: requiredString(
      receipt.workCaseId,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'workCaseId',
    ),
    evidenceSnapshotRef: requiredString(
      receipt.evidenceSnapshotRef,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'evidenceSnapshotRef',
    ),
    runRef: requiredString(receipt.runRef, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'runRef'),
    findingOrArtifactRef: requiredString(
      receipt.findingOrArtifactRef,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'findingOrArtifactRef',
    ),
    findingOrArtifactSha256: normalizeSha256(
      receipt.findingOrArtifactSha256,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'findingOrArtifactSha256',
    ),
    disposition,
    note: requiredString(receipt.note, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'note'),
    ...(correctedArtifactRef ? { correctedArtifactRef } : {}),
    ...(correctedArtifactSha256 ? { correctedArtifactSha256 } : {}),
    adjudicatorRef: requiredString(
      receipt.adjudicatorRef,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'adjudicatorRef',
    ),
    timestamp: normalizeTimestamp(
      receipt.timestamp,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'timestamp',
    ),
  }
  const id = requiredString(receipt.id, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'id')
  if (
    receipt.schemaVersion !== 1
    || receipt.kind !== 'adjudication_receipt'
    || id !== `adjudication-receipt:sha256:${sha256(stableJson(payload))}`
  ) {
    throw new InvariantSpineError(
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      `Adjudication receipt identity is invalid: ${String(receipt.id)}`,
    )
  }
  return deepFreeze({ ...payload, id })
}

function executionArtifactRefs(receipt: WorkCaseExecutionReceipt): Set<string> {
  return new Set([
    ...receipt.workflowArtifactRefs,
    ...receipt.registeredArtifactRefs.flatMap(artifact => [artifact.id, artifact.path]),
  ])
}

function requirePresentArtifact(ledger: ArtifactLedger, ref: string, code: string): RunArtifactRecord {
  const artifact = ledger.artifacts.find(candidate =>
    candidate.status === 'present'
    && (candidate.id === ref || (isAbsolute(ref) && resolve(candidate.path) === resolve(ref))))
  if (!artifact) {
    throw new InvariantSpineError(code, `Artifact is not present in the selected RunWorkspace: ${ref}`)
  }
  return artifact
}

function factRefsFromExecution(receipt: WorkCaseExecutionReceipt): RuntimeFactRefs {
  return {
    runId: receipt.workspaceRunId,
    workCaseId: receipt.workCaseId,
    evidenceContextId: receipt.evidenceContextId,
    executionRunId: receipt.executionRunId,
    driverId: receipt.driverId,
    executionId: receipt.executionId,
    attemptId: receipt.attemptId,
    ...(receipt.driverSessionId ? { driverSessionId: receipt.driverSessionId } : {}),
    workspaceRunId: receipt.workspaceRunId,
    jobId: receipt.jobId,
    ...(receipt.workflowReceiptRef ? { workflowReceiptRef: receipt.workflowReceiptRef } : {}),
    ...(receipt.workflowArtifactRefs.length > 0 ? { workflowArtifactRefs: [...receipt.workflowArtifactRefs] } : {}),
  }
}

async function writeImmutableJson(path: string, value: unknown, code: string): Promise<boolean> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new InvariantSpineError(code, `Could not retain immutable receipt: ${errorMessage(error)}`)
    }
    const existing = await readFile(path, 'utf-8')
    if (existing !== bytes) {
      throw new InvariantSpineError(code, `Content-addressed receipt path contains different bytes: ${path}`)
    }
    return false
  }
}

function normalizeAdjudicationDisposition(
  value: unknown,
  code = 'ADJUDICATION_INVALID',
): AdjudicationDisposition {
  if (value === 'accept' || value === 'correct' || value === 'reject' || value === 'need_evidence') {
    return value
  }
  throw new InvariantSpineError(code, `Unsupported adjudication disposition: ${String(value)}`)
}

function normalizeDisposition(value: unknown): AdjudicationDisposition {
  return normalizeAdjudicationDisposition(value)
}

function uniqueSortedStrings(values: readonly string[], code: string, field: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InvariantSpineError(code, `${field} must contain at least one reference`)
  }
  return [...new Set(values.map(value => requiredString(value, code, field)))].sort()
}

function uniqueArtifactBindings(bindings: readonly ArtifactContentBinding[]): ArtifactContentBinding[] {
  const byRef = new Map<string, string>()
  for (const binding of bindings) {
    const ref = requiredString(binding.ref, 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH', 'artifact binding ref')
    const digest = normalizeSha256(
      binding.sha256,
      'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
      'artifact binding sha256',
    )
    const existing = byRef.get(ref)
    if (existing && existing !== digest) {
      throw new InvariantSpineError(
        'VERIFIED_OUTCOME_PROVENANCE_MISMATCH',
        `VerifiedOutcome has conflicting content bindings for ${ref}`,
      )
    }
    byRef.set(ref, digest)
  }
  return [...byRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, sha256]) => ({ ref, sha256 }))
}

async function hashArtifactContent(artifact: RunArtifactRecord, code: string): Promise<string> {
  try {
    return sha256(await readFile(resolve(artifact.path)))
  } catch (error) {
    throw new InvariantSpineError(
      code,
      `Could not hash retained artifact content ${artifact.path}: ${errorMessage(error)}`,
    )
  }
}

function normalizeSha256(value: unknown, code: string, field: string): string {
  const digest = requiredString(value, code, field).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new InvariantSpineError(code, `${field} must be a SHA-256 digest`)
  }
  return digest
}

function normalizeTimestamp(value: unknown, code: string, field: string): string {
  const raw = requiredString(value, code, field)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new InvariantSpineError(code, `${field} must be an ISO-compatible timestamp`)
  }
  return parsed.toISOString()
}

function requiredString(value: unknown, code: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvariantSpineError(code, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function assertRecordWithKeys(
  value: unknown,
  allowedKeys: Set<string>,
  code: string,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new InvariantSpineError(code, `${label} must be an object`)
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new InvariantSpineError(code, `${label} has unsupported fields: ${unknownKeys.join(', ')}`)
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'invariant-spine'
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]))
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value) as T
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
