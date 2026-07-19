import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMethodRegistry, handleRequest } from '../../../src/native/app-server/methods.js'

const sandboxes: string[] = []
const originalOwlCodaHome = process.env['OWLCODA_HOME']

afterEach(() => {
  if (originalOwlCodaHome === undefined) delete process.env['OWLCODA_HOME']
  else process.env['OWLCODA_HOME'] = originalOwlCodaHome
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

describe('managed workspace App Server contract', () => {
  it('reports managed unavailable outside a Git repository', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-managed-methods-nongit-'))
    sandboxes.push(sandbox)
    const registry = createMethodRegistry({ projectRoot: sandbox })

    expect((await request(registry, 'model/list', {})).result).toMatchObject({
      workspaceModes: [{ id: 'project', available: true }, { id: 'managed', available: false }],
    })
  })

  it('exposes create/list/read/resume and reports managed capability from Git truth', async () => {
    const { sandbox, projectRoot } = makeGitRepository()
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    const registry = createMethodRegistry({ projectRoot })

    const modelList = await request(registry, 'model/list', {})
    expect(modelList.result).toMatchObject({
      workspaceModes: [{ id: 'project', available: true }, { id: 'managed', available: true }],
    })

    const created = await request(registry, 'workspace/create', { slug: 'desktop-task', startingRef: 'HEAD' })
    expect(created.result.workspace).toMatchObject({
      slug: 'desktop-task',
      status: 'active',
      projectRoot,
      branch: 'owlcoda/desktop-task',
    })
    const workspaceId = created.result.workspace.workspaceId as string

    const listed = await request(registry, 'workspace/list', {})
    expect(listed.result.workspaces).toEqual([created.result.workspace])
    expect((await request(registry, 'workspace/read', { workspaceId })).result.workspace).toEqual(created.result.workspace)
    expect(await request(registry, 'workspace/resume', { workspaceId })).toMatchObject({
      result: {
        resumed: true,
        workspace: {
          workspaceId,
          status: 'active',
          worktreePath: created.result.workspace.worktreePath,
          branch: created.result.workspace.branch,
          baseCommit: created.result.workspace.baseCommit,
        },
      },
    })
  })

  it('requires explicit current-state authorization for commit and cleanup operations', async () => {
    const { sandbox, projectRoot } = makeGitRepository()
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    const registry = createMethodRegistry({ projectRoot })
    const created = await request(registry, 'workspace/create', { slug: 'authorized-task', startingRef: 'HEAD' })
    const workspace = created.result.workspace
    writeFileSync(join(workspace.worktreePath, 'managed-change.txt'), 'managed change\n')

    const dirty = (await request(registry, 'workspace/status', { workspaceId: workspace.workspaceId })).result
    expect(dirty).toMatchObject({ clean: false, changedFiles: 1, commitsAhead: 0 })

    const rejected = await request(registry, 'workspace/commit', {
      workspaceId: workspace.workspaceId,
      requestId: 'commit-1',
      message: 'commit managed change',
      expectedHead: dirty.head,
      expectedStatusFingerprint: dirty.statusFingerprint,
      authorized: false,
    })
    expect(rejected.error).toMatchObject({ code: -32602 })
    expect(rejected.error.message).toMatch(/explicit authorization/i)

    const commitInput = {
      workspaceId: workspace.workspaceId,
      requestId: 'commit-1',
      message: 'commit managed change',
      expectedHead: dirty.head,
      expectedStatusFingerprint: dirty.statusFingerprint,
      authorized: true,
    }
    const committed = await request(registry, 'workspace/commit', commitInput)
    expect(committed.result.receipt).toMatchObject({
      action: 'commit',
      requestId: 'commit-1',
      workspaceId: workspace.workspaceId,
      authorizationConfirmed: true,
      worktreePresentAfter: true,
      branchRetained: true,
    })
    expect((await request(registry, 'workspace/commit', commitInput)).result).toEqual(committed.result)

    const clean = (await request(registry, 'workspace/status', { workspaceId: workspace.workspaceId })).result
    expect(clean).toMatchObject({ clean: true, changedFiles: 0, commitsAhead: 1 })
    const cleaned = await request(registry, 'workspace/cleanup', {
      workspaceId: workspace.workspaceId,
      requestId: 'cleanup-1',
      expectedHead: clean.head,
      expectedStatusFingerprint: clean.statusFingerprint,
      authorized: true,
    })
    expect(cleaned.result.receipt).toMatchObject({
      action: 'cleanup',
      workspaceId: workspace.workspaceId,
      worktreePresentAfter: false,
      branchRetained: true,
    })
    expect(existsSync(workspace.worktreePath)).toBe(false)
    expect(git(projectRoot, 'branch', '--list', workspace.branch)).toContain(workspace.branch)
  }, 15_000)

  it('persists managed thread identity only from the ledger-backed worktree runtime', async () => {
    const { sandbox, projectRoot } = makeGitRepository()
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    const rootRegistry = createMethodRegistry({ projectRoot })
    const created = await request(rootRegistry, 'workspace/create', { slug: 'thread-task', startingRef: 'HEAD' })
    const workspace = created.result.workspace

    const rejected = await request(rootRegistry, 'thread/start', { title: 'wrong runtime', workspaceMode: 'managed' })
    expect(rejected.error).toMatchObject({ code: -32602 })
    expect(rejected.error.message).toMatch(/managed workspace App Server/i)

    const managedRegistry = createMethodRegistry({ projectRoot: workspace.worktreePath })
    const started = await request(managedRegistry, 'thread/start', {
      title: 'managed thread',
      workspaceMode: 'managed',
    })

    expect(started.result.thread).toMatchObject({
      workspaceMode: 'managed',
      workspace: {
        mode: 'managed',
        workspaceId: workspace.workspaceId,
        projectRoot,
        workspacePath: workspace.worktreePath,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
      },
    })

    const turn = await request(managedRegistry, 'turn/start', {
      threadId: started.result.thread.id,
      input: 'persist the managed workspace identity',
    })
    expect(turn.result.thread.workspace).toEqual(started.result.thread.workspace)

    const read = await request(managedRegistry, 'thread/read', { threadId: started.result.thread.id })
    expect(read.result.thread.workspace).toEqual(started.result.thread.workspace)

    const resumed = await request(managedRegistry, 'thread/resume', { threadId: started.result.thread.id })
    expect(resumed.result.thread.workspace).toEqual(started.result.thread.workspace)
  })

  it('declares the explicit workspace handoff contract', async () => {
    const { sandbox, projectRoot } = makeGitRepository()
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    const registry = createMethodRegistry({ projectRoot })

    const protocol = (await request(registry, 'protocol/describe', {})).result
    expect(protocol.methods).toContainEqual(expect.objectContaining({
      method: 'workspace/handoff',
      requestType: 'ManagedWorkspaceHandoffInput',
      responseType: 'ManagedWorkspaceOperationResult',
      requires: [
        'workspaceId',
        'threadId',
        'direction',
        'requestId',
        'expectedHead',
        'expectedStatusFingerprint',
        'expectedProjectHead',
        'expectedProjectStatusFingerprint',
        'authorized',
      ],
    }))
  })

  it('hands one persisted thread and branch between its managed worktree and Local', async () => {
    const { sandbox, projectRoot } = makeGitRepository()
    process.env['OWLCODA_HOME'] = join(sandbox, 'owlcoda-home')
    let releaseLoop!: () => void
    let markLoopStarted!: () => void
    const loopStarted = new Promise<void>(resolve => { markLoopStarted = resolve })
    const rootRegistry = createMethodRegistry({
      projectRoot,
      loopOptions: { apiBaseUrl: 'http://loop.test', apiKey: 'test-key' },
      loopRunner: async (conversation: any) => {
        markLoopStarted()
        await new Promise<void>(resolve => { releaseLoop = resolve })
        return {
          conversation,
          finalText: 'handoff loop complete',
          iterations: 1,
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
          runtimeFailure: null,
        }
      },
    } as any)
    const created = await request(rootRegistry, 'workspace/create', { slug: 'handoff-task', startingRef: 'HEAD' })
    const workspace = created.result.workspace
    const managedRegistry = createMethodRegistry({ projectRoot: workspace.worktreePath })
    const started = await request(managedRegistry, 'thread/start', {
      title: 'handoff thread',
      workspaceMode: 'managed',
    })
    const threadId = started.result.thread.id as string

    const managedStatus = (await request(rootRegistry, 'workspace/status', {
      workspaceId: workspace.workspaceId,
    })).result
    const toProjectInput = {
      workspaceId: workspace.workspaceId,
      threadId,
      direction: 'to_project',
      requestId: 'handoff-to-project-1',
      expectedHead: managedStatus.head,
      expectedStatusFingerprint: managedStatus.statusFingerprint,
      expectedProjectHead: managedStatus.project.head,
      expectedProjectStatusFingerprint: managedStatus.project.statusFingerprint,
    }

    const unauthorized = await request(rootRegistry, 'workspace/handoff', {
      ...toProjectInput,
      authorized: false,
    })
    expect(unauthorized.error).toMatchObject({ code: -32602 })
    expect(unauthorized.error.message).toMatch(/explicit authorization/i)

    const movedToProject = await request(rootRegistry, 'workspace/handoff', {
      ...toProjectInput,
      authorized: true,
    })
    expect(movedToProject.result.receipt).toMatchObject({
      action: 'handoff',
      direction: 'to_project',
      threadId,
      branchOwnerBefore: 'managed',
      branchOwnerAfter: 'project',
      authorizationConfirmed: true,
    })
    expect(git(projectRoot, 'branch', '--show-current')).toBe(workspace.branch)
    expect(git(workspace.worktreePath, 'branch', '--show-current')).toBe('')
    expect((await request(rootRegistry, 'thread/read', { threadId })).result.thread.workspace).toMatchObject({
      mode: 'project',
      projectRoot,
      workspacePath: projectRoot,
    })

    const running = await request(rootRegistry, 'turn/start', {
      threadId,
      input: 'keep this turn active during handoff',
    })
    expect(running.result).toMatchObject({ runtimeStarted: true, runtimeStatus: 'running' })
    await loopStarted

    const activeProjectStatus = (await request(rootRegistry, 'workspace/status', {
      workspaceId: workspace.workspaceId,
    })).result
    const blockedWhileActive = await request(rootRegistry, 'workspace/handoff', {
      workspaceId: workspace.workspaceId,
      threadId,
      direction: 'to_managed',
      requestId: 'handoff-active-turn',
      expectedHead: activeProjectStatus.head,
      expectedStatusFingerprint: activeProjectStatus.statusFingerprint,
      expectedProjectHead: activeProjectStatus.project.head,
      expectedProjectStatusFingerprint: activeProjectStatus.project.statusFingerprint,
      authorized: true,
    })
    expect(blockedWhileActive.error).toMatchObject({ code: -32602 })
    expect(blockedWhileActive.error.message).toMatch(/active turn/i)
    releaseLoop()
    await new Promise(resolve => setTimeout(resolve, 10))

    const projectStatus = (await request(rootRegistry, 'workspace/status', {
      workspaceId: workspace.workspaceId,
    })).result
    const movedToManaged = await request(rootRegistry, 'workspace/handoff', {
      workspaceId: workspace.workspaceId,
      threadId,
      direction: 'to_managed',
      requestId: 'handoff-to-managed-1',
      expectedHead: projectStatus.head,
      expectedStatusFingerprint: projectStatus.statusFingerprint,
      expectedProjectHead: projectStatus.project.head,
      expectedProjectStatusFingerprint: projectStatus.project.statusFingerprint,
      authorized: true,
    })
    expect(movedToManaged.result.receipt).toMatchObject({
      action: 'handoff',
      direction: 'to_managed',
      threadId,
      branchOwnerBefore: 'project',
      branchOwnerAfter: 'managed',
    })
    expect(git(workspace.worktreePath, 'branch', '--show-current')).toBe(workspace.branch)
    expect((await request(managedRegistry, 'thread/read', { threadId })).result.thread.workspace).toMatchObject({
      mode: 'managed',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.worktreePath,
    })
  }, 15_000)
})

function makeGitRepository(): { sandbox: string; projectRoot: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-managed-methods-'))
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function request(registry: ReturnType<typeof createMethodRegistry>, method: string, params: Record<string, unknown>) {
  return handleRequest(registry, { jsonrpc: '2.0', id: method, method, params }) as Promise<any>
}
