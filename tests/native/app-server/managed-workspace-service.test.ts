import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedWorkspaceService } from '../../../src/native/app-server/managed-workspace-service.js'
import { createConversation } from '../../../src/native/conversation.js'
import { loadSession, saveSession } from '../../../src/native/session.js'

const sandboxes: string[] = []
const GIT_INTEGRATION_TIMEOUT_MS = 30_000
const HANDOFF_INTEGRATION_TIMEOUT_MS = 60_000

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

describe('managed workspace service', () => {
  it('creates, lists, reads, and resumes a ledger-backed worktree without changing process cwd', () => {
    const { projectRoot } = makeGitRepository()
    const service = createAuthorizedService(projectRoot)
    const cwdBefore = process.cwd()
    const baseCommit = git(projectRoot, 'rev-parse', 'HEAD')

    const created = service.create({ slug: 'desktop-task', startingRef: 'HEAD' })

    expect(process.cwd()).toBe(cwdBefore)
    expect(created.workspace).toMatchObject({
      schemaVersion: 1,
      slug: 'desktop-task',
      status: 'active',
      projectRoot,
      branch: 'owlcoda/desktop-task',
      baseCommit,
    })
    expect(created.workspace.workspaceId).toMatch(/^managed:/)
    expect(existsSync(created.workspace.worktreePath)).toBe(true)
    expect(existsSync(created.workspace.ledgerPath)).toBe(true)

    expect(service.list().workspaces).toEqual([created.workspace])
    expect(service.read({ workspaceId: created.workspace.workspaceId }).workspace).toEqual(created.workspace)
    expect(service.resume({ workspaceId: created.workspace.workspaceId })).toMatchObject({
      resumed: true,
      workspace: {
        workspaceId: created.workspace.workspaceId,
        status: 'active',
        worktreePath: created.workspace.worktreePath,
        branch: created.workspace.branch,
        baseCommit: created.workspace.baseCommit,
      },
    })
    expect(process.cwd()).toBe(cwdBefore)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('recognizes the current App Server workspace from the lifecycle ledger', () => {
    const { projectRoot } = makeGitRepository()
    const created = createAuthorizedService(projectRoot).create({
      slug: 'resume-here',
      startingRef: 'HEAD',
    }).workspace

    const service = createAuthorizedService(created.worktreePath)

    expect(service.currentWorkspace()).toEqual(created)
    expect(service.capability()).toMatchObject({ available: true, currentMode: 'managed' })
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('blocks creation when untracked dependency or source files would be omitted', () => {
    const { projectRoot } = makeGitRepository()
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}\n')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    writeFileSync(join(projectRoot, 'src', 'new-helper.ts'), 'export const value = 1\n')

    const service = createAuthorizedService(projectRoot)

    expect(() => service.create({ slug: 'unsafe', startingRef: 'HEAD' })).toThrow(/untracked dependency\/source files/)
    expect(existsSync(join(projectRoot, '..', '.owlcoda-worktrees', 'unsafe'))).toBe(false)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('fails closed when the managed worktree branch no longer matches its ledger', () => {
    const { projectRoot } = makeGitRepository()
    const service = createAuthorizedService(projectRoot)
    const created = service.create({ slug: 'tampered', startingRef: 'HEAD' }).workspace
    git(created.worktreePath, 'switch', '-c', 'unexpected-branch')

    expect(() => service.read({ workspaceId: created.workspaceId })).toThrow(/branch/i)
    expect(() => service.resume({ workspaceId: created.workspaceId })).toThrow(/branch/i)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('requires an explicit current-status authorization and commits idempotently', () => {
    const { projectRoot } = makeGitRepository()
    const service = createAuthorizedService(projectRoot)
    const workspace = service.create({ slug: 'commit-flow', startingRef: 'HEAD' }).workspace
    writeFileSync(join(workspace.worktreePath, 'managed-change.txt'), 'verified change\n')

    const status = service.status({ workspaceId: workspace.workspaceId })
    expect(status).toMatchObject({
      workspace: { workspaceId: workspace.workspaceId },
      head: workspace.baseCommit,
      clean: false,
      changedFiles: 1,
      commitsAhead: 0,
    })
    expect(status.statusFingerprint).toMatch(/^[a-f0-9]{64}$/)

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'commit-request-1',
      message: 'Commit verified managed change',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: false,
    })).toThrow(/explicit authorization/i)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(workspace.baseCommit)

    const committed = service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'commit-request-1',
      message: 'Commit verified managed change',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
    })
    expect(committed.receipt).toMatchObject({
      schemaVersion: 1,
      action: 'commit',
      requestId: 'commit-request-1',
      workspaceId: workspace.workspaceId,
      previousHead: workspace.baseCommit,
      changedFiles: 1,
      worktreePresentAfter: true,
    })
    expect(committed.receipt.commit).toBe(git(workspace.worktreePath, 'rev-parse', 'HEAD'))
    expect(service.status({ workspaceId: workspace.workspaceId })).toMatchObject({ clean: true, changedFiles: 0, commitsAhead: 1 })

    expect(service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'commit-request-1',
      message: 'Commit verified managed change',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
    })).toEqual(committed)
    expect(git(workspace.worktreePath, 'rev-list', '--count', `${workspace.baseCommit}..HEAD`)).toBe('1')
    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'commit-request-1',
      message: 'A conflicting replay',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
    })).toThrow(/idempotency conflict/i)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('keeps a managed workspace with a durable idempotent receipt', () => {
    const { projectRoot } = makeGitRepository()
    const service = createAuthorizedService(projectRoot)
    const workspace = service.create({ slug: 'keep-flow', startingRef: 'HEAD' }).workspace
    const status = service.status({ workspaceId: workspace.workspaceId })
    const input = {
      workspaceId: workspace.workspaceId,
      requestId: 'keep-request-1',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
    }

    expect(() => service.keep({ ...input, authorized: false })).toThrow(/explicit authorization/i)
    const kept = service.keep(input)
    expect(kept.receipt).toMatchObject({
      schemaVersion: 1,
      action: 'keep',
      requestId: 'keep-request-1',
      workspaceId: workspace.workspaceId,
      worktreePresentAfter: true,
      branchRetained: true,
    })
    expect(service.read({ workspaceId: workspace.workspaceId }).workspace.status).toBe('kept')
    expect(service.keep(input)).toEqual(kept)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('fails closed before cleanup and preserves the committed branch after authorized removal', () => {
    const { projectRoot } = makeGitRepository()
    const service = createAuthorizedService(projectRoot)
    const workspace = service.create({ slug: 'cleanup-flow', startingRef: 'HEAD' }).workspace
    writeFileSync(join(workspace.worktreePath, 'uncommitted.txt'), 'do not discard implicitly\n')
    const status = service.status({ workspaceId: workspace.workspaceId })
    const input = {
      workspaceId: workspace.workspaceId,
      requestId: 'cleanup-request-1',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      discardChanges: false,
    }

    expect(() => service.cleanup({ ...input, authorized: false })).toThrow(/explicit authorization/i)
    expect(() => service.cleanup(input)).toThrow(/uncommitted/i)
    expect(existsSync(workspace.worktreePath)).toBe(true)
    expect(JSON.parse(readFileSync(workspace.ledgerPath, 'utf8'))).toMatchObject({ status: 'active' })

    const cleaned = service.cleanup({ ...input, discardChanges: true })
    expect(cleaned.receipt).toMatchObject({
      schemaVersion: 1,
      action: 'cleanup',
      requestId: 'cleanup-request-1',
      workspaceId: workspace.workspaceId,
      changedFiles: 1,
      discardedChanges: true,
      worktreePresentAfter: false,
      branchRetained: true,
    })
    expect(existsSync(workspace.worktreePath)).toBe(false)
    expect(git(projectRoot, 'branch', '--list', workspace.branch)).toContain(workspace.branch)
    expect(JSON.parse(readFileSync(workspace.ledgerPath, 'utf8'))).toMatchObject({
      status: 'removed',
      cleanup: { action: 'remove', changedFiles: 1, discardChanges: true },
    })
    expect(service.cleanup({ ...input, discardChanges: true })).toEqual(cleaned)
  }, GIT_INTEGRATION_TIMEOUT_MS)

  it('hands one thread and branch from its managed worktree to Local and back to the same worktree', () => {
    const { sandbox, projectRoot } = makeGitRepository()
    const previousHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    try {
      const service = createAuthorizedService(projectRoot)
      const projectBranch = git(projectRoot, 'branch', '--show-current')
      const workspace = service.create({ slug: 'handoff-flow', startingRef: 'HEAD' }).workspace
      writeFileSync(join(workspace.worktreePath, 'handoff.txt'), 'move this code with the task\n')
      git(workspace.worktreePath, 'add', 'handoff.txt')
      git(workspace.worktreePath, 'commit', '--quiet', '-m', 'Prepare handoff fixture')
      const conversation = createConversation({ system: 'test', model: 'test-model' })
      ;(conversation as any).id = 'handoff-thread'
      saveSession(conversation, 'Handoff thread', {
        cwd: workspace.worktreePath,
        workspace: {
          mode: 'managed',
          workspaceId: workspace.workspaceId,
          projectRoot,
          workspacePath: workspace.worktreePath,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
          ledgerPath: workspace.ledgerPath,
        },
      })

      const handoff = (service as unknown as { handoff(input: Record<string, unknown>): { receipt: any } }).handoff
      expect(handoff).toBeTypeOf('function')
      const reviewedStatus = service.status({ workspaceId: workspace.workspaceId }) as any
      writeFileSync(join(projectRoot, 'local-dirty.txt'), 'must block handoff\n')
      expect(() => handoff.call(service, {
        workspaceId: workspace.workspaceId,
        threadId: conversation.id,
        direction: 'to_project',
        requestId: 'handoff-stale-local',
        expectedHead: reviewedStatus.head,
        expectedStatusFingerprint: reviewedStatus.statusFingerprint,
        expectedProjectHead: reviewedStatus.project.head,
        expectedProjectStatusFingerprint: reviewedStatus.project.statusFingerprint,
        authorized: true,
      })).toThrow(/Local checkout changed after review/i)
      const dirtyStatus = service.status({ workspaceId: workspace.workspaceId }) as any
      expect(() => handoff.call(service, {
        workspaceId: workspace.workspaceId,
        threadId: conversation.id,
        direction: 'to_project',
        requestId: 'handoff-dirty-local',
        expectedHead: dirtyStatus.head,
        expectedStatusFingerprint: dirtyStatus.statusFingerprint,
        expectedProjectHead: dirtyStatus.project.head,
        expectedProjectStatusFingerprint: dirtyStatus.project.statusFingerprint,
        authorized: true,
      })).toThrow(/clean Local and managed checkouts/i)
      rmSync(join(projectRoot, 'local-dirty.txt'))

      const managedStatus = service.status({ workspaceId: workspace.workspaceId }) as any
      expect(managedStatus).toMatchObject({
        branchOwner: 'managed',
        project: { branch: projectBranch, clean: true },
      })
      const toProjectInput = {
        workspaceId: workspace.workspaceId,
        threadId: conversation.id,
        direction: 'to_project',
        requestId: 'handoff-to-project-1',
        expectedHead: managedStatus.head,
        expectedStatusFingerprint: managedStatus.statusFingerprint,
        expectedProjectHead: managedStatus.project.head,
        expectedProjectStatusFingerprint: managedStatus.project.statusFingerprint,
        authorized: true,
      }
      const movedToProject = handoff.call(service, toProjectInput)
      expect(movedToProject.receipt).toMatchObject({
        action: 'handoff',
        direction: 'to_project',
        workspaceId: workspace.workspaceId,
        threadId: conversation.id,
        branchOwnerBefore: 'managed',
        branchOwnerAfter: 'project',
        authorizationConfirmed: true,
      })
      expect(git(workspace.worktreePath, 'branch', '--show-current')).toBe('')
      expect(git(projectRoot, 'branch', '--show-current')).toBe(workspace.branch)
      expect(loadSession(conversation.id)).toMatchObject({
        id: conversation.id,
        cwd: projectRoot,
        workspace: { mode: 'project', projectRoot, workspacePath: projectRoot },
      })
      expect(service.read({ workspaceId: workspace.workspaceId }).workspace).toMatchObject({
        branchOwner: 'project',
        handoffThreadId: conversation.id,
      })
      expect(handoff.call(service, toProjectInput)).toEqual(movedToProject)

      const projectStatus = service.status({ workspaceId: workspace.workspaceId }) as any
      expect(projectStatus.branchOwner).toBe('project')
      expect(() => handoff.call(service, {
        workspaceId: workspace.workspaceId,
        threadId: 'another-thread',
        direction: 'to_managed',
        requestId: 'handoff-wrong-thread',
        expectedHead: projectStatus.head,
        expectedStatusFingerprint: projectStatus.statusFingerprint,
        expectedProjectHead: projectStatus.project.head,
        expectedProjectStatusFingerprint: projectStatus.project.statusFingerprint,
        authorized: true,
      })).toThrow(/owned by another thread/i)
      const movedToManaged = handoff.call(service, {
        workspaceId: workspace.workspaceId,
        threadId: conversation.id,
        direction: 'to_managed',
        requestId: 'handoff-to-managed-1',
        expectedHead: projectStatus.head,
        expectedStatusFingerprint: projectStatus.statusFingerprint,
        expectedProjectHead: projectStatus.project.head,
        expectedProjectStatusFingerprint: projectStatus.project.statusFingerprint,
        authorized: true,
      })
      expect(movedToManaged.receipt).toMatchObject({
        action: 'handoff',
        direction: 'to_managed',
        branchOwnerBefore: 'project',
        branchOwnerAfter: 'managed',
      })
      expect(git(projectRoot, 'branch', '--show-current')).toBe(projectBranch)
      expect(git(workspace.worktreePath, 'branch', '--show-current')).toBe(workspace.branch)
      expect(loadSession(conversation.id)).toMatchObject({
        id: conversation.id,
        cwd: workspace.worktreePath,
        workspace: { mode: 'managed', workspaceId: workspace.workspaceId, workspacePath: workspace.worktreePath },
      })
    } finally {
      if (previousHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = previousHome
    }
  }, HANDOFF_INTEGRATION_TIMEOUT_MS)
})

function makeGitRepository(): { sandbox: string; projectRoot: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-managed-workspace-'))
  sandboxes.push(sandbox)
  const projectRoot = join(sandbox, 'project')
  mkdirSync(projectRoot)
  git(projectRoot, 'init', '--quiet')
  git(projectRoot, 'config', 'user.name', 'OwlCoda Test')
  git(projectRoot, 'config', 'user.email', 'owlcoda-test@example.invalid')
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n')
  git(projectRoot, 'add', 'README.md')
  git(projectRoot, 'commit', '--quiet', '-m', 'fixture baseline')
  return { sandbox, projectRoot }
}

function createAuthorizedService(projectRoot: string) {
  return createManagedWorkspaceService({
    projectRoot,
    authorizeOperation: () => true,
  })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
