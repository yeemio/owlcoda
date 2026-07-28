import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedWorkspaceService } from '../../../src/native/app-server/managed-workspace-service.js'

const sandboxes: string[] = []

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

describe('managed workspace host authorization', () => {
  it('keeps lifecycle mutation unavailable when the host has no authorizer', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-workspace-auth-'))
    sandboxes.push(sandbox)
    const projectRoot = join(sandbox, 'project')
    mkdirSync(projectRoot)
    git(projectRoot, 'init')
    git(projectRoot, 'config', 'user.email', 'security-test@example.invalid')
    git(projectRoot, 'config', 'user.name', 'Security Test')
    writeFileSync(join(projectRoot, 'README.md'), '# fixture\n')
    git(projectRoot, 'add', 'README.md')
    git(projectRoot, 'commit', '-m', 'fixture')

    const service = createManagedWorkspaceService({ projectRoot })

    expect(service.capability().available).toBe(false)
    expect(() => service.create({ slug: 'unauthorized-create', startingRef: 'HEAD' }))
      .toThrow(/trusted host authorization is unavailable/i)
    expect(git(projectRoot, 'branch', '--list', 'owlcoda/unauthorized-create')).toBe('')

    const bootstrap = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: () => true,
    })
    const seeded = bootstrap.create({ slug: 'authorized-seed', startingRef: 'HEAD' }).workspace
    expect(() => service.resume({ workspaceId: seeded.workspaceId }))
      .toThrow(/trusted host authorization is unavailable/i)
  })

  it('does not treat a client-supplied authorized boolean as mutation authority', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'owlcoda-workspace-auth-'))
    sandboxes.push(sandbox)
    const projectRoot = join(sandbox, 'project')
    mkdirSync(projectRoot)
    git(projectRoot, 'init')
    git(projectRoot, 'config', 'user.email', 'security-test@example.invalid')
    git(projectRoot, 'config', 'user.name', 'Security Test')
    writeFileSync(join(projectRoot, 'README.md'), '# fixture\n')
    git(projectRoot, 'add', 'README.md')
    git(projectRoot, 'commit', '-m', 'fixture')

    const bootstrap = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: () => true,
    })
    const workspace = bootstrap.create({ slug: 'untrusted-client', startingRef: 'HEAD' }).workspace
    const service = createManagedWorkspaceService({ projectRoot })
    expect(service.capability().available).toBe(false)
    writeFileSync(join(workspace.worktreePath, 'client-controlled.txt'), 'untrusted\n')
    const status = service.status({ workspaceId: workspace.workspaceId })

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'client-asserted-authority',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'must not commit',
    })).toThrow(/trusted host authorization/i)
  })

  it('requires the host authorizer to return an explicit allow decision', () => {
    const { projectRoot } = makeGitRepository('explicit-deny')
    const service = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: () => false,
    })
    const workspace = service.create({ slug: 'explicit-deny', startingRef: 'HEAD' }).workspace
    writeFileSync(join(workspace.worktreePath, 'candidate.txt'), 'candidate\n')
    const status = service.status({ workspaceId: workspace.workspaceId })

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'host-denied',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'must not commit',
    })).toThrow(/trusted host authorization.*denied/i)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(status.head)
  })

  it('does not accept an asynchronous result from the synchronous host boundary', () => {
    const { projectRoot } = makeGitRepository('async-authorizer')
    const service = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: (() => Promise.resolve(true)) as any,
    })
    const workspace = service.create({ slug: 'async-authorizer', startingRef: 'HEAD' }).workspace
    writeFileSync(join(workspace.worktreePath, 'candidate.txt'), 'candidate\n')
    const status = service.status({ workspaceId: workspace.workspaceId })

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'async-authorizer',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'must not commit',
    })).toThrow(/trusted host authorization.*denied/i)
  })

  it('binds host authorization to the observed workspace state and request digest', () => {
    const { projectRoot } = makeGitRepository('exact-binding')
    let observedBinding: Record<string, unknown> | undefined
    const service = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: binding => {
        observedBinding = { ...binding }
        return true
      },
    })
    const workspace = service.create({ slug: 'exact-binding', startingRef: 'HEAD' }).workspace
    writeFileSync(join(workspace.worktreePath, 'candidate.txt'), 'candidate\n')
    const status = service.status({ workspaceId: workspace.workspaceId })

    service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'exact-binding',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'authorized commit',
    })

    expect(observedBinding).toMatchObject({
      action: 'commit',
      workspaceId: workspace.workspaceId,
      currentHead: status.head,
      currentStatusFingerprint: status.statusFingerprint,
      requestId: 'exact-binding',
    })
    expect(observedBinding?.['requestSha256']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects content drift introduced while the host decision is being made', () => {
    const { projectRoot } = makeGitRepository('content-drift')
    let candidatePath = ''
    const service = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: () => {
        writeFileSync(candidatePath, 'changed after review\n')
        return true
      },
    })
    const workspace = service.create({ slug: 'content-drift', startingRef: 'HEAD' }).workspace
    candidatePath = join(workspace.worktreePath, 'candidate.txt')
    writeFileSync(candidatePath, 'reviewed bytes\n')
    const status = service.status({ workspaceId: workspace.workspaceId })

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'content-drift',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'must not commit drifted bytes',
    })).toThrow(/changed after review/i)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(status.head)
  })

  it('binds authorization to an untracked file executable mode', () => {
    const { projectRoot } = makeGitRepository('mode-drift')
    let candidatePath = ''
    const service = createManagedWorkspaceService({
      projectRoot,
      authorizeOperation: () => {
        chmodSync(candidatePath, 0o755)
        return true
      },
    })
    const workspace = service.create({ slug: 'mode-drift', startingRef: 'HEAD' }).workspace
    candidatePath = join(workspace.worktreePath, 'candidate.sh')
    writeFileSync(candidatePath, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const status = service.status({ workspaceId: workspace.workspaceId })

    expect(() => service.commit({
      workspaceId: workspace.workspaceId,
      requestId: 'mode-drift',
      expectedHead: status.head,
      expectedStatusFingerprint: status.statusFingerprint,
      authorized: true,
      message: 'must not commit changed mode',
    })).toThrow(/changed after review/i)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(status.head)
  })
})

function makeGitRepository(name: string): { projectRoot: string } {
  const sandbox = mkdtempSync(join(tmpdir(), `owlcoda-workspace-auth-${name}-`))
  sandboxes.push(sandbox)
  const projectRoot = join(sandbox, 'project')
  mkdirSync(projectRoot)
  git(projectRoot, 'init')
  git(projectRoot, 'config', 'user.email', 'security-test@example.invalid')
  git(projectRoot, 'config', 'user.name', 'Security Test')
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n')
  git(projectRoot, 'add', 'README.md')
  git(projectRoot, 'commit', '-m', 'fixture')
  return { projectRoot }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
