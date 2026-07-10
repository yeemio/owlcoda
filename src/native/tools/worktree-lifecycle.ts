import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface WorktreeLifecycleLedger {
  version: 1
  slug: string
  status: 'creating' | 'active' | 'kept' | 'removed' | 'creation_failed' | 'cleanup_failed'
  gitRoot: string
  originalCwd: string
  worktreePath: string
  branch: string
  baseCommit: string
  createdAt: string
  updatedAt: string
  cleanup?: {
    action: 'keep' | 'remove'
    changedFiles: number
    commits: number
    discardChanges: boolean
    discardCommits: boolean
  }
  error?: string
}

export function lifecycleLedgerPath(gitRoot: string, slug: string): string {
  const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const commonDir = resolve(gitRoot, commonDirRaw)
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'worktree'
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 16)
  return resolve(commonDir, 'owlcoda', 'worktree-sessions', `${safeSlug}-${hash}.json`)
}

export function writeLifecycleLedger(path: string, ledger: WorktreeLifecycleLedger): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(temp, `${JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function readLifecycleLedger(path: string): WorktreeLifecycleLedger {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorktreeLifecycleLedger>
  if (
    parsed.version !== 1 ||
    typeof parsed.slug !== 'string' ||
    typeof parsed.gitRoot !== 'string' ||
    typeof parsed.originalCwd !== 'string' ||
    typeof parsed.worktreePath !== 'string' ||
    typeof parsed.branch !== 'string' ||
    typeof parsed.baseCommit !== 'string' ||
    typeof parsed.status !== 'string'
  ) {
    throw new Error('invalid lifecycle ledger shape')
  }
  return parsed as WorktreeLifecycleLedger
}

export function assertMatchingLedger(
  ledger: WorktreeLifecycleLedger,
  expected: { worktreePath: string; branch?: string; baseCommit?: string },
): void {
  if (resolve(ledger.worktreePath) !== resolve(expected.worktreePath)) {
    throw new Error('lifecycle ledger worktree path does not match active state')
  }
  if (expected.branch && ledger.branch !== expected.branch) {
    throw new Error('lifecycle ledger branch does not match active state')
  }
  if (expected.baseCommit && ledger.baseCommit !== expected.baseCommit) {
    throw new Error('lifecycle ledger base commit does not match active state')
  }
}
