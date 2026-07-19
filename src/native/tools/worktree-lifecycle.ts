import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
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
    branchRetained?: boolean
  }
  operations?: WorktreeLifecycleOperationRecord[]
  handoff?: {
    branchOwner: 'managed' | 'project'
    threadId: string
    projectReturnBranch?: string
    projectReturnHead?: string
  }
  error?: string
}

export interface WorktreeLifecycleOperationRecord {
  requestId: string
  requestSha256: string
  receipt: unknown
}

const HIGH_RISK_UNTRACKED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'requirements.txt',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
])

const HIGH_RISK_UNTRACKED_PREFIXES = ['src/', 'lib/', 'app/', 'packages/']

export function validateWorktreeSlug(slug: string): string | null {
  if (slug.length > 64) return 'Slug must be 64 characters or fewer.'
  if (!/^[a-zA-Z0-9._/-]+$/.test(slug)) {
    return 'Slug may only contain letters, digits, dots, underscores, dashes, and slashes.'
  }
  return null
}

export function listHighRiskUntrackedFiles(gitRoot: string): string[] {
  let output: string
  try {
    output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return []
  }
  return output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).replace(/\\/g, '/'))
    .filter(path => HIGH_RISK_UNTRACKED_FILES.has(path) || HIGH_RISK_UNTRACKED_PREFIXES.some(prefix => path.startsWith(prefix)))
    .sort()
}

export function formatUntrackedWorktreePreflight(files: string[]): string {
  const shown = files.slice(0, 12)
  const more = files.length > shown.length ? `\n  ... and ${files.length - shown.length} more` : ''
  return [
    `EnterWorktree blocked: ${files.length} untracked dependency/source file${files.length === 1 ? '' : 's'} would be missing from the new worktree.`,
    'Add or intentionally ignore these files before creating a worktree, or set allow_untracked=true if you explicitly want to bypass this preflight:',
    ...shown.map(file => `  - ${file}`),
    more,
  ].filter(Boolean).join('\n')
}

export function resolveGitCommonDirectory(gitRoot: string): string {
  const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  return resolve(gitRoot, commonDirRaw)
}

export function lifecycleLedgerDirectory(gitRoot: string): string {
  return resolve(resolveGitCommonDirectory(gitRoot), 'owlcoda', 'worktree-sessions')
}

export function listLifecycleLedgerPaths(gitRoot: string): string[] {
  const directory = lifecycleLedgerDirectory(gitRoot)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => resolve(directory, name))
}

export function lifecycleLedgerPath(gitRoot: string, slug: string): string {
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'worktree'
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 16)
  return resolve(lifecycleLedgerDirectory(gitRoot), `${safeSlug}-${hash}.json`)
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
