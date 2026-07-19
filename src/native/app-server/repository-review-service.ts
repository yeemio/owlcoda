import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type RepositoryUnstagedOperation = 'modified' | 'added' | 'deleted' | 'untracked'
export type RepositoryReviewUnavailableReason = 'not_git_repository' | 'git_status_failed' | 'git_diff_failed'

export interface RepositoryUnstagedChange {
  id: string
  path: string
  operation: RepositoryUnstagedOperation
  worktreeStatus: string
  binary: boolean
  diffPreview: string
  truncated: boolean
  oldText?: string | null
  newText?: string
}

export interface ReviewScopeCapabilities {
  read: boolean
  stage: boolean
  unstage: boolean
  apply: boolean
  revert: boolean
  hunkApply: boolean
  hunkRevert: boolean
}

export interface RepositoryReviewScope {
  id: 'unstaged'
  source: 'git_worktree'
  status: 'ready' | 'unavailable'
  reason?: RepositoryReviewUnavailableReason
  changeCount: number
  excludedCount: number
  capabilities: ReviewScopeCapabilities
}

export interface RepositoryReviewResult {
  changes: RepositoryUnstagedChange[]
  scope: RepositoryReviewScope
}

export interface RepositoryReviewInput {
  projectRoot: string
  gitBinary?: string
}

interface StatusEntry {
  path: string
  operation: RepositoryUnstagedOperation
  worktreeStatus: string
  untracked: boolean
}

interface GitResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

const MAX_DIFF_PREVIEW_LENGTH = 200_000
const EXCLUDED_PREFIXES = [
  '.owlrunkit/',
  '.owlcoda/',
  'desktop/osui/output/',
  'docs/execution-prompts/integration/',
] as const

const READ_ONLY_CAPABILITIES: ReviewScopeCapabilities = {
  read: true,
  stage: false,
  unstage: false,
  apply: false,
  revert: false,
  hunkApply: false,
  hunkRevert: false,
}

export function listRepositoryUnstagedChanges(input: RepositoryReviewInput): RepositoryReviewResult {
  const gitBinary = input.gitBinary ?? 'git'
  const rootResult = runGit(gitBinary, ['-C', input.projectRoot, 'rev-parse', '--show-toplevel'], input.projectRoot)
  if (rootResult.status !== 0) {
    const reason = isNotGitRepository(rootResult) ? 'not_git_repository' : 'git_status_failed'
    return unavailableResult(reason)
  }
  const repositoryRoot = rootResult.stdout.replace(/[\r\n]+$/, '')
  if (!repositoryRoot) return unavailableResult('git_status_failed')

  const statusResult = runGit(gitBinary, [
    '-C', repositoryRoot,
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ], repositoryRoot)
  if (statusResult.status !== 0) return unavailableResult('git_status_failed')

  const parsed = parseStatus(statusResult.stdout)
  if (!parsed) return unavailableResult('git_status_failed')
  const included: StatusEntry[] = []
  let excludedCount = 0
  for (const entry of parsed) {
    if (isExcludedPath(entry.path)) {
      excludedCount += 1
    } else {
      included.push(entry)
    }
  }

  const changes: RepositoryUnstagedChange[] = []
  for (const entry of included) {
    const diffResult = entry.untracked
      ? runGit(gitBinary, [
          '-C', repositoryRoot,
          'diff',
          '--no-index',
          '--no-color',
          '--',
          '/dev/null',
          join(repositoryRoot, entry.path),
        ], repositoryRoot)
      : runGit(gitBinary, [
          '-C', repositoryRoot,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--',
          `:(top,literal)${entry.path}`,
        ], repositoryRoot)
    const acceptedStatuses = entry.untracked ? [0, 1] : [0]
    if (!acceptedStatuses.includes(diffResult.status ?? -1)) return unavailableResult('git_diff_failed')
    changes.push(buildChange(entry, diffResult.stdout, gitBinary, repositoryRoot))
  }

  return {
    changes,
    scope: {
      id: 'unstaged',
      source: 'git_worktree',
      status: 'ready',
      changeCount: changes.length,
      excludedCount,
      capabilities: { ...READ_ONLY_CAPABILITIES },
    },
  }
}

function runGit(binary: string, args: string[], cwd: string): GitResult {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

function isNotGitRepository(result: GitResult): boolean {
  return !result.error && /not a git repository/i.test(result.stderr)
}

function unavailableResult(reason: RepositoryReviewUnavailableReason): RepositoryReviewResult {
  return {
    changes: [],
    scope: {
      id: 'unstaged',
      source: 'git_worktree',
      status: 'unavailable',
      reason,
      changeCount: 0,
      excludedCount: 0,
      capabilities: {
        ...READ_ONLY_CAPABILITIES,
        read: false,
      },
    },
  }
}

function parseStatus(output: string): StatusEntry[] | null {
  const entries: StatusEntry[] = []
  for (const record of output.split('\0')) {
    if (!record || record.startsWith('# ')) continue
    if (record.startsWith('? ')) {
      entries.push({
        path: record.slice(2),
        operation: 'untracked',
        worktreeStatus: '?',
        untracked: true,
      })
      continue
    }
    if (!record.startsWith('1 ')) return null
    const match = /^1 ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s.exec(record)
    if (!match) return null
    const xy = match[1]!
    const path = match[8]!
    const worktreeStatus = xy[1]!
    const operation = operationForWorktreeStatus(worktreeStatus)
    if (!operation) continue
    entries.push({ path, operation, worktreeStatus, untracked: false })
  }
  return entries
}

function operationForWorktreeStatus(status: string): RepositoryUnstagedOperation | null {
  if (status === 'A') return 'added'
  if (status === 'D') return 'deleted'
  if (status === 'M' || status === 'T') return 'modified'
  return null
}

function isExcludedPath(path: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))
}

function buildChange(entry: StatusEntry, diff: string, gitBinary: string, repositoryRoot: string): RepositoryUnstagedChange {
  const binary = diff.includes('GIT binary patch') || /Binary files .* differ/.test(diff)
  const preview = binary ? 'Binary file changed.' : diff
  const truncated = preview.length > MAX_DIFF_PREVIEW_LENGTH
  const evidence = binary || truncated ? null : readTextEvidence(entry, gitBinary, repositoryRoot)
  return {
    id: `git:${createHash('sha256').update(`${entry.operation}\0${entry.path}`).digest('hex').slice(0, 20)}`,
    path: entry.path,
    operation: entry.operation,
    worktreeStatus: entry.worktreeStatus,
    binary,
    diffPreview: truncated ? preview.slice(0, MAX_DIFF_PREVIEW_LENGTH) : preview,
    truncated,
    ...(evidence ?? {}),
  }
}

function readTextEvidence(
  entry: StatusEntry,
  gitBinary: string,
  repositoryRoot: string,
): { oldText: string | null; newText: string } | null {
  if (entry.operation === 'deleted') {
    const oldText = readIndexText(gitBinary, repositoryRoot, entry.path)
    return oldText === null ? null : { oldText, newText: '' }
  }
  const newText = readWorktreeText(repositoryRoot, entry.path)
  if (newText === null) return null
  if (entry.operation === 'added' || entry.operation === 'untracked') return { oldText: null, newText }
  const oldText = readIndexText(gitBinary, repositoryRoot, entry.path)
  return oldText === null ? null : { oldText, newText }
}

function readIndexText(gitBinary: string, repositoryRoot: string, path: string): string | null {
  const result = runGit(gitBinary, ['-C', repositoryRoot, 'show', `:${path}`], repositoryRoot)
  if (result.status !== 0 || result.stdout.length > MAX_DIFF_PREVIEW_LENGTH) return null
  return result.stdout
}

function readWorktreeText(repositoryRoot: string, path: string): string | null {
  const absolutePath = resolve(repositoryRoot, path)
  const relativePath = relative(repositoryRoot, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) return null
  try {
    if (!lstatSync(absolutePath).isFile()) return null
    const value = readFileSync(absolutePath, 'utf8')
    return value.length <= MAX_DIFF_PREVIEW_LENGTH ? value : null
  } catch {
    return null
  }
}
