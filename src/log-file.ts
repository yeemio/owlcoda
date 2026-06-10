/**
 * Log file output with rotation.
 * Appends structured JSON log lines to a file synchronously.
 * Rotates when file exceeds maxBytes, keeps up to `keep` old files.
 */

import { appendFileSync, renameSync, unlinkSync, statSync } from 'node:fs'

let filePath: string = ''
let maxBytes: number = 10_485_760 // 10MB
let keep: number = 3
let currentSize: number = 0
let active: boolean = false

export function initLogFile(path: string, maxB?: number, keepCount?: number): void {
  filePath = path
  if (maxB != null) maxBytes = maxB
  if (keepCount != null) keep = keepCount
  active = true

  try {
    const stat = statSync(filePath)
    currentSize = stat.size
  } catch {
    currentSize = 0
  }
}

export function writeLogLine(line: string): void {
  if (!active) return

  const buf = line.endsWith('\n') ? line : line + '\n'
  try {
    appendFileSync(filePath, buf)
    currentSize += Buffer.byteLength(buf)
  } catch {
    return
  }

  if (currentSize >= maxBytes) {
    rotate()
  }
}

function rotate(): void {
  // Shift existing rotated files: .3 → delete, .2 → .3, .1 → .2
  for (let i = keep; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`
    const dst = `${filePath}.${i}`
    try {
      if (i === keep) {
        try { unlinkSync(dst) } catch { /* may not exist */ }
      }
      renameSync(src, dst)
    } catch {
      // source may not exist
    }
  }

  currentSize = 0
}

export function closeLogFile(): void {
  active = false
}
