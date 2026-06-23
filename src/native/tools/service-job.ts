import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import {
  addJobArtifacts,
  appendJobOutput,
  createJob,
  finishJob,
  getJob,
  recordJobCleanup,
  registerJobAbortAdapter,
  startJob,
  unregisterJobAbortAdapter,
} from '../job-supervisor.js'
import type { JobRecord, JobStatus } from '../job-supervisor.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface ServiceJobInput {
  action: string
  serviceName: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  port?: number
  healthUrl?: string
  artifactDir?: string
  deadlineMs?: number
  gracefulStopMs?: number
}

interface LiveService {
  serviceName: string
  jobId: string
  child: ServiceChildProcess
  logStream: WriteStream
  command: string
  args: string[]
  env?: Record<string, string>
  cwd: string
  port?: number
  healthUrl?: string
  stopping: boolean
}

const DEFAULT_DEADLINE_MS = 30_000
const MAX_DEADLINE_MS = 120_000
const DEFAULT_GRACEFUL_STOP_MS = 3_000
const MAX_GRACEFUL_STOP_MS = 30_000
const SERVICE_ACTIONS = new Set(['start', 'status', 'stop', 'restart'])
const liveServices = new Map<string, LiveService>()
type ServiceChildProcess = ChildProcessByStdio<null, Readable, Readable>

export function createServiceJobTool(): NativeToolDef<ServiceJobInput> {
  return {
    name: 'ServiceJob',
    description:
      'Manage a local dev service through the platform job supervisor. ' +
      'Starts a process without shell interpolation, waits for health, records PID/port/log artifacts, and stops gracefully before escalation.',
    maturity: 'beta',

    async execute(input: ServiceJobInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const action = normalizeAction(input?.action)
      const validation = validateInput(input, action)
      if (validation) return validation

      if (action === 'status') return await statusService(input)
      if (action === 'stop') return await stopService(input)
      if (action === 'restart') return await restartService(input, context)
      return await startService(input, context)
    },
  }
}

async function startService(input: ServiceJobInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const serviceName = input.serviceName.trim()
  const existing = liveServices.get(serviceName)
  if (existing && isChildRunning(existing.child)) {
    const job = getJob(existing.jobId)
    return {
      output: `Service job already running: ${serviceName}`,
      isError: true,
      metadata: job ? { job } : { serviceName },
    }
  }

  const command = input.command!.trim()
  const args = input.args ?? []
  const cwd = input.cwd?.trim() ? resolve(input.cwd) : process.cwd()
  const deadlineMs = clampDeadline(input.deadlineMs)
  const commandLine = formatCommand(command, args)
  const externalHandle = input.port !== undefined ? `127.0.0.1:${input.port}` : undefined
  const created = createJob({
    type: 'service',
    stage: 'queued',
    cwd,
    tool: 'ServiceJob',
    provider: 'process',
    command: commandLine,
    deadlineMs,
    recoveryHint: `ServiceJob action=status serviceName=${serviceName} or JobGet jobId=<jobId>`,
  })
  const jobId = created.jobId
  const artifactRoot = resolve(cwd, input.artifactDir?.trim() || '.owlcoda-service-jobs')
  const logDir = resolve(artifactRoot, sanitizePathSegment(jobId))
  await mkdir(logDir, { recursive: true })
  const logPath = resolve(logDir, 'service.log')
  addJobArtifacts(jobId, [{ path: logPath, artifactType: 'service_log' }])

  const logStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const spawnErrorWatcher = createSpawnErrorWatcher(child)

  const entry: LiveService = {
    serviceName,
    jobId,
    child,
    logStream,
    command,
    args,
    ...(input.env ? { env: input.env } : {}),
    cwd,
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.healthUrl?.trim() ? { healthUrl: input.healthUrl.trim() } : {}),
    stopping: false,
  }
  liveServices.set(serviceName, entry)
  wireProcessOutput(entry)
  wireUnexpectedExit(entry)
  registerJobAbortAdapter(jobId, (reason) => {
    void stopLiveService(entry, {
      status: 'cancelled',
      stage: 'stopped',
      terminationReason: reason || 'user_cancel',
      gracefulStopMs: clampGracefulStop(input.gracefulStopMs),
    })
  })
  startJob(jobId, {
    pid: child.pid,
    processGroup: child.pid,
    externalHandle,
    stage: input.healthUrl ? 'starting' : 'running',
  })
  appendJobOutput(jobId, `Started service ${serviceName}: ${commandLine}\n`)

  try {
    if (input.healthUrl?.trim()) {
      await Promise.race([
        waitForHealth(input.healthUrl.trim(), deadlineMs, context?.signal),
        spawnErrorWatcher.promise.then((err) => {
          throw err
        }),
      ])
      spawnErrorWatcher.stop()
      startJob(jobId, { stage: 'healthy', externalHandle })
      appendJobOutput(jobId, `Health OK ${input.healthUrl.trim()}\n`)
      return serviceResult(jobId, false, `Service job healthy: ${serviceName}`)
    }
    const spawnError = await waitForSpawnError(child, 50)
    if (spawnError) throw spawnError
    spawnErrorWatcher.stop()
    return serviceResult(jobId, false, `Service job running: ${serviceName}`)
  } catch (err) {
    spawnErrorWatcher.stop()
    const message = err instanceof Error ? err.message : String(err)
    const spawnFailed = isSpawnError(err)
    appendJobOutput(jobId, `${message}\n`)
    await stopLiveService(entry, {
      status: spawnFailed ? 'failed' : isAbortLikeError(err) ? 'cancelled' : 'timeout',
      stage: spawnFailed ? 'spawn_error' : isAbortLikeError(err) ? 'stopped' : 'health_timeout',
      terminationReason: spawnFailed ? 'spawn_error' : isAbortLikeError(err) ? 'startup_aborted' : 'deadline_exceeded',
      gracefulStopMs: clampGracefulStop(input.gracefulStopMs),
      error: message,
    })
    return serviceResult(jobId, true, `Service job failed: ${message}`)
  }
}

async function statusService(input: ServiceJobInput): Promise<ToolResult> {
  const serviceName = input.serviceName.trim()
  const entry = liveServices.get(serviceName)
  if (!entry || !isChildRunning(entry.child)) {
    return {
      output: `Service job not running: ${serviceName}`,
      isError: false,
      metadata: { serviceName, status: 'not_running' },
    }
  }

  const healthUrl = input.healthUrl?.trim() || entry.healthUrl
  const externalHandle = entry.port !== undefined ? `127.0.0.1:${entry.port}` : undefined
  if (healthUrl) {
    const healthy = await checkHealthOnce(healthUrl, 1_000)
    startJob(entry.jobId, { stage: healthy ? 'healthy' : 'unhealthy', externalHandle })
    appendJobOutput(entry.jobId, `Health ${healthy ? 'OK' : 'FAILED'} ${healthUrl}\n`)
    return serviceResult(entry.jobId, false, `Service job status: ${serviceName} ${healthy ? 'healthy' : 'unhealthy'}`)
  }

  startJob(entry.jobId, { stage: 'running', externalHandle })
  return serviceResult(entry.jobId, false, `Service job status: ${serviceName} running`)
}

async function stopService(input: ServiceJobInput): Promise<ToolResult> {
  const serviceName = input.serviceName.trim()
  const entry = liveServices.get(serviceName)
  if (!entry) {
    return {
      output: `Service job not running: ${serviceName}`,
      isError: false,
      metadata: { serviceName, status: 'not_running' },
    }
  }

  const job = await stopLiveService(entry, {
    status: 'cancelled',
    stage: 'stopped',
    terminationReason: 'service_stop',
    gracefulStopMs: clampGracefulStop(input.gracefulStopMs),
  })
  return {
    output: `Service job stopped: ${serviceName}`,
    isError: false,
    metadata: { job },
  }
}

async function restartService(input: ServiceJobInput, context?: ToolExecutionContext): Promise<ToolResult> {
  const serviceName = input.serviceName.trim()
  const existing = liveServices.get(serviceName)
  const restartInput: ServiceJobInput = {
    ...input,
    action: 'start',
    command: input.command ?? existing?.command,
    args: input.args ?? existing?.args,
    env: input.env ?? existing?.env,
    cwd: input.cwd ?? existing?.cwd,
    port: input.port ?? existing?.port,
    healthUrl: input.healthUrl ?? existing?.healthUrl,
  }
  const validation = validateInput(restartInput, 'start')
  if (validation) return validation
  if (existing) {
    await stopLiveService(existing, {
      status: 'cancelled',
      stage: 'restarted',
      terminationReason: 'service_restart',
      gracefulStopMs: clampGracefulStop(input.gracefulStopMs),
    })
  }
  return await startService(restartInput, context)
}

async function stopLiveService(
  entry: LiveService,
  options: {
    status: Exclude<JobStatus, 'queued' | 'running' | 'waiting'>
    stage: string
    terminationReason: string
    gracefulStopMs: number
    error?: string
  },
): Promise<JobRecord | undefined> {
  entry.stopping = true
  const attempted = isChildRunning(entry.child)
  let graceful = true
  if (attempted) {
    entry.child.kill('SIGTERM')
    graceful = await waitForExit(entry.child, options.gracefulStopMs)
    if (!graceful && isChildRunning(entry.child)) {
      entry.child.kill('SIGKILL')
      await waitForExit(entry.child, 1_000)
    }
  }
  entry.logStream.end()
  unregisterJobAbortAdapter(entry.jobId)
  liveServices.delete(entry.serviceName)
  recordJobCleanup(entry.jobId, {
    attempted,
    succeeded: !isChildRunning(entry.child),
    remainingPids: isChildRunning(entry.child) && entry.child.pid ? [entry.child.pid] : [],
  })
  appendJobOutput(entry.jobId, `${graceful ? 'Graceful stop' : 'Escalated stop'} ${options.terminationReason}\n`)
  return finishJob(entry.jobId, options.status, {
    stage: options.stage,
    terminationReason: options.terminationReason,
    ...(options.error ? { error: options.error } : {}),
  })
}

function wireProcessOutput(entry: LiveService): void {
  const write = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8')
    entry.logStream.write(text)
    appendJobOutput(entry.jobId, text)
  }
  entry.child.stdout.on('data', write)
  entry.child.stderr.on('data', write)
}

function wireUnexpectedExit(entry: LiveService): void {
  entry.child.once('exit', (code, signal) => {
    entry.logStream.end()
    if (entry.stopping) return
    unregisterJobAbortAdapter(entry.jobId)
    liveServices.delete(entry.serviceName)
    const clean = code === 0
    appendJobOutput(entry.jobId, `Service exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
    recordJobCleanup(entry.jobId, {
      attempted: false,
      succeeded: true,
      remainingPids: [],
    })
    finishJob(entry.jobId, clean ? 'done' : 'failed', {
      stage: 'exited',
      terminationReason: clean ? 'process_exit' : 'unexpected_exit',
      ...(clean ? {} : { error: `service exited code=${code ?? 'null'} signal=${signal ?? 'null'}` }),
    })
  })
}

function createSpawnErrorWatcher(child: ServiceChildProcess): { promise: Promise<Error>; stop: () => void } {
  let onError: ((err: Error) => void) | undefined
  const promise = new Promise<Error>((resolvePromise) => {
    onError = (err) => resolvePromise(err)
    child.once('error', onError)
  })
  return {
    promise,
    stop: () => {
      if (onError) child.off('error', onError)
      onError = undefined
    },
  }
}

function waitForSpawnError(child: ServiceChildProcess, timeoutMs: number): Promise<Error | null> {
  return new Promise((resolvePromise) => {
    const onError = (err: Error): void => {
      clearTimeout(timer)
      child.off('error', onError)
      resolvePromise(err)
    }
    const timer = setTimeout(() => {
      child.off('error', onError)
      resolvePromise(null)
    }, timeoutMs)
    child.once('error', onError)
  })
}

async function waitForHealth(url: string, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  const deadlineAt = Date.now() + deadlineMs
  let lastError = ''
  while (Date.now() < deadlineAt) {
    if (signal?.aborted) throw new Error('service startup aborted')
    const remaining = Math.max(1, deadlineAt - Date.now())
    try {
      const ok = await checkHealthOnce(url, Math.min(1_000, remaining))
      if (ok) return
      lastError = 'health returned non-2xx'
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await delay(Math.min(100, Math.max(1, deadlineAt - Date.now())))
  }
  throw new Error(`health check timed out for ${url}${lastError ? ` (${lastError})` : ''}`)
}

async function checkHealthOnce(url: string, timeoutMs: number): Promise<boolean> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  return response.ok
}

function waitForExit(child: ServiceChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolvePromise(true)
    }
    child.once('exit', onExit)
  })
}

function validateInput(input: ServiceJobInput, action: string): ToolResult | null {
  if (!input || typeof input !== 'object') return { output: 'Error: ServiceJob input is required.', isError: true }
  if (!SERVICE_ACTIONS.has(action)) {
    return {
      output: `Error: unsupported ServiceJob action "${input.action}". Supported actions: ${[...SERVICE_ACTIONS].join(', ')}.`,
      isError: true,
      metadata: { failureCategory: 'service-job:unsupported-action' },
    }
  }
  if (typeof input.serviceName !== 'string' || !input.serviceName.trim()) {
    return { output: 'Error: serviceName is required.', isError: true }
  }
  if ((action === 'start' || action === 'restart') && (typeof input.command !== 'string' || !input.command.trim()) && !liveServices.has(input.serviceName.trim())) {
    return { output: `Error: command is required for ServiceJob action=${action}.`, isError: true }
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || !input.args.every(arg => typeof arg === 'string'))) {
    return { output: 'Error: args must be an array of strings when provided.', isError: true }
  }
  if (input.env !== undefined && !isStringRecord(input.env)) {
    return { output: 'Error: env must be an object with string values when provided.', isError: true }
  }
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
    return { output: 'Error: cwd must be a non-empty string when provided.', isError: true }
  }
  if (input.artifactDir !== undefined && (typeof input.artifactDir !== 'string' || !input.artifactDir.trim())) {
    return { output: 'Error: artifactDir must be a non-empty string when provided.', isError: true }
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535)) {
    return { output: 'Error: port must be an integer between 1 and 65535 when provided.', isError: true }
  }
  if (input.healthUrl !== undefined) {
    if (typeof input.healthUrl !== 'string' || !input.healthUrl.trim()) return { output: 'Error: healthUrl must be a non-empty string when provided.', isError: true }
    try {
      const parsed = new URL(input.healthUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { output: `Error: healthUrl must be HTTP/HTTPS (got ${parsed.protocol}).`, isError: true }
      }
    } catch {
      return { output: `Error: invalid healthUrl "${input.healthUrl}".`, isError: true }
    }
  }
  return null
}

function normalizeAction(action: unknown): string {
  return typeof action === 'string' ? action.trim().toLowerCase() : ''
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

function clampDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_DEADLINE_MS
  return Math.min(Math.floor(value), MAX_DEADLINE_MS)
}

function clampGracefulStop(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_GRACEFUL_STOP_MS
  return Math.min(Math.floor(value), MAX_GRACEFUL_STOP_MS)
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError' || /abort/i.test(err.message)
}

function isSpawnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EACCES' || /spawn/i.test(err.message)
}

function isChildRunning(child: ServiceChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

function serviceResult(jobId: string, isError: boolean, output: string): ToolResult {
  const job = getJob(jobId)
  return {
    output,
    isError,
    metadata: job ? { job } : { jobId },
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}
