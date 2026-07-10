import { copyFile, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const LARGE_FILE_BYTES = 16 * 1024
const LARGE_FILE_LINES = 100
const MAX_RETAINED_RATIO = 0.35
const MAX_RETAINED_BYTE_RATIO = 0.25

export interface DestructiveWriteAssessment {
  destructive: boolean
  oldBytes: number
  newBytes: number
  oldLines: number
  newLines: number
}

export function assessDestructiveReplacement(
  oldContent: string,
  newContent: string,
  oldBytes = Buffer.byteLength(oldContent),
): DestructiveWriteAssessment {
  const newBytes = Buffer.byteLength(newContent)
  const oldLines = countLines(oldContent)
  const newLines = countLines(newContent)
  const lineCollapse = oldLines >= LARGE_FILE_LINES && newLines / oldLines <= MAX_RETAINED_RATIO
  const byteCollapse = oldBytes >= LARGE_FILE_BYTES && newBytes / oldBytes <= MAX_RETAINED_BYTE_RATIO
  return { destructive: lineCollapse || byteCollapse, oldBytes, newBytes, oldLines, newLines }
}

export async function existingFileNeedsOverwriteApproval(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (info.size >= LARGE_FILE_BYTES) return true
    const content = await readFile(path, 'utf8')
    return countLines(content) >= LARGE_FILE_LINES
  } catch {
    return false
  }
}

export async function createRawRecoverySnapshot(path: string): Promise<string> {
  const root = process.env['OWLCODA_RECOVERY_DIR'] || join(homedir(), '.owlcoda', 'recovery', 'file-writes')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const pathHash = createHash('sha256').update(path).digest('hex').slice(0, 12)
  const snapshotPath = join(
    root,
    `${Date.now()}-${pathHash}-${randomBytes(4).toString('hex')}-${basename(path)}.snapshot`,
  )
  await copyFile(path, snapshotPath)
  await chmod(snapshotPath, 0o600)
  return snapshotPath
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length
}
