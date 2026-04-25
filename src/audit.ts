/**
 * Persistent audit log — append-only JSONL file for request history.
 * Fire-and-forget writes, never blocks request path.
 */

import { appendFile, stat, rename, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getOwlcodaDir } from './paths.js'
import type { ProviderRequestDiagnostic } from './provider-error.js'

export interface AuditEntry {
  timestamp: string
  requestId: string
  model: string
  servedBy?: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  status: number
  fallbackUsed: boolean
  streaming: boolean
  failure?: ProviderRequestDiagnostic
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

function getAuditPath(): string {
  return join(getOwlcodaDir(), 'audit.jsonl')
}

async function ensureDir(): Promise<void> {
  try {
    await mkdir(getOwlcodaDir(), { recursive: true })
  } catch { /* exists */ }
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const s = await stat(path)
    if (s.size > MAX_FILE_SIZE) {
      const date = new Date().toISOString().slice(0, 10)
      const rotated = path.replace('.jsonl', `-${date}.jsonl`)
      await rename(path, rotated)
      console.error(`[audit] Rotated log to ${rotated}`)
    }
  } catch { /* file doesn't exist yet, fine */ }
}

/**
 * Append an audit entry. Fire-and-forget — errors are logged but never thrown.
 */
export async function logAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    const path = getAuditPath()
    await ensureDir()
    await rotateIfNeeded(path)
    const line = JSON.stringify(entry) + '\n'
    await appendFile(path, line, 'utf-8')
  } catch (err) {
    console.error(`[audit] Write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Read recent audit entries.
 */
export async function readAuditLog(count = 50): Promise<AuditEntry[]> {
  try {
    const path = getAuditPath()
    const content = await readFile(path, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const entries = lines.slice(-count).map(line => {
      try { return JSON.parse(line) as AuditEntry } catch { return null }
    }).filter((e): e is AuditEntry => e !== null)
    return entries
  } catch {
    return []
  }
}

/**
 * Get audit log file path (for testing/display).
 */
export function getAuditLogPath(): string {
  return getAuditPath()
}
