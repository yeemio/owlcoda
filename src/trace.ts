/**
 * Request/response trace logger for debugging OwlCoda proxy traffic.
 * Enable via OWLCODA_TRACE=1 env var or /trace REPL command.
 *
 * Trace entries are written as JSON files to ~/.owlcoda/trace/
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

export interface TraceEntry {
  timestamp: string
  direction: 'request' | 'response'
  method: string
  endpoint: string
  statusCode?: number
  durationMs?: number
  body: unknown
  headers: Record<string, string>
}

let traceEnabled = !!process.env['OWLCODA_TRACE']
let traceDir: string | null = null
let requestCount = 0

// Token accumulator for /tokens and /budget commands
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requestCount: number
  startedAt: string
}

const usage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requestCount: 0,
  startedAt: new Date().toISOString(),
}

export function getTokenUsage(): TokenUsage {
  return { ...usage }
}

export function addTokenUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
  usage.inputTokens += input
  usage.outputTokens += output
  usage.cacheReadTokens += cacheRead
  usage.cacheWriteTokens += cacheWrite
  usage.requestCount += 1
}

export function resetTokenUsage(): void {
  usage.inputTokens = 0
  usage.outputTokens = 0
  usage.cacheReadTokens = 0
  usage.cacheWriteTokens = 0
  usage.requestCount = 0
  usage.startedAt = new Date().toISOString()
}

export function isTraceEnabled(): boolean {
  return traceEnabled
}

export function setTraceEnabled(enabled: boolean): void {
  traceEnabled = enabled
}

function getTraceDir(): string {
  if (!traceDir) {
    const owlcodaHome = process.env['OWLCODA_HOME'] || path.join(homedir(), '.owlcoda')
    traceDir = path.join(owlcodaHome, 'trace')
  }
  return traceDir
}

async function ensureTraceDir(): Promise<string> {
  const dir = getTraceDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  return dir
}

function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const redacted: Record<string, string> = {}
  const sensitive = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie'])
  for (const [key, value] of Object.entries(headers)) {
    if (sensitive.has(key.toLowerCase())) {
      redacted[key] = '[REDACTED]'
    } else {
      redacted[key] = Array.isArray(value) ? value.join(', ') : (value ?? '')
    }
  }
  return redacted
}

export async function traceRequest(
  method: string,
  endpoint: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): Promise<string | null> {
  if (!traceEnabled) return null

  requestCount++
  const id = `${Date.now()}-${requestCount.toString().padStart(4, '0')}`
  const entry: TraceEntry = {
    timestamp: new Date().toISOString(),
    direction: 'request',
    method,
    endpoint,
    body: truncateBody(body),
    headers: redactHeaders(headers),
  }

  try {
    const dir = await ensureTraceDir()
    const filePath = path.join(dir, `${id}-req.json`)
    await writeFile(filePath, JSON.stringify(entry, null, 2))
    return id
  } catch (err) {
    console.error(`[trace] Failed to write request trace: ${err}`)
    return null
  }
}

export async function traceResponse(
  traceId: string | null,
  method: string,
  endpoint: string,
  statusCode: number,
  durationMs: number,
  body: unknown,
): Promise<void> {
  if (!traceEnabled || !traceId) return

  const entry: TraceEntry = {
    timestamp: new Date().toISOString(),
    direction: 'response',
    method,
    endpoint,
    statusCode,
    durationMs,
    body: truncateBody(body),
    headers: {},
  }

  try {
    const dir = await ensureTraceDir()
    const filePath = path.join(dir, `${traceId}-res.json`)
    await writeFile(filePath, JSON.stringify(entry, null, 2))
  } catch (err) {
    console.error(`[trace] Failed to write response trace: ${err}`)
  }
}

function truncateBody(body: unknown): unknown {
  if (body === null || body === undefined) return null
  const str = typeof body === 'string' ? body : JSON.stringify(body)
  if (str.length > 10_000) {
    return `[TRUNCATED: ${str.length} chars] ${str.slice(0, 2000)}...`
  }
  return body
}
