import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getRunWorkspacePathsFromRef, recordEvent } from './native/run-workspace.js'

export interface StructuredOutputExecutionBudget {
  maxProviderCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxElapsedMs: number
  maxCostUsd?: number
  inputCostPerMillionUsd?: number
  outputCostPerMillionUsd?: number
}

export interface StructuredOutputExecutionCounts {
  providerCalls: number
  parseAttempts: number
  repairAttempts: number
  salvageAttempts: number
  rerunAttempts: number
}

export interface StructuredOutputExecutionTotals extends StructuredOutputExecutionCounts {
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  costUsd: number
}

export type StructuredOutputBudgetDimension =
  | 'provider_calls'
  | 'input_tokens'
  | 'output_tokens'
  | 'elapsed_time'
  | 'cost_usd'

export interface StructuredOutputBudgetStopReceipt {
  type: 'task_budget_exhausted'
  taskId: string
  dimension: StructuredOutputBudgetDimension
  message: string
  checkpointPath: string
  stoppedAt: string
  budget: StructuredOutputExecutionBudget
  cumulative: StructuredOutputExecutionTotals
}

export interface StructuredOutputExecutionReceipt {
  version: 1
  taskId: string
  status: 'active' | 'exhausted'
  budget: StructuredOutputExecutionBudget
  current: StructuredOutputExecutionTotals
  cumulative: StructuredOutputExecutionTotals
  reservation?: {
    id: string
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
  stopReceipt?: StructuredOutputBudgetStopReceipt
}

interface PersistedReservation {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface StructuredOutputExecutionTaskLedger {
  taskId: string
  status: 'active' | 'exhausted'
  budget: StructuredOutputExecutionBudget
  startedAt: string
  updatedAt: string
  cumulative: StructuredOutputExecutionTotals
  reserved: { inputTokens: number; outputTokens: number; costUsd: number }
  reservations: Record<string, PersistedReservation>
  lastStopReceipt?: StructuredOutputBudgetStopReceipt
}

export interface StructuredOutputExecutionLedger {
  version: 1
  updatedAt: string
  tasks: Record<string, StructuredOutputExecutionTaskLedger>
}

export interface StructuredOutputIdempotencyRecord {
  version: 1
  namespace: 'primary' | 'rerun'
  keyHash: string
  requestHash: string
  state: 'reserved' | 'completed'
  reservedAt: string
  completedAt?: string
  status?: number
  body?: Record<string, unknown>
}

export interface StructuredOutputBudgetReservation {
  runRef: string
  taskId: string
  id: string
  appliedMaxTokens: number
  remainingElapsedMs: number
  receipt: StructuredOutputExecutionReceipt
}

export class StructuredOutputBudgetExceededError extends Error {
  readonly code = 'task_budget_exhausted'

  constructor(
    readonly dimension: StructuredOutputBudgetDimension,
    readonly receipt: StructuredOutputExecutionReceipt,
  ) {
    super(receipt.stopReceipt?.message ?? `Task execution budget exhausted: ${dimension}`)
    this.name = 'StructuredOutputBudgetExceededError'
  }
}

export class StructuredOutputBudgetContractMismatchError extends Error {
  readonly code = 'task_budget_contract_mismatch'

  constructor() {
    super('executionBudget must remain identical for the same runRef + taskId')
    this.name = 'StructuredOutputBudgetContractMismatchError'
  }
}

const locks = new Map<string, Promise<void>>()

export async function reserveStructuredOutputBudget(input: {
  runRef: string
  taskId: string
  budget: StructuredOutputExecutionBudget
  requestedMaxTokens: number
  estimatedInputTokens: number
  rerun: boolean
  cwd?: string
}): Promise<StructuredOutputBudgetReservation> {
  const budget = normalizeBudget(input.budget)
  const ledgerPath = executionLedgerPath(input.runRef, input.cwd)
  return withLedgerLock(ledgerPath, async () => {
    const now = new Date()
    const ledger = await loadLedger(ledgerPath)
    const existing = ledger.tasks[input.taskId]
    if (existing && stableJson(existing.budget) !== stableJson(budget)) {
      throw new StructuredOutputBudgetContractMismatchError()
    }
    const task = existing ?? createTaskLedger(input.taskId, budget, now)
    ledger.tasks[input.taskId] = task
    const elapsedMs = Math.max(0, now.getTime() - Date.parse(task.startedAt))
    task.cumulative.elapsedMs = Math.max(task.cumulative.elapsedMs, elapsedMs)

    const deniedDimension = exhaustedDimension(task)
    if (deniedDimension) {
      const stopReceipt = task.lastStopReceipt
        ?? await writeStopReceipt(input.runRef, task, deniedDimension, input.cwd)
      task.status = 'exhausted'
      task.lastStopReceipt = stopReceipt
      task.updatedAt = now.toISOString()
      ledger.updatedAt = task.updatedAt
      await writeLedger(ledgerPath, ledger)
      throw new StructuredOutputBudgetExceededError(deniedDimension, receiptFor(task, zeroTotals(), stopReceipt))
    }

    const estimatedInputTokens = positiveInteger(input.estimatedInputTokens, 'estimatedInputTokens')
    const requestedMaxTokens = positiveInteger(input.requestedMaxTokens, 'requestedMaxTokens')
    const inputRemaining = budget.maxInputTokens - task.cumulative.inputTokens - task.reserved.inputTokens
    if (estimatedInputTokens > inputRemaining) {
      const stopReceipt = await writeStopReceipt(input.runRef, task, 'input_tokens', input.cwd)
      task.status = 'exhausted'
      task.lastStopReceipt = stopReceipt
      ledger.updatedAt = task.updatedAt = now.toISOString()
      await writeLedger(ledgerPath, ledger)
      throw new StructuredOutputBudgetExceededError('input_tokens', receiptFor(task, zeroTotals(), stopReceipt))
    }

    const outputRemaining = budget.maxOutputTokens - task.cumulative.outputTokens - task.reserved.outputTokens
    let appliedMaxTokens = Math.min(requestedMaxTokens, outputRemaining)
    if (appliedMaxTokens <= 0) {
      const stopReceipt = await writeStopReceipt(input.runRef, task, 'output_tokens', input.cwd)
      task.status = 'exhausted'
      task.lastStopReceipt = stopReceipt
      ledger.updatedAt = task.updatedAt = now.toISOString()
      await writeLedger(ledgerPath, ledger)
      throw new StructuredOutputBudgetExceededError('output_tokens', receiptFor(task, zeroTotals(), stopReceipt))
    }

    if (budget.maxCostUsd !== undefined) {
      const inputRate = budget.inputCostPerMillionUsd!
      const outputRate = budget.outputCostPerMillionUsd!
      const costRemaining = budget.maxCostUsd - task.cumulative.costUsd - task.reserved.costUsd
      const inputCost = usdCost(estimatedInputTokens, inputRate)
      const outputAffordable = Math.floor(Math.max(0, costRemaining - inputCost) * 1_000_000 / outputRate)
      appliedMaxTokens = Math.min(appliedMaxTokens, outputAffordable)
      if (appliedMaxTokens <= 0) {
        const stopReceipt = await writeStopReceipt(input.runRef, task, 'cost_usd', input.cwd)
        task.status = 'exhausted'
        task.lastStopReceipt = stopReceipt
        ledger.updatedAt = task.updatedAt = now.toISOString()
        await writeLedger(ledgerPath, ledger)
        throw new StructuredOutputBudgetExceededError('cost_usd', receiptFor(task, zeroTotals(), stopReceipt))
      }
    }

    const reservationId = `reservation-${randomUUID()}`
    const costUsd = budget.maxCostUsd === undefined
      ? 0
      : roundedUsd(
          usdCost(estimatedInputTokens, budget.inputCostPerMillionUsd!)
          + usdCost(appliedMaxTokens, budget.outputCostPerMillionUsd!),
        )
    task.reservations[reservationId] = {
      inputTokens: estimatedInputTokens,
      outputTokens: appliedMaxTokens,
      costUsd,
    }
    task.reserved.inputTokens += estimatedInputTokens
    task.reserved.outputTokens += appliedMaxTokens
    task.reserved.costUsd += costUsd
    task.cumulative.providerCalls += 1
    if (input.rerun) task.cumulative.rerunAttempts += 1
    task.updatedAt = now.toISOString()
    ledger.updatedAt = task.updatedAt
    await writeLedger(ledgerPath, ledger)

    const current = zeroTotals()
    current.providerCalls = 1
    current.rerunAttempts = input.rerun ? 1 : 0
    return {
      runRef: input.runRef,
      taskId: input.taskId,
      id: reservationId,
      appliedMaxTokens,
      remainingElapsedMs: Math.max(1, budget.maxElapsedMs - elapsedMs),
      receipt: {
        ...receiptFor(task, current),
        reservation: { id: reservationId, inputTokens: estimatedInputTokens, outputTokens: appliedMaxTokens, costUsd },
      },
    }
  })
}

export async function settleStructuredOutputBudget(input: {
  reservation: StructuredOutputBudgetReservation
  inputTokens: number
  outputTokens: number
  durationMs: number
  counts: StructuredOutputExecutionCounts
  cwd?: string
}): Promise<StructuredOutputExecutionReceipt> {
  const ledgerPath = executionLedgerPath(input.reservation.runRef, input.cwd)
  return withLedgerLock(ledgerPath, async () => {
    const ledger = await loadLedger(ledgerPath)
    const task = ledger.tasks[input.reservation.taskId]
    const reserved = task?.reservations[input.reservation.id]
    if (!task || !reserved) throw new Error('structured-output budget reservation is missing or already settled')

    task.reserved.inputTokens = Math.max(0, task.reserved.inputTokens - reserved.inputTokens)
    task.reserved.outputTokens = Math.max(0, task.reserved.outputTokens - reserved.outputTokens)
    task.reserved.costUsd = Math.max(0, task.reserved.costUsd - reserved.costUsd)
    delete task.reservations[input.reservation.id]

    const current = zeroTotals()
    current.providerCalls = 1
    current.parseAttempts = nonNegativeInteger(input.counts.parseAttempts)
    current.repairAttempts = nonNegativeInteger(input.counts.repairAttempts)
    current.salvageAttempts = nonNegativeInteger(input.counts.salvageAttempts)
    current.rerunAttempts = nonNegativeInteger(input.counts.rerunAttempts)
    current.inputTokens = nonNegativeInteger(input.inputTokens)
    current.outputTokens = nonNegativeInteger(input.outputTokens)
    current.elapsedMs = nonNegativeInteger(input.durationMs)
    current.costUsd = task.budget.maxCostUsd === undefined
      ? 0
      : roundedUsd(
          usdCost(current.inputTokens, task.budget.inputCostPerMillionUsd!)
          + usdCost(current.outputTokens, task.budget.outputCostPerMillionUsd!),
        )

    task.cumulative.parseAttempts += current.parseAttempts
    task.cumulative.repairAttempts += current.repairAttempts
    task.cumulative.salvageAttempts += current.salvageAttempts
    task.cumulative.inputTokens += current.inputTokens
    task.cumulative.outputTokens += current.outputTokens
    task.cumulative.elapsedMs = Math.max(
      task.cumulative.elapsedMs,
      current.elapsedMs,
      Date.now() - Date.parse(task.startedAt),
    )
    task.cumulative.costUsd += current.costUsd
    task.updatedAt = new Date().toISOString()
    const exhausted = exhaustedDimension(task)
    let stopReceipt: StructuredOutputBudgetStopReceipt | undefined
    if (exhausted) {
      stopReceipt = task.lastStopReceipt ?? await writeStopReceipt(
        input.reservation.runRef,
        task,
        exhausted,
        input.cwd,
      )
      task.status = 'exhausted'
      task.lastStopReceipt = stopReceipt
    }
    ledger.updatedAt = task.updatedAt
    await writeLedger(ledgerPath, ledger)
    return {
      ...receiptFor(task, current, stopReceipt),
      ...(input.reservation.receipt.reservation
        ? { reservation: input.reservation.receipt.reservation }
        : {}),
    }
  })
}

export async function readStructuredOutputExecutionLedger(
  runRef: string,
  cwd?: string,
): Promise<StructuredOutputExecutionLedger> {
  return loadLedger(executionLedgerPath(runRef, cwd))
}

export function resetStructuredOutputExecutionEconomicsForTesting(): void {
  locks.clear()
}

export function validateStructuredOutputExecutionBudget(value: StructuredOutputExecutionBudget): StructuredOutputExecutionBudget {
  return normalizeBudget(value)
}

export function structuredOutputExecutionCounts(
  attempts: Array<{ label: string }>,
  rerun: boolean,
): StructuredOutputExecutionCounts {
  return {
    providerCalls: attempts.some(attempt => attempt.label === 'primary') ? 1 : 0,
    parseAttempts: attempts.some(attempt => ['parse', 'repair', 'salvage'].includes(attempt.label)) ? 1 : 0,
    repairAttempts: attempts.filter(attempt => attempt.label === 'repair').length,
    salvageAttempts: attempts.filter(attempt => attempt.label === 'salvage').length,
    rerunAttempts: rerun ? 1 : 0,
  }
}

export function structuredOutputIdempotencyHash(namespace: 'primary' | 'rerun', request: unknown): string {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return `sha256:${hash(stableJson({ namespace, request }))}`
  const canonical = { ...(request as Record<string, unknown>) }
  delete canonical['idempotencyKey']
  delete canonical['intentionalRepeat']
  return `sha256:${hash(stableJson({ namespace, request: canonical }))}`
}

export async function reserveDurableStructuredOutputIdempotency(input: {
  runRef: string
  namespace: 'primary' | 'rerun'
  key: string
  requestHash: string
  cwd?: string
}): Promise<
  | { kind: 'reserved'; record: StructuredOutputIdempotencyRecord }
  | { kind: 'replay'; record: StructuredOutputIdempotencyRecord }
  | { kind: 'conflict'; record: StructuredOutputIdempotencyRecord }
  | { kind: 'in_progress'; record: StructuredOutputIdempotencyRecord }
> {
  const path = idempotencyRecordPath(input.runRef, input.namespace, input.key, input.cwd)
  return withLedgerLock(path, async () => {
    const existing = await readIdempotencyRecord(path)
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { kind: 'conflict', record: existing }
      if (existing.state === 'completed') return { kind: 'replay', record: existing }
      return { kind: 'in_progress', record: existing }
    }
    const record: StructuredOutputIdempotencyRecord = {
      version: 1,
      namespace: input.namespace,
      keyHash: `sha256:${hash(input.key)}`,
      requestHash: input.requestHash,
      state: 'reserved',
      reservedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(path, record)
    return { kind: 'reserved', record }
  })
}

export async function completeDurableStructuredOutputIdempotency(input: {
  runRef: string
  namespace: 'primary' | 'rerun'
  key: string
  requestHash: string
  status: number
  body: Record<string, unknown>
  cwd?: string
}): Promise<void> {
  const path = idempotencyRecordPath(input.runRef, input.namespace, input.key, input.cwd)
  await withLedgerLock(path, async () => {
    const existing = await readIdempotencyRecord(path)
    if (!existing || existing.requestHash !== input.requestHash) {
      throw new Error('durable idempotency reservation is missing or conflicts with the completed request')
    }
    await writeJsonAtomic(path, {
      ...existing,
      state: 'completed',
      completedAt: new Date().toISOString(),
      status: input.status,
      body: input.body,
    } satisfies StructuredOutputIdempotencyRecord)
  })
}

function executionLedgerPath(runRef: string, cwd?: string): string {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return join(paths.evidenceDir, 'structured-output', 'execution-economics.json')
}

function idempotencyRecordPath(
  runRef: string,
  namespace: 'primary' | 'rerun',
  key: string,
  cwd?: string,
): string {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  return join(
    paths.evidenceDir,
    'structured-output',
    'idempotency',
    `${namespace}-${hash(key).slice(0, 32)}.json`,
  )
}

async function writeStopReceipt(
  runRef: string,
  task: StructuredOutputExecutionTaskLedger,
  dimension: StructuredOutputBudgetDimension,
  cwd?: string,
): Promise<StructuredOutputBudgetStopReceipt> {
  const paths = getRunWorkspacePathsFromRef(runRef, cwd)
  const dir = join(paths.evidenceDir, 'structured-output')
  await mkdir(dir, { recursive: true })
  const checkpointPath = join(dir, `execution-budget-stop-${hash(task.taskId).slice(0, 16)}.json`)
  const receipt: StructuredOutputBudgetStopReceipt = {
    type: 'task_budget_exhausted',
    taskId: task.taskId,
    dimension,
    message: `Task execution budget exhausted: ${dimension}`,
    checkpointPath,
    stoppedAt: new Date().toISOString(),
    budget: task.budget,
    cumulative: { ...task.cumulative },
  }
  await writeFile(checkpointPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await recordEvent(paths.outputRoot, {
    type: 'structured_output_task_budget_exhausted',
    factRefs: { taskId: task.taskId },
    data: receipt as unknown as Record<string, unknown>,
  }, cwd)
  return receipt
}

function exhaustedDimension(task: StructuredOutputExecutionTaskLedger): StructuredOutputBudgetDimension | null {
  const b = task.budget
  if (task.cumulative.providerCalls >= b.maxProviderCalls) return 'provider_calls'
  if (task.cumulative.inputTokens + task.reserved.inputTokens >= b.maxInputTokens) return 'input_tokens'
  if (task.cumulative.outputTokens + task.reserved.outputTokens >= b.maxOutputTokens) return 'output_tokens'
  const elapsed = Math.max(task.cumulative.elapsedMs, Date.now() - Date.parse(task.startedAt))
  if (elapsed >= b.maxElapsedMs) return 'elapsed_time'
  if (b.maxCostUsd !== undefined && task.cumulative.costUsd + task.reserved.costUsd >= b.maxCostUsd) return 'cost_usd'
  return null
}

function createTaskLedger(taskId: string, budget: StructuredOutputExecutionBudget, now: Date): StructuredOutputExecutionTaskLedger {
  return {
    taskId,
    status: 'active',
    budget,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cumulative: zeroTotals(),
    reserved: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    reservations: {},
  }
}

function receiptFor(
  task: StructuredOutputExecutionTaskLedger,
  current: StructuredOutputExecutionTotals,
  stopReceipt?: StructuredOutputBudgetStopReceipt,
): StructuredOutputExecutionReceipt {
  return {
    version: 1,
    taskId: task.taskId,
    status: stopReceipt ? 'exhausted' : task.status,
    budget: task.budget,
    current,
    cumulative: { ...task.cumulative },
    ...(stopReceipt ? { stopReceipt } : {}),
  }
}

function zeroTotals(): StructuredOutputExecutionTotals {
  return {
    providerCalls: 0,
    parseAttempts: 0,
    repairAttempts: 0,
    salvageAttempts: 0,
    rerunAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    costUsd: 0,
  }
}

function normalizeBudget(value: StructuredOutputExecutionBudget): StructuredOutputExecutionBudget {
  const budget: StructuredOutputExecutionBudget = {
    maxProviderCalls: positiveInteger(value.maxProviderCalls, 'executionBudget.maxProviderCalls'),
    maxInputTokens: positiveInteger(value.maxInputTokens, 'executionBudget.maxInputTokens'),
    maxOutputTokens: positiveInteger(value.maxOutputTokens, 'executionBudget.maxOutputTokens'),
    maxElapsedMs: positiveInteger(value.maxElapsedMs, 'executionBudget.maxElapsedMs'),
  }
  if (value.maxCostUsd !== undefined) {
    budget.maxCostUsd = positiveNumber(value.maxCostUsd, 'executionBudget.maxCostUsd')
    budget.inputCostPerMillionUsd = positiveNumber(value.inputCostPerMillionUsd, 'executionBudget.inputCostPerMillionUsd')
    budget.outputCostPerMillionUsd = positiveNumber(value.outputCostPerMillionUsd, 'executionBudget.outputCostPerMillionUsd')
  } else if (value.inputCostPerMillionUsd !== undefined || value.outputCostPerMillionUsd !== undefined) {
    throw new Error('executionBudget pricing requires maxCostUsd')
  }
  return budget
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function nonNegativeInteger(value: unknown): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 0
}

function positiveNumber(value: unknown, name: string): number {
  if (!Number.isFinite(value) || Number(value) <= 0) throw new Error(`${name} must be a positive number`)
  return Number(value)
}

function usdCost(tokens: number, ratePerMillion: number): number {
  return roundedUsd((tokens / 1_000_000) * ratePerMillion)
}

function roundedUsd(value: number): number {
  return Number(value.toFixed(12))
}

async function loadLedger(path: string): Promise<StructuredOutputExecutionLedger> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StructuredOutputExecutionLedger
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { version: 1, updatedAt: new Date().toISOString(), tasks: {} }
  }
}

async function writeLedger(path: string, ledger: StructuredOutputExecutionLedger): Promise<void> {
  await writeJsonAtomic(path, ledger)
}

async function readIdempotencyRecord(path: string): Promise<StructuredOutputIdempotencyRecord | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StructuredOutputIdempotencyRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

async function withLedgerLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => current)
  locks.set(key, queued)
  await previous
  let releaseFileLock: (() => Promise<void>) | undefined
  try {
    releaseFileLock = await acquireFileLock(key)
    return await work()
  } finally {
    try {
      await releaseFileLock?.()
    } finally {
      release()
      if (locks.get(key) === queued) locks.delete(key)
    }
  }
}

async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const lockPath = `${key}.lock`
  await mkdir(dirname(lockPath), { recursive: true })
  const startedAt = Date.now()
  while (true) {
    try {
      await mkdir(lockPath)
      return () => rm(lockPath, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        const lockStat = await stat(lockPath)
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`timed out waiting for structured-output execution lock: ${lockPath}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
