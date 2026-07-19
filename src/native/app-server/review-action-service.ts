import { realpathSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { loadSession, type SessionFile } from '../session.js'
import type { AnthropicContentBlock, AnthropicToolResultBlock, AnthropicToolUseBlock } from '../../types.js'
import { canonicalizeProvenancePath, extractWriteTargets } from '../write-provenance.js'
import type { ExtractedWriteTargetKind } from '../protocol/write-provenance-types.js'
import type { ReviewStatusRecord } from './review-status-service.js'
import {
  listRepositoryUnstagedChanges,
  type RepositoryReviewScope,
  type RepositoryUnstagedChange,
  type ReviewScopeCapabilities,
} from './repository-review-service.js'

export type ReviewOperation =
  | 'update'
  | 'delete'
  | 'create'
  | 'overwrite'
  | 'notebook_replace'
  | 'notebook_insert'
  | 'notebook_delete'
  | ExtractedWriteTargetKind
export type ReviewChangeMode = 'string-replace' | 'full-file' | 'provenance-only'
export type ReviewPreflightStatus = 'ready' | 'already_applied' | 'already_reverted' | 'blocked'
export type BashSourceCaptureStatus = 'pending' | 'captured' | 'partial' | 'unavailable'
export type ReviewPreflightReason =
  | 'source_match'
  | 'already_applied'
  | 'already_reverted'
  | 'source_mismatch'
  | 'path_outside_project'
  | 'file_unreadable'
  | 'unsupported_source'
  | 'provenance_incomplete'

export interface ReviewChange {
  id: string
  threadId: string
  toolUseId: string
  toolName: 'edit' | 'write' | 'NotebookEdit' | 'bash'
  path: string
  operation: ReviewOperation
  mode: ReviewChangeMode
  oldText: string | null
  newText: string
  oldStr?: string
  newStr?: string
  replaceAll: boolean
  diffPreview: string
  hunks?: ReviewHunk[]
  bashProvenance?: BashReviewProvenance
  reviewStatus?: ReviewStatusRecord
}

export interface BashSourceRef {
  sourceRef: string
  path: string
  kind: ReviewOperation
  captureStatus: BashSourceCaptureStatus
  destructive?: boolean
}

export interface BashReviewProvenance {
  commandRef: string
  statusRef: string
  outputRef: string
  sourceCaptureStatus: BashSourceCaptureStatus
  sourceRefs: BashSourceRef[]
}

export interface ReviewHunk {
  hunkId: string
  index: number
  oldText: string
  newText: string
}

export interface ReceiptReviewListResult {
  threadId: string
  changes: ReviewChange[]
  lastTurnChanges: ReviewChange[]
}

export interface ReviewListResult extends ReceiptReviewListResult {
  unstagedChanges: RepositoryUnstagedChange[]
  scopes: {
    unstaged: RepositoryReviewScope
    lastTurn: LastTurnReviewScope
  }
}

export interface LastTurnReviewScope {
  id: 'last_turn'
  source: 'runtime_receipts'
  status: 'ready'
  changeCount: number
  capabilities: ReviewScopeCapabilities
}

export interface ReviewPreflightResult {
  status: ReviewPreflightStatus
  reason: ReviewPreflightReason
  message: string
  change: ReviewChange
}

export interface ReviewActionResult {
  status: 'applied' | 'reverted' | ReviewPreflightStatus
  reason: ReviewPreflightReason
  message: string
  change: ReviewChange
  preflight: ReviewPreflightResult
}

export interface ReviewHunkProof {
  proofId: string
  kind: 'review_hunk_action'
  source: 'app-server-review-center'
  status: 'applied' | 'reverted' | 'blocked'
  action: 'apply' | 'revert'
  threadId: string
  diffId: string
  hunkId: string
  path: string
}

export interface ReviewHunkActionResult {
  status: 'applied' | 'reverted' | ReviewPreflightStatus
  reason: ReviewPreflightReason
  message: string
  threadId: string
  diffId: string
  hunkId: string
  change: ReviewChange
  hunk?: ReviewHunk
  preflight: ReviewPreflightResult
  proof: ReviewHunkProof
  reviewStatus?: ReviewStatusRecord
}

export interface ReviewBatchPreflightResult {
  status: 'ready' | 'blocked'
  threadId: string
  diffIds: string[]
  preflights: ReviewPreflightResult[]
  blocked: ReviewPreflightResult[]
}

export interface ReviewBatchTransactionFailure {
  diffId: string
  path: string
  message: string
}

export interface ReviewBatchTransaction {
  transactionId: string
  action: 'apply' | 'revert'
  applied: string[]
  rolledBack: string[]
  failed: ReviewBatchTransactionFailure[]
  rollbackFailed: ReviewBatchTransactionFailure[]
}

export interface ReviewBatchProof {
  proofId: string
  kind: 'review_batch_transaction'
  source: 'app-server-review-center'
  status: 'applied' | 'reverted' | 'blocked' | 'rolled_back' | 'rollback_failed'
  action: 'apply' | 'revert'
  threadId: string
  diffIds: string[]
  transactionId: string
  applied: string[]
  rolledBack: string[]
  failed: ReviewBatchTransactionFailure[]
  rollbackFailed: ReviewBatchTransactionFailure[]
}

export interface ReviewBatchActionResult {
  status: 'applied' | 'reverted' | 'blocked' | 'failed'
  reason: 'source_match' | 'batch_preflight_blocked' | 'batch_transaction_failed'
  message: string
  threadId: string
  diffIds: string[]
  preflight: ReviewBatchPreflightResult
  results: ReviewActionResult[]
  transaction: ReviewBatchTransaction
  proof: ReviewBatchProof
}

export interface ReviewServiceInput {
  projectRoot: string
  threadId: string
}

export interface ReviewChangeInput extends ReviewServiceInput {
  diffId: string
}

export interface ReviewHunkInput extends ReviewChangeInput {
  hunkId: string
}

export interface ReviewBatchInput extends ReviewServiceInput {
  diffIds: string[]
}

export function listReviewChanges(input: ReviewServiceInput): ReceiptReviewListResult | null {
  const session = loadReviewSession(input)
  if (!session) return null
  const changes = extractReviewChanges(session, input.projectRoot)
  const lastTurnToolUseIds = collectLastTurnToolUseIds(session)
  const lastTurnChanges = changes.filter(change => lastTurnToolUseIds.has(change.toolUseId))
  return {
    threadId: session.id,
    changes,
    lastTurnChanges,
  }
}

export function listReviewChangesWithRepository(input: ReviewServiceInput): ReviewListResult | null {
  const receiptChanges = listReviewChanges(input)
  if (!receiptChanges) return null
  const repository = listRepositoryUnstagedChanges({ projectRoot: input.projectRoot })
  return {
    ...receiptChanges,
    unstagedChanges: repository.changes,
    scopes: {
      unstaged: repository.scope,
      lastTurn: {
        id: 'last_turn',
        source: 'runtime_receipts',
        status: 'ready',
        changeCount: receiptChanges.lastTurnChanges.length,
        capabilities: {
          read: true,
          stage: false,
          unstage: false,
          apply: true,
          revert: true,
          hunkApply: true,
          hunkRevert: true,
        },
      },
    },
  }
}

function collectLastTurnToolUseIds(session: SessionFile): Set<string> {
  let lastPromptIndex = -1
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index]!
    if (turn.role === 'user' && turn.content.some(block => block.type === 'text')) {
      lastPromptIndex = index
      break
    }
  }
  const turns = lastPromptIndex === -1 ? session.turns : session.turns.slice(lastPromptIndex + 1)
  return new Set(turns.flatMap(turn => turn.role === 'assistant'
    ? turn.content.filter(isToolUseBlock).map(block => block.id)
    : []))
}

export async function preflightReviewChange(input: ReviewChangeInput): Promise<ReviewPreflightResult | null> {
  const change = findReviewChange(input)
  if (!change) return null
  return preflightChange(input.projectRoot, change, 'apply')
}

export async function batchPreflightReviewChanges(
  input: ReviewBatchInput,
  direction: 'apply' | 'revert' = 'apply',
): Promise<ReviewBatchPreflightResult | null> {
  const listed = listReviewChanges(input)
  if (!listed) return null
  const changesById = new Map(listed.changes.map(change => [change.id, change]))
  const preflights: ReviewPreflightResult[] = []
  for (const diffId of input.diffIds) {
    const change = changesById.get(diffId)
    if (!change) return null
    preflights.push(await preflightChange(input.projectRoot, change, direction))
  }
  const blocked = preflights.filter(preflight => !isBatchActionReady(preflight, direction))
  return {
    status: blocked.length === 0 ? 'ready' : 'blocked',
    threadId: listed.threadId,
    diffIds: [...input.diffIds],
    preflights,
    blocked,
  }
}

export async function batchApplyReviewChanges(input: ReviewBatchInput): Promise<ReviewBatchActionResult | null> {
  return executeReviewBatch(input, 'apply')
}

export async function batchRevertReviewChanges(input: ReviewBatchInput): Promise<ReviewBatchActionResult | null> {
  return executeReviewBatch(input, 'revert')
}

export async function applyReviewChange(input: ReviewChangeInput): Promise<ReviewActionResult | null> {
  const change = findReviewChange(input)
  if (!change) return null
  const preflight = await preflightChange(input.projectRoot, change, 'apply')
  if (preflight.status !== 'ready') {
    return {
      status: preflight.status,
      reason: preflight.reason,
      message: preflight.message,
      change,
      preflight,
    }
  }
  await applyChange(change, 'apply')
  return {
    status: 'applied',
    reason: 'source_match',
    message: `Applied review change ${change.id}`,
    change,
    preflight,
  }
}

export async function revertReviewChange(input: ReviewChangeInput): Promise<ReviewActionResult | null> {
  const change = findReviewChange(input)
  if (!change) return null
  const preflight = await preflightChange(input.projectRoot, change, 'revert')
  if (preflight.status !== 'ready') {
    return {
      status: preflight.status,
      reason: preflight.reason,
      message: preflight.message,
      change,
      preflight,
    }
  }
  await applyChange(change, 'revert')
  return {
    status: 'reverted',
    reason: 'source_match',
    message: `Reverted review change ${change.id}`,
    change,
    preflight,
  }
}

export async function applyReviewHunk(input: ReviewHunkInput): Promise<ReviewHunkActionResult | null> {
  return executeReviewHunk(input, 'apply')
}

export async function revertReviewHunk(input: ReviewHunkInput): Promise<ReviewHunkActionResult | null> {
  return executeReviewHunk(input, 'revert')
}

function findReviewChange(input: ReviewChangeInput): ReviewChange | null {
  const listed = listReviewChanges(input)
  return listed?.changes.find(change => change.id === input.diffId) ?? null
}

async function executeReviewHunk(
  input: ReviewHunkInput,
  direction: 'apply' | 'revert',
): Promise<ReviewHunkActionResult | null> {
  const change = findReviewChange(input)
  if (!change) return null
  const hunk = change.hunks?.find(item => item.hunkId === input.hunkId)
  if (!hunk) {
    return blockedHunkAction(input, change, direction, 'unsupported_source', `Review change ${change.id} does not expose hunk ${input.hunkId}`)
  }

  const hunkChange = changeForHunk(change, hunk)
  const preflight = await preflightChange(input.projectRoot, hunkChange, direction)
  if (preflight.status !== 'ready') {
    const proofStatus = preflight.status === 'already_applied'
      ? 'applied'
      : preflight.status === 'already_reverted' ? 'reverted' : 'blocked'
    return {
      status: preflight.status,
      reason: preflight.reason,
      message: preflight.message,
      threadId: change.threadId,
      diffId: change.id,
      hunkId: hunk.hunkId,
      change,
      hunk,
      preflight,
      proof: buildReviewHunkProof(change, hunk.hunkId, direction, proofStatus),
    }
  }

  await applyChange(hunkChange, direction)
  const status = direction === 'apply' ? 'applied' : 'reverted'
  return {
    status,
    reason: 'source_match',
    message: `${direction === 'apply' ? 'Applied' : 'Reverted'} review hunk ${hunk.hunkId} for ${change.id}`,
    threadId: change.threadId,
    diffId: change.id,
    hunkId: hunk.hunkId,
    change,
    hunk,
    preflight,
    proof: buildReviewHunkProof(change, hunk.hunkId, direction, status),
  }
}

function blockedHunkAction(
  input: ReviewHunkInput,
  change: ReviewChange,
  direction: 'apply' | 'revert',
  reason: ReviewPreflightReason,
  message: string,
): ReviewHunkActionResult {
  const preflight = blocked(change, reason, message)
  return {
    status: 'blocked',
    reason,
    message,
    threadId: change.threadId,
    diffId: change.id,
    hunkId: input.hunkId,
    change,
    preflight,
    proof: buildReviewHunkProof(change, input.hunkId, direction, 'blocked'),
  }
}

function changeForHunk(change: ReviewChange, hunk: ReviewHunk): ReviewChange {
  return {
    ...change,
    id: `${change.id}#${hunk.hunkId}`,
    oldText: hunk.oldText,
    newText: hunk.newText,
    replaceAll: false,
    diffPreview: buildDiffPreview(change.path, hunk.oldText, hunk.newText),
    hunks: [hunk],
  }
}

function buildReviewHunkProof(
  change: ReviewChange,
  hunkId: string,
  action: 'apply' | 'revert',
  status: ReviewHunkProof['status'],
): ReviewHunkProof {
  return {
    proofId: `review-hunk:${change.threadId}:${change.id}:${hunkId}:${action}`,
    kind: 'review_hunk_action',
    source: 'app-server-review-center',
    status,
    action,
    threadId: change.threadId,
    diffId: change.id,
    hunkId,
    path: change.path,
  }
}

async function executeReviewBatch(
  input: ReviewBatchInput,
  direction: 'apply' | 'revert',
): Promise<ReviewBatchActionResult | null> {
  const preflight = await batchPreflightReviewChanges(input, direction)
  if (!preflight) return null
  const transaction = createReviewBatchTransaction(preflight, direction)
  if (preflight.status !== 'ready') {
    return {
      status: 'blocked',
      reason: 'batch_preflight_blocked',
      message: `Review batch ${direction} blocked by preflight`,
      threadId: preflight.threadId,
      diffIds: preflight.diffIds,
      preflight,
      results: [],
      transaction,
      proof: buildReviewBatchProof(preflight, direction, transaction, 'blocked'),
    }
  }

  const results: ReviewActionResult[] = []
  const rollbackStack: ReviewPreflightResult[] = []
  for (const item of preflight.preflights) {
    const settledStatus = direction === 'apply' ? 'already_applied' : 'already_reverted'
    if (item.status === settledStatus) {
      transaction.applied.push(item.change.id)
      results.push({
        status: item.status,
        reason: item.reason,
        message: item.message,
        change: item.change,
        preflight: item,
      })
      continue
    }
    try {
      await applyChange(item.change, direction)
    } catch (error) {
      transaction.failed.push(reviewBatchFailure(item.change, error))
      await rollbackReviewBatch({
        direction,
        transaction,
        rollbackStack,
      })
      const proofStatus = transaction.rollbackFailed.length > 0 ? 'rollback_failed' : 'rolled_back'
      return {
        status: 'failed',
        reason: 'batch_transaction_failed',
        message: reviewBatchFailureMessage(direction, item.change.id, transaction),
        threadId: preflight.threadId,
        diffIds: preflight.diffIds,
        preflight,
        results,
        transaction,
        proof: buildReviewBatchProof(preflight, direction, transaction, proofStatus),
      }
    }
    transaction.applied.push(item.change.id)
    rollbackStack.push(item)
    results.push({
      status: direction === 'apply' ? 'applied' : 'reverted',
      reason: 'source_match',
      message: `${direction === 'apply' ? 'Applied' : 'Reverted'} review change ${item.change.id}`,
      change: item.change,
      preflight: item,
    })
  }

  return {
    status: direction === 'apply' ? 'applied' : 'reverted',
    reason: 'source_match',
    message: `${direction === 'apply' ? 'Applied' : 'Reverted'} ${results.length} review changes`,
    threadId: preflight.threadId,
    diffIds: preflight.diffIds,
    preflight,
    results,
    transaction,
    proof: buildReviewBatchProof(preflight, direction, transaction, direction === 'apply' ? 'applied' : 'reverted'),
  }
}

function createReviewBatchTransaction(
  preflight: ReviewBatchPreflightResult,
  direction: 'apply' | 'revert',
): ReviewBatchTransaction {
  return {
    transactionId: `review-batch:${preflight.threadId}:${direction}:${preflight.diffIds.join(',')}`,
    action: direction,
    applied: [],
    rolledBack: [],
    failed: [],
    rollbackFailed: [],
  }
}

function buildReviewBatchProof(
  preflight: ReviewBatchPreflightResult,
  direction: 'apply' | 'revert',
  transaction: ReviewBatchTransaction,
  status: ReviewBatchProof['status'],
): ReviewBatchProof {
  return {
    proofId: `review-batch-proof:${transaction.transactionId}`,
    kind: 'review_batch_transaction',
    source: 'app-server-review-center',
    status,
    action: direction,
    threadId: preflight.threadId,
    diffIds: preflight.diffIds,
    transactionId: transaction.transactionId,
    applied: [...transaction.applied],
    rolledBack: [...transaction.rolledBack],
    failed: [...transaction.failed],
    rollbackFailed: [...transaction.rollbackFailed],
  }
}

async function rollbackReviewBatch(input: {
  direction: 'apply' | 'revert'
  transaction: ReviewBatchTransaction
  rollbackStack: ReviewPreflightResult[]
}): Promise<void> {
  const rollbackDirection = input.direction === 'apply' ? 'revert' : 'apply'
  for (const item of [...input.rollbackStack].reverse()) {
    try {
      await applyChange(item.change, rollbackDirection)
      input.transaction.rolledBack.push(item.change.id)
    } catch (error) {
      input.transaction.rollbackFailed.push(reviewBatchFailure(item.change, error))
    }
  }
}

function reviewBatchFailure(change: ReviewChange, error: unknown): ReviewBatchTransactionFailure {
  return {
    diffId: change.id,
    path: change.path,
    message: error instanceof Error ? error.message : 'review batch write failed',
  }
}

function reviewBatchFailureMessage(
  direction: 'apply' | 'revert',
  diffId: string,
  transaction: ReviewBatchTransaction,
): string {
  const verb = direction === 'apply' ? 'apply' : 'revert'
  if (transaction.rollbackFailed.length > 0) {
    return `Review batch ${verb} failed at ${diffId}; rollback failed for ${transaction.rollbackFailed.length} change(s)`
  }
  return `Review batch ${verb} failed at ${diffId}; rolled back ${transaction.rolledBack.length} change(s)`
}

function isBatchActionReady(preflight: ReviewPreflightResult, direction: 'apply' | 'revert'): boolean {
  if (preflight.status === 'ready') return true
  if (direction === 'apply') return preflight.status === 'already_applied'
  return preflight.status === 'already_reverted'
}

async function preflightChange(
  projectRoot: string,
  change: ReviewChange,
  direction: 'apply' | 'revert',
): Promise<ReviewPreflightResult> {
  if (!isInsideRoot(projectRoot, change.path)) {
    return blocked(change, 'path_outside_project', `Review change ${change.id} targets a path outside the project root`)
  }
  if (change.mode === 'provenance-only') {
    return blocked(
      change,
      'provenance_incomplete',
      `Review change ${change.id} has bash write provenance but no captured old/new source`,
    )
  }

  const source = direction === 'apply' ? change.oldText : change.newText
  const target = direction === 'apply' ? change.newText : change.oldText
  if (source === '') {
    return blocked(change, 'unsupported_source', `Review change ${change.id} has no ${direction} source text`)
  }

  const current = await readCurrentFile(change.path)
  if (!current.ok) {
    if (current.missing && source === null) {
      return {
        status: 'ready',
        reason: 'source_match',
        message: `Review change ${change.id} is ready to ${direction}`,
        change,
      }
    }
    if (current.missing && target === null) {
      const status = direction === 'apply' ? 'already_applied' : 'already_reverted'
      return {
        status,
        reason: status,
        message: `Review change ${change.id} is ${status.replace('_', ' ')}`,
        change,
      }
    }
    return blocked(change, 'file_unreadable', `Review change ${change.id} cannot read ${change.path}: ${current.message}`)
  }

  if (matchesSource(current.content, source, change)) {
    return {
      status: 'ready',
      reason: 'source_match',
      message: `Review change ${change.id} is ready to ${direction}`,
      change,
    }
  }

  if (matchesTarget(current.content, target, change)) {
    const status = direction === 'apply' ? 'already_applied' : 'already_reverted'
    const reason = status
    return {
      status,
      reason,
      message: `Review change ${change.id} is ${status.replace('_', ' ')}`,
      change,
    }
  }

  return blocked(change, 'source_mismatch', `Review change ${change.id} source text no longer matches ${change.path}`)
}

function extractReviewChanges(session: SessionFile, projectRoot: string): ReviewChange[] {
  const successfulToolResults = collectSuccessfulToolResults(session.turns.flatMap(turn => turn.content))
  const changes: ReviewChange[] = []
  for (const turn of session.turns) {
    if (turn.role !== 'assistant') continue
    for (const block of turn.content) {
      if (!isToolUseBlock(block) || !successfulToolResults.has(block.id)) continue
      const metadata = successfulToolResults.get(block.id)
      if (block.name === 'bash') {
        changes.push(...changesFromBashToolUse(session, projectRoot, block, metadata))
        continue
      }
      const change = changeFromToolUse(session, projectRoot, block, metadata)
      if (change) changes.push(change)
    }
  }
  return changes
}

function changeFromToolUse(
  session: SessionFile,
  projectRoot: string,
  block: AnthropicToolUseBlock,
  metadata: Record<string, unknown> | undefined,
): ReviewChange | null {
  if (block.name === 'edit') return changeFromEditToolUse(session, projectRoot, block)
  if (block.name === 'write') return changeFromWriteToolUse(session, projectRoot, block, metadata)
  if (block.name === 'NotebookEdit') return changeFromNotebookEditToolUse(session, projectRoot, block, metadata)
  return null
}

function changeFromEditToolUse(
  session: SessionFile,
  projectRoot: string,
  block: AnthropicToolUseBlock,
): ReviewChange | null {
  const path = stringField(block.input, 'path')
  const oldStr = stringField(block.input, 'oldStr')
  const newStr = stringField(block.input, 'newStr')
  if (!path || oldStr === null || newStr === null) return null
  const resolvedPath = isAbsolute(path)
    ? resolve(path)
    : resolve(session.cwd ?? projectRoot, path)
  return withReviewHunks({
    id: `edit:${block.id}`,
    threadId: session.id,
    toolUseId: block.id,
    toolName: 'edit',
    path: resolvedPath,
    operation: newStr === '' ? 'delete' : 'update',
    mode: 'string-replace',
    oldText: oldStr,
    newText: newStr,
    oldStr,
    newStr,
    replaceAll: block.input['replaceAll'] === true,
    diffPreview: buildDiffPreview(resolvedPath, oldStr, newStr),
  })
}

function changeFromWriteToolUse(
  session: SessionFile,
  projectRoot: string,
  block: AnthropicToolUseBlock,
  metadata: Record<string, unknown> | undefined,
): ReviewChange | null {
  const path = stringField(block.input, 'path')
  const newContent = stringField(block.input, 'content')
  if (!path || newContent === null) return null
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, 'oldContent')) return null
  const oldContent = nullableStringField(metadata, 'oldContent')
  const metadataNewContent = stringField(metadata, 'newContent')
  const resolvedPath = isAbsolute(path)
    ? resolve(path)
    : resolve(session.cwd ?? projectRoot, path)
  const newText = metadataNewContent ?? newContent
  return {
    id: `write:${block.id}`,
    threadId: session.id,
    toolUseId: block.id,
    toolName: 'write',
    path: resolvedPath,
    operation: oldContent === null ? 'create' : 'overwrite',
    mode: 'full-file',
    oldText: oldContent,
    newText,
    replaceAll: false,
    diffPreview: buildDiffPreview(resolvedPath, oldContent ?? '', newText),
  }
}

function changeFromNotebookEditToolUse(
  session: SessionFile,
  projectRoot: string,
  block: AnthropicToolUseBlock,
  metadata: Record<string, unknown> | undefined,
): ReviewChange | null {
  const path = stringField(block.input, 'notebook_path') ?? stringField(metadata ?? {}, 'notebook_path')
  if (!path || !metadata) return null
  const oldContent = stringField(metadata, 'oldContent')
  const newContent = stringField(metadata, 'newContent')
  if (oldContent === null || newContent === null) return null
  const resolvedPath = isAbsolute(path)
    ? resolve(path)
    : resolve(session.cwd ?? projectRoot, path)
  return {
    id: `NotebookEdit:${block.id}`,
    threadId: session.id,
    toolUseId: block.id,
    toolName: 'NotebookEdit',
    path: resolvedPath,
    operation: notebookOperation(metadata, block.input),
    mode: 'full-file',
    oldText: oldContent,
    newText: newContent,
    replaceAll: false,
    diffPreview: buildDiffPreview(resolvedPath, oldContent, newContent),
  }
}

function notebookOperation(
  metadata: Record<string, unknown>,
  input: Record<string, unknown>,
): Extract<ReviewOperation, `notebook_${string}`> {
  const changeKind = stringField(metadata, 'changeKind')
  if (changeKind === 'notebook_replace' || changeKind === 'notebook_insert' || changeKind === 'notebook_delete') {
    return changeKind
  }
  const editMode = stringField(input, 'edit_mode') ?? stringField(metadata, 'edit_mode') ?? 'replace'
  if (editMode === 'insert') return 'notebook_insert'
  if (editMode === 'delete') return 'notebook_delete'
  return 'notebook_replace'
}

function changesFromBashToolUse(
  session: SessionFile,
  projectRoot: string,
  block: AnthropicToolUseBlock,
  metadata: Record<string, unknown> | undefined,
): ReviewChange[] {
  const cwd = resolveBashCwd(session, projectRoot, block.input)
  const capturesByPath = bashWriteCapturesByPath(metadata, cwd)
  return extractWriteTargets('bash', block.input, cwd).map((target, index) => {
    const capture = capturesByPath.get(target.path)
    const captureStatus: BashSourceCaptureStatus = capture ? 'captured' : 'unavailable'
    const bashProvenance = bashReviewProvenance({
      threadId: session.id,
      toolUseId: block.id,
      target,
      index,
      captureStatus,
    })
    if (capture) {
      return {
        id: `bash:${block.id}:${index}`,
        threadId: session.id,
        toolUseId: block.id,
        toolName: 'bash',
        path: target.path,
        operation: target.kind,
        mode: 'full-file',
        oldText: capture.oldContent,
        newText: capture.newContent,
        replaceAll: false,
        diffPreview: buildDiffPreview(target.path, capture.oldContent ?? '', capture.newContent),
        bashProvenance,
      }
    }
    return {
      id: `bash:${block.id}:${index}`,
      threadId: session.id,
      toolUseId: block.id,
      toolName: 'bash',
      path: target.path,
      operation: target.kind,
      mode: 'provenance-only',
      oldText: null,
      newText: '',
      replaceAll: false,
      diffPreview: [
        `--- ${target.path}`,
        `+++ ${target.path}`,
        '@@',
        `# bash ${target.kind}${target.destructive ? ' destructive' : ''}`,
        `# source capture unavailable`,
      ].join('\n'),
      bashProvenance,
    }
  })
}

function bashReviewProvenance(input: {
  threadId: string
  toolUseId: string
  target: ReturnType<typeof extractWriteTargets>[number]
  index: number
  captureStatus: BashSourceCaptureStatus
}): BashReviewProvenance {
  return {
    commandRef: `command:${input.threadId}:${input.toolUseId}`,
    statusRef: `command-status:${input.threadId}:${input.toolUseId}`,
    outputRef: `command-output:${input.threadId}:${input.toolUseId}`,
    sourceCaptureStatus: input.captureStatus,
    sourceRefs: [{
      sourceRef: `bash-source:${input.threadId}:${input.toolUseId}:${input.index}`,
      path: input.target.path,
      kind: input.target.kind,
      captureStatus: input.captureStatus,
      ...(input.target.destructive ? { destructive: true } : {}),
    }],
  }
}

interface BashWriteCaptureMetadata {
  oldContent: string | null
  newContent: string
}

function bashWriteCapturesByPath(
  metadata: Record<string, unknown> | undefined,
  cwd: string,
): Map<string, BashWriteCaptureMetadata> {
  const captures = new Map<string, BashWriteCaptureMetadata>()
  const rawCaptures = metadata?.['writeCaptures']
  if (!Array.isArray(rawCaptures)) return captures
  for (const rawCapture of rawCaptures) {
    if (!isRecord(rawCapture)) continue
    const path = stringField(rawCapture, 'path')
    const newContent = stringField(rawCapture, 'newContent')
    if (!path || newContent === null) continue
    const oldContent = Object.prototype.hasOwnProperty.call(rawCapture, 'oldContent')
      ? nullableStringField(rawCapture, 'oldContent')
      : null
    captures.set(canonicalizeProvenancePath(path, cwd), {
      oldContent,
      newContent,
    })
  }
  return captures
}

function resolveBashCwd(
  session: SessionFile,
  projectRoot: string,
  input: Record<string, unknown>,
): string {
  const sessionCwd = session.cwd ?? projectRoot
  const cwd = stringField(input, 'cwd')
  if (!cwd) return sessionCwd
  return isAbsolute(cwd) ? resolve(cwd) : resolve(sessionCwd, cwd)
}

function collectSuccessfulToolResults(blocks: AnthropicContentBlock[]): Map<string, Record<string, unknown> | undefined> {
  const results = new Map<string, Record<string, unknown> | undefined>()
  for (const block of blocks) {
    if (isToolResultBlock(block) && block.is_error !== true) {
      results.set(block.tool_use_id, block.metadata)
    }
  }
  return results
}

function loadReviewSession(input: ReviewServiceInput): SessionFile | null {
  const session = loadSession(input.threadId)
  if (!session) return null
  const root = canonicalExistingPath(input.projectRoot)
  const cwd = session.cwd ? canonicalExistingPath(session.cwd) : root
  if (cwd !== root) return null
  return session
}

function replaceContent(content: string, oldStr: string, newStr: string, replaceAll: boolean): string {
  return replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr)
}

function withReviewHunks(change: ReviewChange): ReviewChange {
  const hunks = deriveReviewHunks(change)
  return hunks.length > 0 ? { ...change, hunks } : change
}

function deriveReviewHunks(change: ReviewChange): ReviewHunk[] {
  if (change.mode !== 'string-replace' || change.oldText === null) return []
  const oldLines = change.oldText.split('\n')
  const newLines = change.newText.split('\n')
  if (oldLines.length !== newLines.length) return []
  return oldLines.map((oldText, index) => ({
    hunkId: `hunk:${index}`,
    index,
    oldText,
    newText: newLines[index] ?? '',
  }))
}

async function applyChange(change: ReviewChange, direction: 'apply' | 'revert'): Promise<void> {
  const source = direction === 'apply' ? change.oldText : change.newText
  const target = direction === 'apply' ? change.newText : change.oldText
  if (change.mode === 'full-file') {
    if (target === null) {
      await rm(change.path, { force: true })
      return
    }
    await writeFile(change.path, target, 'utf8')
    return
  }
  if (source === null || target === null) return
  const content = await readFile(change.path, 'utf8')
  await writeFile(change.path, replaceContent(content, source, target, change.replaceAll), 'utf8')
}

function matchesSource(content: string, source: string | null, change: ReviewChange): boolean {
  if (source === null) return false
  if (change.mode === 'full-file') return content === source
  const occurrences = countOccurrences(content, source)
  return change.replaceAll ? occurrences > 0 : occurrences === 1
}

function matchesTarget(content: string, target: string | null, change: ReviewChange): boolean {
  if (target === null) return false
  if (change.mode === 'full-file') return content === target
  return target ? countOccurrences(content, target) > 0 : false
}

async function readCurrentFile(path: string): Promise<
  | { ok: true; content: string }
  | { ok: false; missing: boolean; message: string }
> {
  try {
    return { ok: true, content: await readFile(path, 'utf8') }
  } catch (error) {
    return {
      ok: false,
      missing: isNodeErrorCode(error, 'ENOENT'),
      message: error instanceof Error ? error.message : 'file is not readable',
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while (needle && pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count += 1
    pos = idx + needle.length
  }
  return count
}

function buildDiffPreview(path: string, oldStr: string, newStr: string): string {
  return [
    `--- ${path}`,
    `+++ ${path}`,
    '@@',
    ...oldStr.split('\n').map(line => `-${line}`),
    ...newStr.split('\n').map(line => `+${line}`),
  ].join('\n')
}

function blocked(change: ReviewChange, reason: ReviewPreflightReason, message: string): ReviewPreflightResult {
  return {
    status: 'blocked',
    reason,
    message,
    change,
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const canonicalRoot = canonicalExistingPath(root)
  const canonicalTarget = canonicalizeProvenancePath(target, canonicalRoot)
  const rel = relative(canonicalRoot, canonicalTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

function nullableStringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  if (value === null) return null
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: AnthropicContentBlock): block is AnthropicToolResultBlock {
  return block.type === 'tool_result'
}
