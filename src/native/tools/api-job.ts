import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  type JobRecord,
} from '../job-supervisor.js'
import { getRunWorkspacePathsFromRef, recordArtifact } from '../run-workspace.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface ApiJobInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  artifactDir?: string
  cwd?: string
  deadlineMs?: number
  runRef?: string
  environment?: string
  project?: string
  origin?: string
  stepId?: string
  participatesInFinal?: boolean
}

const DEFAULT_DEADLINE_MS = 30_000
const MAX_DEADLINE_MS = 120_000
const SUPPORTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function createApiJobTool(): NativeToolDef<ApiJobInput> {
  return {
    name: 'ApiJob',
    description:
      'Run one HTTP(S) API request through the platform job supervisor. ' +
      'Records status, response artifacts, timeout/cancel state, and recovery hints so long-running API probes do not rely on model memory.',
    maturity: 'beta',

    async execute(input: ApiJobInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const validation = validateInput(input)
      if (validation) return validation

      const cwd = input.cwd && input.cwd.trim() ? resolve(input.cwd) : process.cwd()
      const parsed = new URL(input.url)
      const method = normalizeMethod(input.method)
      const deadlineMs = clampDeadline(input.deadlineMs)
      const headers = normalizeHeaders(input.headers)

      const created = createJob({
        type: 'api',
        stage: 'queued',
        cwd,
        tool: 'ApiJob',
        provider: method,
        command: `${method} ${parsed.href}`,
        deadlineMs,
        recoveryHint: 'JobList type=api or JobGet jobId=<jobId>',
      })
      const jobId = created.jobId
      startJob(jobId, {
        stage: 'requesting',
        externalHandle: parsed.href,
      })

      const liveCancelController = new AbortController()
      registerJobAbortAdapter(jobId, (reason) => {
        liveCancelController.abort(new Error(`JobCancel: ${reason}`))
      })

      try {
        const signal = composeAbortSignal(deadlineMs, context?.signal, liveCancelController.signal)
        const response = await fetch(parsed.href, {
          method,
          headers,
          redirect: 'follow',
          signal,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: input.body ?? '' }),
        })
        const responseText = method === 'HEAD' ? '' : await response.text()
        const headersObject = Object.fromEntries(response.headers.entries())
        const byteLength = Buffer.byteLength(responseText, 'utf-8')
        appendJobOutput(jobId, `${method} ${parsed.href} status=${response.status} bytes=${byteLength}\n`)

        const artifacts = await writeApiArtifacts({
          jobId,
          artifactDir: resolveApiArtifactDir(input, cwd),
          cwd,
          responseText,
          responseMeta: {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: headersObject,
          },
        })
        const recordedArtifacts = await recordApiArtifacts({
          artifacts,
          input,
          jobId,
          cwd,
        })
        addJobArtifacts(jobId, recordedArtifacts)
        appendJobOutput(jobId, `Saved ${artifacts.length} API artifact(s)\n`)

        if (!response.ok) {
          const message = `HTTP ${response.status} ${response.statusText} from ${parsed.href}`
          appendJobOutput(jobId, `${message}\n`)
          finishJob(jobId, 'failed', {
            stage: 'http_error',
            error: message,
            terminationReason: 'http_error',
          })
          recordNoProcessCleanup(jobId)
          return apiResult(jobId, true, `API job failed: ${message}`)
        }

        finishJob(jobId, 'done', { stage: 'completed' })
        recordNoProcessCleanup(jobId)
        return apiResult(jobId, false, `API job completed: ${jobId}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const timedOut = isAbortLikeError(err)
        appendJobOutput(jobId, `${message}\n`)

        if (getJob(jobId)?.status === 'cancelled') {
          return apiResult(jobId, true, `API job cancelled: ${jobId}`)
        }

        finishJob(jobId, timedOut ? 'timeout' : 'failed', {
          stage: timedOut ? 'timeout' : 'failed',
          error: timedOut ? `request timed out after ${deadlineMs}ms` : message,
          terminationReason: timedOut ? 'deadline_exceeded' : 'execution_error',
        })
        recordNoProcessCleanup(jobId)
        return apiResult(
          jobId,
          true,
          timedOut
            ? `API job timed out after ${deadlineMs}ms: ${jobId}`
            : `API job failed: ${message}`,
        )
      } finally {
        unregisterJobAbortAdapter(jobId)
      }
    },
  }
}

function validateInput(input: ApiJobInput): ToolResult | null {
  if (!input || typeof input.url !== 'string' || !input.url.trim()) {
    return { output: 'Error: url is required.', isError: true }
  }
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { output: `Error: invalid URL "${input.url}".`, isError: true }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { output: `Error: only HTTP/HTTPS URLs are supported (got ${parsed.protocol}).`, isError: true }
  }

  const method = normalizeMethod(input.method)
  if (!SUPPORTED_METHODS.has(method)) {
    return {
      output: `Error: unsupported ApiJob method "${input.method}". Supported methods: ${[...SUPPORTED_METHODS].join(', ')}.`,
      isError: true,
      metadata: { failureCategory: 'api-job:unsupported-method' },
    }
  }
  if ((method === 'GET' || method === 'HEAD') && input.body !== undefined) {
    return { output: `Error: ApiJob ${method} requests cannot include body.`, isError: true }
  }
  if (input.body !== undefined && typeof input.body !== 'string') {
    return { output: 'Error: body must be a string when provided.', isError: true }
  }
  if (input.headers !== undefined && !isStringRecord(input.headers)) {
    return { output: 'Error: headers must be an object with string values.', isError: true }
  }
  if (input.artifactDir !== undefined && (typeof input.artifactDir !== 'string' || !input.artifactDir.trim())) {
    return { output: 'Error: artifactDir must be a non-empty string when provided.', isError: true }
  }
  if (input.runRef !== undefined && (typeof input.runRef !== 'string' || !input.runRef.trim())) {
    return { output: 'Error: runRef must be a non-empty string when provided.', isError: true }
  }
  return null
}

function normalizeMethod(method: string | undefined): string {
  return method?.trim().toUpperCase() || 'GET'
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.trim())
      .map(([name, value]) => [name.trim(), value]),
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

function clampDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_DEADLINE_MS
  return Math.min(Math.floor(value), MAX_DEADLINE_MS)
}

function composeAbortSignal(deadlineMs: number, ...signals: Array<AbortSignal | undefined>): AbortSignal {
  const timeout = AbortSignal.timeout(deadlineMs)
  const activeSignals = [timeout, ...signals.filter((signal): signal is AbortSignal => Boolean(signal))]
  return activeSignals.length === 1 ? timeout : AbortSignal.any(activeSignals)
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError' || /abort|timeout/i.test(err.message)
}

async function writeApiArtifacts(args: {
  jobId: string
  artifactDir?: string
  cwd: string
  responseText: string
  responseMeta: Record<string, unknown>
}): Promise<Array<{ path: string; artifactType: string }>> {
  const root = resolve(args.cwd, args.artifactDir?.trim() || '.owlcoda-api-jobs')
  const dir = resolve(root, sanitizePathSegment(args.jobId))
  await mkdir(dir, { recursive: true })
  const responsePath = resolve(dir, 'response.txt')
  const headersPath = resolve(dir, 'response-headers.json')
  await writeFile(responsePath, args.responseText, 'utf-8')
  await writeFile(headersPath, `${JSON.stringify(args.responseMeta, null, 2)}\n`, 'utf-8')
  return [
    { path: responsePath, artifactType: 'api_response' },
    { path: headersPath, artifactType: 'api_response_headers' },
  ]
}

function resolveApiArtifactDir(input: ApiJobInput, cwd: string): string | undefined {
  if (input.artifactDir?.trim()) return input.artifactDir
  if (!input.runRef?.trim()) return undefined
  const paths = getRunWorkspacePathsFromRef(input.runRef, cwd)
  return join(paths.evidenceDir, 'api')
}

async function recordApiArtifacts(args: {
  artifacts: Array<{ path: string; artifactType: string }>
  input: ApiJobInput
  jobId: string
  cwd: string
}): Promise<Array<{ id?: string; path: string; artifactType: string }>> {
  if (!args.input.runRef?.trim()) return args.artifacts

  const recorded = []
  for (const artifact of args.artifacts) {
    const record = await recordArtifact(args.input.runRef, {
      path: artifact.path,
      origin: args.input.origin?.trim() || 'api_job',
      ...(args.input.stepId?.trim() ? { stepId: args.input.stepId } : {}),
      ...(typeof args.input.participatesInFinal === 'boolean' ? { participatesInFinal: args.input.participatesInFinal } : {}),
    }, args.cwd)
    recorded.push({
      id: record.id,
      path: record.path,
      artifactType: artifact.artifactType,
    })
  }
  return recorded
}

function recordNoProcessCleanup(jobId: string): void {
  recordJobCleanup(jobId, {
    attempted: false,
    succeeded: true,
    remainingPids: [],
  })
}

function apiResult(jobId: string, isError: boolean, output: string): ToolResult {
  const job = getFinishedJob(jobId)
  return {
    output,
    isError,
    metadata: job ? { job } : { jobId },
  }
}

function getFinishedJob(jobId: string): JobRecord | undefined {
  return getJob(jobId)
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}
