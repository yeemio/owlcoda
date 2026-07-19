import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appServerProjectStatePath } from './project-state-service.js'

export const REVIEW_STATUS_VALUES = [
  'pending',
  'viewed',
  'accepted',
  'rejected',
  'dismissed',
  'applied',
  'reverted',
] as const

export type ReviewStatusValue = typeof REVIEW_STATUS_VALUES[number]
export type ReviewStatusSource = 'derived' | 'stored'

export interface ReviewStatusRecord {
  threadId: string
  diffId: string
  status: ReviewStatusValue
  updatedAt: number
  updatedBy: string
  source: ReviewStatusSource
  note?: string
}

export interface ReviewStatusListInput {
  projectRoot: string
  threadId: string
  diffIds?: string[]
}

export interface ReviewStatusListResult {
  threadId: string
  statuses: ReviewStatusRecord[]
}

export interface ReviewStatusUpdateInput {
  projectRoot: string
  threadId: string
  diffId: string
  status: ReviewStatusValue
  note?: string
  updatedBy?: string
  now?: number
}

export interface ReviewStatusUpdateResult {
  threadId: string
  diffId: string
  status: ReviewStatusRecord
}

interface StoredReviewStatusFile {
  schemaVersion?: string
  records?: unknown[]
}

export function isReviewStatusValue(value: unknown): value is ReviewStatusValue {
  return typeof value === 'string' && REVIEW_STATUS_VALUES.includes(value as ReviewStatusValue)
}

export function defaultReviewStatusStoragePath(projectRoot: string): string {
  return appServerProjectStatePath(projectRoot, 'review-status.json')
}

export function listReviewStatuses(input: ReviewStatusListInput): ReviewStatusListResult {
  const records = loadReviewStatusRecords(defaultReviewStatusStoragePath(input.projectRoot))
  const storedByDiffId = new Map(
    records
      .filter(record => record.threadId === input.threadId)
      .map(record => [record.diffId, record]),
  )

  if (input.diffIds) {
    return {
      threadId: input.threadId,
      statuses: input.diffIds.map(diffId => storedByDiffId.get(diffId) ?? derivedPendingStatus(input.threadId, diffId)),
    }
  }

  return {
    threadId: input.threadId,
    statuses: [...storedByDiffId.values()].sort((left, right) => left.updatedAt - right.updatedAt),
  }
}

export function annotateReviewChanges<T extends { id: string }>(
  input: ReviewStatusListInput & { changes: T[] },
): Array<T & { reviewStatus: ReviewStatusRecord }> {
  const statuses = listReviewStatuses({
    projectRoot: input.projectRoot,
    threadId: input.threadId,
    diffIds: input.changes.map(change => change.id),
  })
  const statusByDiffId = new Map(statuses.statuses.map(status => [status.diffId, status]))
  return input.changes.map(change => ({
    ...change,
    reviewStatus: statusByDiffId.get(change.id) ?? derivedPendingStatus(input.threadId, change.id),
  }))
}

export function updateReviewStatus(input: ReviewStatusUpdateInput): ReviewStatusUpdateResult {
  const storagePath = defaultReviewStatusStoragePath(input.projectRoot)
  const records = loadReviewStatusRecords(storagePath)
  const nextRecord: ReviewStatusRecord = {
    threadId: input.threadId,
    diffId: input.diffId,
    status: input.status,
    updatedAt: input.now ?? Date.now(),
    updatedBy: normalizeString(input.updatedBy) ?? 'app-server',
    source: 'stored',
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
  const nextRecords = records
    .filter(record => !(record.threadId === input.threadId && record.diffId === input.diffId))
    .concat(nextRecord)
  persistReviewStatusRecords(storagePath, nextRecords)

  return {
    threadId: input.threadId,
    diffId: input.diffId,
    status: nextRecord,
  }
}

function derivedPendingStatus(threadId: string, diffId: string): ReviewStatusRecord {
  return {
    threadId,
    diffId,
    status: 'pending',
    updatedAt: 0,
    updatedBy: 'app-server',
    source: 'derived',
  }
}

function loadReviewStatusRecords(storagePath: string): ReviewStatusRecord[] {
  if (!existsSync(storagePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(storagePath, 'utf8')) as StoredReviewStatusFile
    if (!Array.isArray(parsed.records)) return []
    return parsed.records.flatMap(record => parseStoredReviewStatus(record))
  } catch {
    return []
  }
}

function persistReviewStatusRecords(storagePath: string, records: ReviewStatusRecord[]): void {
  mkdirSync(dirname(storagePath), { recursive: true })
  writeFileSync(storagePath, JSON.stringify({
    schemaVersion: 'v0',
    records: records
      .filter(record => record.source === 'stored')
      .sort((left, right) => {
        if (left.threadId !== right.threadId) return left.threadId.localeCompare(right.threadId)
        return left.diffId.localeCompare(right.diffId)
      }),
  }, null, 2))
}

function parseStoredReviewStatus(value: unknown): ReviewStatusRecord[] {
  if (!isRecord(value)) return []
  const threadId = normalizeString(value['threadId'])
  const diffId = normalizeString(value['diffId'])
  const status = value['status']
  const updatedAt = typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0
  const updatedBy = normalizeString(value['updatedBy']) ?? 'app-server'
  if (!threadId || !diffId || !isReviewStatusValue(status)) return []
  return [{
    threadId,
    diffId,
    status,
    updatedAt,
    updatedBy,
    source: 'stored',
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  }]
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
