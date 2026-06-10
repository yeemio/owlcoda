/**
 * Training-store — single source of truth for the locally collected training
 * dataset (~/.owlcoda/training/collected.jsonl + manifest.json).
 *
 * CLI, REPL slash command, and HTTP API all read through here so that
 * "what `owlcoda training status` shows" and "what `/training` shows" and
 * "what `GET /v1/training/status` returns" can never drift apart again.
 *
 * Reads are streaming where it matters — collected.jsonl can be hundreds of
 * MB. Sample/limit paths use line-by-line readline; full export streams via
 * the consumer (e.g. `pipe(createReadStream(...))`).
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeText } from './sanitize.js'

// ─── Paths ───

export function getTrainingDir(): string {
  const home = process.env.OWLCODA_HOME ?? join(process.env.HOME ?? homedir(), '.owlcoda')
  return join(home, 'training')
}

export function getCollectedPath(): string {
  return join(getTrainingDir(), 'collected.jsonl')
}

export function getManifestPath(): string {
  return join(getTrainingDir(), 'manifest.json')
}

// ─── Status ───

export interface TrainingStatus {
  /** From manifest.json — sessions accepted by the collector. */
  totalCollected: number
  /** From manifest.json — sessions evaluated and rejected by quality gate. */
  totalSkipped: number
  /** From manifest.json — running average of accepted-session quality (0-100). */
  averageQuality: number
  /** From manifest.json — ISO timestamp of last successful collection, or null. */
  lastCollectedAt: string | null
  /** Resolved path to collected.jsonl on this machine. */
  path: string
  /** Bytes on disk (0 if file is missing). */
  fileSize: number
  /** Non-empty JSONL line count (0 if file is missing). */
  lineCount: number
  /** True iff manifest.json was found; lets callers distinguish "no data" from "manifest read error". */
  manifestPresent: boolean
}

const EMPTY_STATUS: Omit<TrainingStatus, 'path'> = {
  totalCollected: 0,
  totalSkipped: 0,
  averageQuality: 0,
  lastCollectedAt: null,
  fileSize: 0,
  lineCount: 0,
  manifestPresent: false,
}

export async function readCollectedStatus(): Promise<TrainingStatus> {
  const path = getCollectedPath()
  const status: TrainingStatus = { ...EMPTY_STATUS, path }

  try {
    const raw = await readFile(getManifestPath(), 'utf-8')
    const manifest = JSON.parse(raw)
    status.manifestPresent = true
    status.totalCollected = Number(manifest.totalCollected ?? 0)
    status.totalSkipped = Number(manifest.totalSkipped ?? 0)
    status.averageQuality = Number(manifest.averageQuality ?? 0)
    status.lastCollectedAt = manifest.lastCollectedAt || null
  } catch { /* manifest absent — leave defaults */ }

  try {
    const s = await stat(path)
    status.fileSize = s.size
    status.lineCount = await countJsonlLines(path)
  } catch { /* collected.jsonl absent */ }

  return status
}

async function countJsonlLines(path: string): Promise<number> {
  // Stream line-by-line — avoid pulling the whole 240MB into memory just to
  // count. readline gives us one event per logical line.
  let count = 0
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) count++
  }
  return count
}

// ─── Lines / sample ───

export interface ReadLinesOptions {
  /** Max lines to yield (default: unlimited). */
  limit?: number
  /** Run each line through PII sanitizer before yielding. */
  sanitize?: boolean
}

/**
 * Async iterable over collected.jsonl lines. Empty if file is missing.
 * Caller is responsible for terminating early — readline closes when the
 * iterator returns or breaks.
 */
export async function* readCollectedLines(opts: ReadLinesOptions = {}): AsyncIterable<string> {
  const path = getCollectedPath()
  let exists = false
  try { await stat(path); exists = true } catch { /* missing */ }
  if (!exists) return

  const { limit, sanitize } = opts
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let yielded = 0
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) continue
    yield sanitize ? sanitizeText(line).text : line
    yielded++
    if (limit !== undefined && yielded >= limit) {
      rl.close()
      return
    }
  }
}

export interface SampleOptions {
  /** Number of entries to sample (default: 1). */
  limit?: number
  /** Per-entry display cap to avoid dumping a 50KB JSONL line into the REPL. */
  maxChars?: number
  /** Run each line through PII sanitizer (default: true — REPL surface). */
  sanitize?: boolean
}

export interface SampleEntry {
  raw: string
  truncated: boolean
}

/**
 * Read first N lines and truncate each to maxChars. Designed for REPL
 * `/training sample` and similar surfaces — never returns more than
 * limit*maxChars characters total.
 */
export async function readCollectedSample(opts: SampleOptions = {}): Promise<SampleEntry[]> {
  const limit = opts.limit ?? 1
  const maxChars = opts.maxChars ?? 240
  const sanitize = opts.sanitize !== false
  const out: SampleEntry[] = []
  for await (const line of readCollectedLines({ limit, sanitize })) {
    if (line.length <= maxChars) {
      out.push({ raw: line, truncated: false })
    } else {
      out.push({ raw: line.slice(0, maxChars), truncated: true })
    }
  }
  return out
}
