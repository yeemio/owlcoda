import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  handoffSessionWorkspace,
  loadSession,
  type SessionWorkspaceIdentity,
} from '../session.js'
import {
  assertMatchingLedger,
  formatUntrackedWorktreePreflight,
  lifecycleLedgerPath,
  listHighRiskUntrackedFiles,
  listLifecycleLedgerPaths,
  readLifecycleLedger,
  resolveGitCommonDirectory,
  validateWorktreeSlug,
  writeLifecycleLedger,
  type WorktreeLifecycleLedger,
} from '../tools/worktree-lifecycle.js'

export interface ManagedWorkspaceDescriptor {
  schemaVersion: 1
  workspaceId: string
  slug: string
  status: WorktreeLifecycleLedger['status']
  projectRoot: string
  worktreePath: string
  branch: string
  branchOwner: 'managed' | 'project'
  handoffThreadId?: string
  baseCommit: string
  ledgerPath: string
  createdAt: string
  updatedAt: string
}

export interface ManagedWorkspaceCreateInput {
  slug: string
  startingRef?: string
  allowUntracked?: boolean
}

export interface ManagedWorkspaceLookupInput {
  workspaceId: string
}

export interface ManagedWorkspaceListResult {
  workspaces: ManagedWorkspaceDescriptor[]
}

export interface ManagedWorkspaceCreateResult {
  workspace: ManagedWorkspaceDescriptor
}

export interface ManagedWorkspaceReadResult {
  workspace: ManagedWorkspaceDescriptor
}

export interface ManagedWorkspaceResumeResult {
  workspace: ManagedWorkspaceDescriptor
  resumed: true
}

export interface ManagedWorkspaceStatusResult {
  workspace: ManagedWorkspaceDescriptor
  head: string
  clean: boolean
  changedFiles: number
  commitsAhead: number
  statusFingerprint: string
  branchOwner: 'managed' | 'project'
  project: ManagedCheckoutStatus
}

export interface ManagedCheckoutStatus {
  head: string
  branch: string | null
  clean: boolean
  changedFiles: number
  statusFingerprint: string
}

export interface ManagedWorkspaceAuthorizedInput extends ManagedWorkspaceLookupInput {
  requestId: string
  expectedHead: string
  expectedStatusFingerprint: string
  authorized: boolean
}

export interface ManagedWorkspaceCommitInput extends ManagedWorkspaceAuthorizedInput {
  message: string
}

export interface ManagedWorkspaceCleanupInput extends ManagedWorkspaceAuthorizedInput {
  discardChanges?: boolean
}

export interface ManagedWorkspaceHandoffInput extends ManagedWorkspaceAuthorizedInput {
  threadId: string
  direction: 'to_project' | 'to_managed'
  expectedProjectHead: string
  expectedProjectStatusFingerprint: string
}

export interface ManagedWorkspaceAuthorizationBinding {
  action: 'commit' | 'keep' | 'cleanup' | 'handoff'
  requestId: string
  requestSha256: string
  workspaceId: string
  currentHead: string
  currentStatusFingerprint: string
  message?: string
  discardChanges?: boolean
  threadId?: string
  direction?: 'to_project' | 'to_managed'
  currentProjectHead?: string
  currentProjectStatusFingerprint?: string
}

export type ManagedWorkspaceAuthorizer = (
  binding: Readonly<ManagedWorkspaceAuthorizationBinding>,
) => boolean

export interface ManagedWorkspaceOperationReceipt {
  schemaVersion: 1
  receiptId: string
  requestId: string
  action: 'commit' | 'keep' | 'cleanup' | 'handoff'
  workspaceId: string
  projectRoot: string
  worktreePath: string
  branch: string
  baseCommit: string
  previousHead: string
  headAfter: string
  statusFingerprintBefore: string
  statusFingerprintAfter: string | null
  changedFiles: number
  commitsAhead: number
  commit?: string
  message?: string
  discardedChanges?: boolean
  direction?: 'to_project' | 'to_managed'
  threadId?: string
  branchOwnerBefore?: 'managed' | 'project'
  branchOwnerAfter?: 'managed' | 'project'
  projectHeadBefore?: string
  projectHeadAfter?: string
  projectStatusFingerprintBefore?: string
  projectStatusFingerprintAfter?: string
  worktreePresentAfter: boolean
  branchRetained: boolean
  authorizationConfirmed: true
  createdAt: string
}

export interface ManagedWorkspaceOperationResult {
  receipt: ManagedWorkspaceOperationReceipt
}

export interface ManagedWorkspaceService {
  capability(): { available: boolean; currentMode: 'project' | 'managed' }
  currentWorkspace(): ManagedWorkspaceDescriptor | null
  create(input: ManagedWorkspaceCreateInput): ManagedWorkspaceCreateResult
  list(): ManagedWorkspaceListResult
  read(input: ManagedWorkspaceLookupInput): ManagedWorkspaceReadResult
  resume(input: ManagedWorkspaceLookupInput): ManagedWorkspaceResumeResult
  status(input: ManagedWorkspaceLookupInput): ManagedWorkspaceStatusResult
  commit(input: ManagedWorkspaceCommitInput): ManagedWorkspaceOperationResult
  keep(input: ManagedWorkspaceAuthorizedInput): ManagedWorkspaceOperationResult
  cleanup(input: ManagedWorkspaceCleanupInput): ManagedWorkspaceOperationResult
  handoff(input: ManagedWorkspaceHandoffInput): ManagedWorkspaceOperationResult
}

interface RepositoryIdentity {
  primaryRoot: string
}

export function createManagedWorkspaceService(options: {
  projectRoot: string
  authorizeOperation?: ManagedWorkspaceAuthorizer
}): ManagedWorkspaceService {
  const projectRoot = resolve(options.projectRoot)
  const repository = resolveRepositoryIdentity(projectRoot)

  function requireRepository(): RepositoryIdentity {
    if (!repository) throw new Error('Managed workspaces require a Git repository')
    return repository
  }

  function descriptors(): ManagedWorkspaceDescriptor[] {
    const { primaryRoot } = requireRepository()
    return listLifecycleLedgerPaths(primaryRoot)
      .map(path => ({ path, ledger: readLifecycleLedger(path) }))
      .filter(({ ledger }) => samePath(ledger.gitRoot, primaryRoot))
      .map(({ path, ledger }) => descriptorFromLedger(path, ledger))
  }

  function ledgers(): Array<{ path: string; ledger: WorktreeLifecycleLedger }> {
    const { primaryRoot } = requireRepository()
    return listLifecycleLedgerPaths(primaryRoot)
      .map(path => ({ path, ledger: readLifecycleLedger(path) }))
      .filter(({ ledger }) => samePath(ledger.gitRoot, primaryRoot))
  }

  function findLedger(workspaceIdValue: string): { path: string; ledger: WorktreeLifecycleLedger } {
    const found = ledgers().find(({ ledger }) => workspaceId(ledger.gitRoot, ledger.slug) === workspaceIdValue)
    if (!found) throw new Error(`Managed workspace not found: ${workspaceIdValue}`)
    return found
  }

  function findWorkspace(workspaceId: string): ManagedWorkspaceDescriptor {
    const workspace = descriptors().find(candidate => candidate.workspaceId === workspaceId)
    if (!workspace) throw new Error(`Managed workspace not found: ${workspaceId}`)
    validateWorkspaceTruth(workspace)
    return workspace
  }

  return {
    capability() {
      return {
        available: repository !== null && options.authorizeOperation !== undefined,
        currentMode: this.currentWorkspace() ? 'managed' : 'project',
      }
    },

    currentWorkspace() {
      if (!repository) return null
      const workspace = descriptors().find(candidate => samePath(candidate.worktreePath, projectRoot)) ?? null
      if (workspace) validateWorkspaceTruth(workspace)
      return workspace
    },

    create(input) {
      requireTrustedHostAvailability(options.authorizeOperation)
      const { primaryRoot } = requireRepository()
      const error = validateWorktreeSlug(input.slug)
      if (error) throw new Error(error)
      const startingRef = input.startingRef?.trim() || 'HEAD'
      const worktreePath = resolve(primaryRoot, '..', '.owlcoda-worktrees', input.slug)
      const branch = `owlcoda/${input.slug}`
      const ledgerPath = lifecycleLedgerPath(primaryRoot, input.slug)
      if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`)

      const riskyUntrackedFiles = listHighRiskUntrackedFiles(primaryRoot)
      if (riskyUntrackedFiles.length > 0 && input.allowUntracked !== true) {
        throw new Error(formatUntrackedWorktreePreflight(riskyUntrackedFiles))
      }

      const baseCommit = git(primaryRoot, 'rev-parse', `${startingRef}^{commit}`)
      const now = new Date().toISOString()
      const ledger: WorktreeLifecycleLedger = {
        version: 1,
        slug: input.slug,
        status: 'creating',
        gitRoot: primaryRoot,
        originalCwd: primaryRoot,
        worktreePath,
        branch,
        baseCommit,
        createdAt: now,
        updatedAt: now,
      }
      writeLifecycleLedger(ledgerPath, ledger)
      try {
        execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, startingRef], {
          cwd: primaryRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        writeLifecycleLedger(ledgerPath, {
          ...ledger,
          status: 'creation_failed',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      writeLifecycleLedger(ledgerPath, { ...ledger, status: 'active' })
      return { workspace: findWorkspace(workspaceId(primaryRoot, input.slug)) }
    },

    list() {
      const workspaces = descriptors()
        .filter(workspace => workspace.status === 'active' || workspace.status === 'kept')
        .map(workspace => {
          validateWorkspaceTruth(workspace)
          return workspace
        })
      return { workspaces }
    },

    read(input) {
      return { workspace: findWorkspace(input.workspaceId) }
    },

    resume(input) {
      requireTrustedHostAvailability(options.authorizeOperation)
      const workspace = findWorkspace(input.workspaceId)
      const ledger = readLifecycleLedger(workspace.ledgerPath)
      writeLifecycleLedger(workspace.ledgerPath, { ...ledger, status: 'active', error: undefined })
      return { workspace: findWorkspace(input.workspaceId), resumed: true }
    },

    status(input) {
      return readWorkspaceStatus(findWorkspace(input.workspaceId))
    },

    commit(input) {
      requireAuthorization(input)
      const message = input.message.trim()
      if (!message) throw new Error('Commit message is required')
      const requestSha256 = operationRequestSha256('commit', {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        expectedHead: input.expectedHead,
        expectedStatusFingerprint: input.expectedStatusFingerprint,
        message,
      })
      const found = findLedger(input.workspaceId)
      const replay = replayOperation(found.ledger, input.requestId, requestSha256)
      if (replay) return { receipt: replay }
      const workspace = findWorkspace(input.workspaceId)
      const reviewed = requireExpectedStatus(workspace, input)
      requireTrustedHostAuthorization(options.authorizeOperation, {
        action: 'commit',
        requestId: input.requestId,
        requestSha256,
        workspaceId: input.workspaceId,
        currentHead: reviewed.head,
        currentStatusFingerprint: reviewed.statusFingerprint,
        message,
      })
      const before = requireExpectedStatus(workspace, input)
      if (before.clean) throw new Error('Managed workspace has no changes to commit')
      execFileSync('git', ['add', '--all'], {
        cwd: workspace.worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      execFileSync('git', ['commit', '-m', message], {
        cwd: workspace.worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const after = readWorkspaceStatus(workspace)
      const receipt = operationReceipt({
        action: 'commit',
        requestId: input.requestId,
        workspace,
        before,
        after,
        commit: after.head,
        message,
      })
      persistOperation(found.path, found.ledger, input.requestId, requestSha256, receipt)
      return { receipt }
    },

    keep(input) {
      requireAuthorization(input)
      const requestSha256 = operationRequestSha256('keep', {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        expectedHead: input.expectedHead,
        expectedStatusFingerprint: input.expectedStatusFingerprint,
      })
      const found = findLedger(input.workspaceId)
      const replay = replayOperation(found.ledger, input.requestId, requestSha256)
      if (replay) return { receipt: replay }
      const workspace = findWorkspace(input.workspaceId)
      const reviewed = requireExpectedStatus(workspace, input)
      requireTrustedHostAuthorization(options.authorizeOperation, {
        action: 'keep',
        requestId: input.requestId,
        requestSha256,
        workspaceId: input.workspaceId,
        currentHead: reviewed.head,
        currentStatusFingerprint: reviewed.statusFingerprint,
      })
      const before = requireExpectedStatus(workspace, input)
      const receipt = operationReceipt({
        action: 'keep',
        requestId: input.requestId,
        workspace,
        before,
        after: before,
      })
      persistOperation(found.path, { ...found.ledger, status: 'kept', cleanup: {
        action: 'keep',
        changedFiles: before.changedFiles,
        commits: before.commitsAhead,
        discardChanges: false,
        discardCommits: false,
        branchRetained: true,
      } }, input.requestId, requestSha256, receipt)
      return { receipt }
    },

    cleanup(input) {
      requireAuthorization(input)
      const discardChanges = input.discardChanges === true
      const requestSha256 = operationRequestSha256('cleanup', {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        expectedHead: input.expectedHead,
        expectedStatusFingerprint: input.expectedStatusFingerprint,
        discardChanges,
      })
      const found = findLedger(input.workspaceId)
      const replay = replayOperation(found.ledger, input.requestId, requestSha256)
      if (replay) return { receipt: replay }
      const workspace = findWorkspace(input.workspaceId)
      const reviewed = requireExpectedStatus(workspace, input)
      requireTrustedHostAuthorization(options.authorizeOperation, {
        action: 'cleanup',
        requestId: input.requestId,
        requestSha256,
        workspaceId: input.workspaceId,
        currentHead: reviewed.head,
        currentStatusFingerprint: reviewed.statusFingerprint,
        discardChanges,
      })
      const before = requireExpectedStatus(workspace, input)
      if (before.changedFiles > 0 && !discardChanges) {
        throw new Error(`Managed workspace has ${before.changedFiles} uncommitted file(s); explicit discard authorization is required`)
      }
      const removeArgs = ['worktree', 'remove']
      if (discardChanges) removeArgs.push('--force')
      removeArgs.push(workspace.worktreePath)
      execFileSync('git', removeArgs, {
        cwd: workspace.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const receipt = operationReceipt({
        action: 'cleanup',
        requestId: input.requestId,
        workspace,
        before,
        after: null,
        discardedChanges: discardChanges,
      })
      persistOperation(found.path, { ...found.ledger, status: 'removed', cleanup: {
        action: 'remove',
        changedFiles: before.changedFiles,
        commits: before.commitsAhead,
        discardChanges,
        discardCommits: false,
        branchRetained: true,
      } }, input.requestId, requestSha256, receipt)
      return { receipt }
    },

    handoff(input) {
      requireAuthorization(input)
      requireHandoffInput(input)
      const requestSha256 = operationRequestSha256('handoff', {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        direction: input.direction,
        requestId: input.requestId,
        expectedHead: input.expectedHead,
        expectedStatusFingerprint: input.expectedStatusFingerprint,
        expectedProjectHead: input.expectedProjectHead,
        expectedProjectStatusFingerprint: input.expectedProjectStatusFingerprint,
      })
      const found = findLedger(input.workspaceId)
      const replay = replayOperation(found.ledger, input.requestId, requestSha256)
      if (replay) return { receipt: replay }
      const workspace = findWorkspace(input.workspaceId)
      const reviewed = requireExpectedStatus(workspace, input)
      const reviewedProject = requireExpectedProjectStatus(workspace.projectRoot, input)
      requireTrustedHostAuthorization(options.authorizeOperation, {
        action: 'handoff',
        requestId: input.requestId,
        requestSha256,
        workspaceId: input.workspaceId,
        currentHead: reviewed.head,
        currentStatusFingerprint: reviewed.statusFingerprint,
        threadId: input.threadId,
        direction: input.direction,
        currentProjectHead: reviewedProject.head,
        currentProjectStatusFingerprint: reviewedProject.statusFingerprint,
      })
      const before = requireExpectedStatus(workspace, input)
      const projectBefore = requireExpectedProjectStatus(workspace.projectRoot, input)
      if (!before.clean || !projectBefore.clean) {
        throw new Error('Handoff requires clean Local and managed checkouts')
      }

      if (input.direction === 'to_project') {
        if (workspace.branchOwner !== 'managed') throw new Error('Managed workspace branch is not owned by the worktree')
        if (!projectBefore.branch || projectBefore.branch === workspace.branch) {
          throw new Error('Local checkout does not have an independent return branch')
        }
        const expectedWorkspace = managedSessionWorkspace(workspace)
        requireThreadWorkspace(input.threadId, expectedWorkspace)
        git(workspace.worktreePath, 'switch', '--detach', before.head)
        try {
          git(workspace.projectRoot, 'switch', workspace.branch)
          handoffSessionWorkspace({
            threadId: input.threadId,
            expectedWorkspace,
            targetWorkspace: projectSessionWorkspace(workspace),
          })
        } catch (error) {
          rollbackToManagedOwner(workspace, projectBefore.branch)
          throw error
        }
        const nextWorkspace = { ...workspace, branchOwner: 'project' as const }
        const after = readWorkspaceStatus(nextWorkspace)
        const receipt = handoffReceipt({
          requestId: input.requestId,
          threadId: input.threadId,
          direction: input.direction,
          workspace,
          before,
          after,
          projectBefore,
          projectAfter: after.project,
        })
        persistOperation(found.path, {
          ...found.ledger,
          handoff: {
            branchOwner: 'project',
            threadId: input.threadId,
            projectReturnBranch: projectBefore.branch,
            projectReturnHead: projectBefore.head,
          },
        }, input.requestId, requestSha256, receipt)
        return { receipt }
      }

      const handoff = found.ledger.handoff
      if (workspace.branchOwner !== 'project' || handoff?.branchOwner !== 'project') {
        throw new Error('Managed workspace branch is not owned by Local')
      }
      if (handoff.threadId !== input.threadId) throw new Error('Managed workspace is owned by another thread')
      if (!handoff.projectReturnBranch || !handoff.projectReturnHead) {
        throw new Error('Managed workspace Local return identity is missing')
      }
      if (projectBefore.branch !== workspace.branch) throw new Error('Local checkout no longer owns the managed branch')
      if (git(workspace.projectRoot, 'rev-parse', handoff.projectReturnBranch) !== handoff.projectReturnHead) {
        throw new Error('Local return branch changed after handoff')
      }
      const expectedWorkspace = projectSessionWorkspace(workspace)
      requireThreadWorkspace(input.threadId, expectedWorkspace)
      git(workspace.projectRoot, 'switch', handoff.projectReturnBranch)
      try {
        git(workspace.worktreePath, 'switch', workspace.branch)
        handoffSessionWorkspace({
          threadId: input.threadId,
          expectedWorkspace,
          targetWorkspace: managedSessionWorkspace(workspace),
        })
      } catch (error) {
        rollbackToProjectOwner(workspace, before.head)
        throw error
      }
      const nextWorkspace = { ...workspace, branchOwner: 'managed' as const }
      const after = readWorkspaceStatus(nextWorkspace)
      const receipt = handoffReceipt({
        requestId: input.requestId,
        threadId: input.threadId,
        direction: input.direction,
        workspace,
        before,
        after,
        projectBefore,
        projectAfter: after.project,
      })
      persistOperation(found.path, {
        ...found.ledger,
        handoff: { branchOwner: 'managed', threadId: input.threadId },
      }, input.requestId, requestSha256, receipt)
      return { receipt }
    },
  }
}

function readWorkspaceStatus(workspace: ManagedWorkspaceDescriptor): ManagedWorkspaceStatusResult {
  const checkout = readCheckoutStatus(workspace.worktreePath)
  const commitsAhead = Number.parseInt(git(workspace.worktreePath, 'rev-list', '--count', `${workspace.baseCommit}..HEAD`), 10) || 0
  return {
    workspace,
    head: checkout.head,
    clean: checkout.clean,
    changedFiles: checkout.changedFiles,
    commitsAhead,
    statusFingerprint: checkout.statusFingerprint,
    branchOwner: workspace.branchOwner,
    project: readCheckoutStatus(workspace.projectRoot),
  }
}

function readCheckoutStatus(checkoutPath: string): ManagedCheckoutStatus {
  const head = git(checkoutPath, 'rev-parse', 'HEAD')
  const branch = git(checkoutPath, 'branch', '--show-current') || null
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: checkoutPath,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const rawDiff = execFileSync('git', ['diff', '--raw', '-z', 'HEAD', '--'], {
    cwd: checkoutPath,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const changedPaths = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], {
    cwd: checkoutPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean)
  const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: checkoutPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean)
  const contentManifest = createHash('sha256')
  for (const relativePath of [...new Set([...changedPaths, ...untrackedPaths])].sort()) {
    contentManifest.update(relativePath).update('\0')
    try {
      const absolutePath = resolve(checkoutPath, relativePath)
      const fileStat = lstatSync(absolutePath)
      const fileType = fileStat.isFile()
        ? 'file'
        : fileStat.isSymbolicLink()
          ? 'symlink'
          : fileStat.isDirectory()
            ? 'directory'
            : 'other'
      contentManifest
        .update(fileType)
        .update('\0')
        .update((fileStat.mode & 0o7777).toString(8))
        .update('\0')
        .update(
          fileStat.isSymbolicLink()
            ? createHash('sha256').update(readlinkSync(absolutePath)).digest('hex')
            : git(checkoutPath, 'hash-object', '--no-filters', '--', relativePath),
        )
    } catch {
      contentManifest.update('missing')
    }
    contentManifest.update('\0')
  }
  const changedFiles = status.length === 0 ? 0 : status.toString('utf8').split('\0').filter(Boolean).length
  return {
    head,
    branch,
    clean: changedFiles === 0,
    changedFiles,
    statusFingerprint: createHash('sha256')
      .update(head)
      .update('\0')
      .update(branch ?? '')
      .update('\0')
      .update(status)
      .update(rawDiff)
      .update(contentManifest.digest())
      .digest('hex'),
  }
}

function requireAuthorization(input: ManagedWorkspaceAuthorizedInput): void {
  if (input.authorized !== true) throw new Error('Managed workspace operation requires explicit authorization')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) throw new Error('Invalid managed workspace request id')
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedHead)) throw new Error('Invalid expected managed workspace HEAD')
  if (!/^[a-f0-9]{64}$/.test(input.expectedStatusFingerprint)) throw new Error('Invalid expected managed workspace status fingerprint')
}

function requireTrustedHostAuthorization(
  authorizer: ManagedWorkspaceAuthorizer | undefined,
  binding: ManagedWorkspaceAuthorizationBinding,
): void {
  if (!authorizer) throw new Error('Managed workspace trusted host authorization is unavailable')
  if (authorizer(Object.freeze({ ...binding })) !== true) {
    throw new Error('Managed workspace trusted host authorization denied the operation')
  }
}

function requireTrustedHostAvailability(authorizer: ManagedWorkspaceAuthorizer | undefined): void {
  if (!authorizer) throw new Error('Managed workspace trusted host authorization is unavailable')
}

function requireExpectedStatus(
  workspace: ManagedWorkspaceDescriptor,
  input: Pick<ManagedWorkspaceAuthorizedInput, 'expectedHead' | 'expectedStatusFingerprint'>,
): ManagedWorkspaceStatusResult {
  const current = readWorkspaceStatus(workspace)
  if (current.head !== input.expectedHead || current.statusFingerprint !== input.expectedStatusFingerprint) {
    throw new Error('Managed workspace changed after review; refresh status before authorizing the operation')
  }
  return current
}

function requireExpectedProjectStatus(
  projectRoot: string,
  input: Pick<ManagedWorkspaceHandoffInput, 'expectedProjectHead' | 'expectedProjectStatusFingerprint'>,
): ManagedCheckoutStatus {
  const current = readCheckoutStatus(projectRoot)
  if (
    current.head !== input.expectedProjectHead
    || current.statusFingerprint !== input.expectedProjectStatusFingerprint
  ) {
    throw new Error('Local checkout changed after review; refresh status before authorizing the handoff')
  }
  return current
}

function requireHandoffInput(input: ManagedWorkspaceHandoffInput): void {
  if (!input.threadId.trim()) throw new Error('Thread id is required for managed workspace handoff')
  if (input.direction !== 'to_project' && input.direction !== 'to_managed') {
    throw new Error('Managed workspace handoff direction must be to_project or to_managed')
  }
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedProjectHead)) throw new Error('Invalid expected Local HEAD')
  if (!/^[a-f0-9]{64}$/.test(input.expectedProjectStatusFingerprint)) {
    throw new Error('Invalid expected Local status fingerprint')
  }
}

function operationRequestSha256(action: string, value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ action, ...value })).digest('hex')
}

function replayOperation(
  ledger: WorktreeLifecycleLedger,
  requestId: string,
  requestSha256: string,
): ManagedWorkspaceOperationReceipt | null {
  const existing = ledger.operations?.find(operation => operation.requestId === requestId)
  if (!existing) return null
  if (existing.requestSha256 !== requestSha256) throw new Error(`Managed workspace idempotency conflict for request ${requestId}`)
  return parseOperationReceipt(existing.receipt)
}

function persistOperation(
  ledgerPath: string,
  ledger: WorktreeLifecycleLedger,
  requestId: string,
  requestSha256: string,
  receipt: ManagedWorkspaceOperationReceipt,
): void {
  writeLifecycleLedger(ledgerPath, {
    ...ledger,
    operations: [...(ledger.operations ?? []), { requestId, requestSha256, receipt }],
    error: undefined,
  })
}

function operationReceipt(input: {
  action: ManagedWorkspaceOperationReceipt['action']
  requestId: string
  workspace: ManagedWorkspaceDescriptor
  before: ManagedWorkspaceStatusResult
  after: ManagedWorkspaceStatusResult | null
  commit?: string
  message?: string
  discardedChanges?: boolean
}): ManagedWorkspaceOperationReceipt {
  return {
    schemaVersion: 1,
    receiptId: `workspace-operation:${createHash('sha256').update(`${input.workspace.workspaceId}\0${input.requestId}`).digest('hex').slice(0, 24)}`,
    requestId: input.requestId,
    action: input.action,
    workspaceId: input.workspace.workspaceId,
    projectRoot: input.workspace.projectRoot,
    worktreePath: input.workspace.worktreePath,
    branch: input.workspace.branch,
    baseCommit: input.workspace.baseCommit,
    previousHead: input.before.head,
    headAfter: input.after?.head ?? input.before.head,
    statusFingerprintBefore: input.before.statusFingerprint,
    statusFingerprintAfter: input.after?.statusFingerprint ?? null,
    changedFiles: input.before.changedFiles,
    commitsAhead: input.before.commitsAhead,
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.discardedChanges !== undefined ? { discardedChanges: input.discardedChanges } : {}),
    worktreePresentAfter: input.action !== 'cleanup',
    branchRetained: true,
    authorizationConfirmed: true,
    createdAt: new Date().toISOString(),
  }
}

function handoffReceipt(input: {
  requestId: string
  threadId: string
  direction: 'to_project' | 'to_managed'
  workspace: ManagedWorkspaceDescriptor
  before: ManagedWorkspaceStatusResult
  after: ManagedWorkspaceStatusResult
  projectBefore: ManagedCheckoutStatus
  projectAfter: ManagedCheckoutStatus
}): ManagedWorkspaceOperationReceipt {
  return {
    ...operationReceipt({
      action: 'handoff',
      requestId: input.requestId,
      workspace: input.workspace,
      before: input.before,
      after: input.after,
    }),
    direction: input.direction,
    threadId: input.threadId,
    branchOwnerBefore: input.before.branchOwner,
    branchOwnerAfter: input.after.branchOwner,
    projectHeadBefore: input.projectBefore.head,
    projectHeadAfter: input.projectAfter.head,
    projectStatusFingerprintBefore: input.projectBefore.statusFingerprint,
    projectStatusFingerprintAfter: input.projectAfter.statusFingerprint,
  }
}

function parseOperationReceipt(value: unknown): ManagedWorkspaceOperationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed workspace operation receipt')
  const receipt = value as Partial<ManagedWorkspaceOperationReceipt>
  if (
    receipt.schemaVersion !== 1
    || !new Set(['commit', 'keep', 'cleanup', 'handoff']).has(receipt.action ?? '')
    || typeof receipt.receiptId !== 'string'
    || typeof receipt.requestId !== 'string'
    || typeof receipt.workspaceId !== 'string'
    || receipt.authorizationConfirmed !== true
  ) throw new Error('Invalid managed workspace operation receipt')
  if (
    receipt.action === 'handoff'
    && (
      (receipt.direction !== 'to_project' && receipt.direction !== 'to_managed')
      || typeof receipt.threadId !== 'string'
      || (receipt.branchOwnerBefore !== 'managed' && receipt.branchOwnerBefore !== 'project')
      || (receipt.branchOwnerAfter !== 'managed' && receipt.branchOwnerAfter !== 'project')
    )
  ) throw new Error('Invalid managed workspace handoff receipt')
  return receipt as ManagedWorkspaceOperationReceipt
}

function managedSessionWorkspace(workspace: ManagedWorkspaceDescriptor): SessionWorkspaceIdentity {
  return {
    mode: 'managed',
    workspaceId: workspace.workspaceId,
    projectRoot: workspace.projectRoot,
    workspacePath: workspace.worktreePath,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
    ledgerPath: workspace.ledgerPath,
  }
}

function projectSessionWorkspace(workspace: ManagedWorkspaceDescriptor): SessionWorkspaceIdentity {
  return {
    mode: 'project',
    projectRoot: workspace.projectRoot,
    workspacePath: workspace.projectRoot,
  }
}

function requireThreadWorkspace(threadId: string, expected: SessionWorkspaceIdentity): void {
  const session = loadSession(threadId)
  if (!session || session.cwd !== expected.workspacePath || !session.workspace) {
    throw new Error('Thread workspace changed before handoff')
  }
  const actual = session.workspace
  if (actual.mode !== expected.mode || actual.projectRoot !== expected.projectRoot || actual.workspacePath !== expected.workspacePath) {
    throw new Error('Thread workspace changed before handoff')
  }
  if (
    actual.mode === 'managed'
    && expected.mode === 'managed'
    && (
      actual.workspaceId !== expected.workspaceId
      || actual.branch !== expected.branch
      || actual.baseCommit !== expected.baseCommit
      || actual.ledgerPath !== expected.ledgerPath
    )
  ) throw new Error('Thread workspace changed before handoff')
}

function rollbackToManagedOwner(workspace: ManagedWorkspaceDescriptor, projectReturnBranch: string): void {
  try {
    if (git(workspace.projectRoot, 'branch', '--show-current') === workspace.branch) {
      git(workspace.projectRoot, 'switch', projectReturnBranch)
    }
    if (git(workspace.worktreePath, 'branch', '--show-current') !== workspace.branch) {
      git(workspace.worktreePath, 'switch', workspace.branch)
    }
  } catch {
    throw new Error('Managed workspace handoff failed and branch ownership rollback did not complete')
  }
}

function rollbackToProjectOwner(workspace: ManagedWorkspaceDescriptor, head: string): void {
  try {
    if (git(workspace.worktreePath, 'branch', '--show-current') === workspace.branch) {
      git(workspace.worktreePath, 'switch', '--detach', head)
    }
    if (git(workspace.projectRoot, 'branch', '--show-current') !== workspace.branch) {
      git(workspace.projectRoot, 'switch', workspace.branch)
    }
  } catch {
    throw new Error('Managed workspace handoff failed and Local branch ownership rollback did not complete')
  }
}

function resolveRepositoryIdentity(projectRoot: string): RepositoryIdentity | null {
  try {
    const commonDirectory = resolveGitCommonDirectory(projectRoot)
    git(projectRoot, 'rev-parse', '--show-toplevel')
    if (samePath(commonDirectory, resolve(projectRoot, '.git'))) {
      return { primaryRoot: projectRoot }
    }
    const ledgerRoot = listLifecycleLedgerPaths(projectRoot)
      .map(path => readLifecycleLedger(path))
      .find(ledger => samePath(ledger.worktreePath, projectRoot))
      ?.gitRoot
    const primaryRoot = resolve(ledgerRoot ?? dirname(commonDirectory))
    return { primaryRoot }
  } catch {
    return null
  }
}

function descriptorFromLedger(ledgerPath: string, ledger: WorktreeLifecycleLedger): ManagedWorkspaceDescriptor {
  const projectRoot = resolve(ledger.gitRoot)
  return {
    schemaVersion: 1,
    workspaceId: workspaceId(projectRoot, ledger.slug),
    slug: ledger.slug,
    status: ledger.status,
    projectRoot,
    worktreePath: resolve(ledger.worktreePath),
    branch: ledger.branch,
    branchOwner: ledger.handoff?.branchOwner ?? 'managed',
    ...(ledger.handoff?.threadId ? { handoffThreadId: ledger.handoff.threadId } : {}),
    baseCommit: ledger.baseCommit,
    ledgerPath: resolve(ledgerPath),
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
  }
}

function validateWorkspaceTruth(workspace: ManagedWorkspaceDescriptor): void {
  if (workspace.status !== 'active' && workspace.status !== 'kept') {
    throw new Error(`Managed workspace is not resumable from status ${workspace.status}`)
  }
  if (!existsSync(workspace.worktreePath)) throw new Error('Managed workspace path is missing')
  const ledger = readLifecycleLedger(workspace.ledgerPath)
  assertMatchingLedger(ledger, {
    worktreePath: workspace.worktreePath,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
  })
  const managedBranch = git(workspace.worktreePath, 'branch', '--show-current') || null
  const projectBranch = git(workspace.projectRoot, 'branch', '--show-current') || null
  if (workspace.branchOwner === 'managed' && (managedBranch !== workspace.branch || projectBranch === workspace.branch)) {
    throw new Error(`Managed workspace branch ownership mismatch: expected worktree owner for ${workspace.branch}`)
  }
  if (workspace.branchOwner === 'project' && (managedBranch !== null || projectBranch !== workspace.branch)) {
    throw new Error(`Managed workspace branch ownership mismatch: expected Local owner for ${workspace.branch}`)
  }
  git(workspace.projectRoot, 'cat-file', '-e', `${workspace.baseCommit}^{commit}`)
}

function workspaceId(projectRoot: string, slug: string): string {
  const digest = createHash('sha256').update(`${resolve(projectRoot)}\0${slug}`).digest('hex').slice(0, 20)
  return `managed:${digest}`
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}
