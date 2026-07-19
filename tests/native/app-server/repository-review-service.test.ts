import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listRepositoryUnstagedChanges } from '../../../src/native/app-server/repository-review-service.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('repository review service', () => {
  it('lists tracked, untracked, binary, and unusual-path worktree changes without leaking excluded runtime artifacts', () => {
    const root = makeGitRepository()
    writeFileSync(join(root, 'modified.txt'), 'before\n', 'utf8')
    writeFileSync(join(root, 'deleted.txt'), 'remove me\n', 'utf8')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    commitAll(root)

    writeFileSync(join(root, 'modified.txt'), 'after\n', 'utf8')
    unlinkSync(join(root, 'deleted.txt'))
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 8, 9, 10]))
    writeFileSync(join(root, 'added.txt'), 'intent to add\n', 'utf8')
    execFileSync('git', ['add', '--intent-to-add', '--', 'added.txt'], { cwd: root })
    const unusualPath = 'odd\tline\n雪.txt'
    writeFileSync(join(root, unusualPath), 'unusual\n', 'utf8')
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n', 'utf8')
    writeExcludedArtifacts(root)

    const result = listRepositoryUnstagedChanges({ projectRoot: root })

    expect(result.scope).toMatchObject({
      status: 'ready',
      changeCount: 6,
      excludedCount: 4,
    })
    expect(result.changes.map(change => [change.path, change.operation])).toEqual(expect.arrayContaining([
      ['modified.txt', 'modified'],
      ['deleted.txt', 'deleted'],
      ['binary.dat', 'modified'],
      ['added.txt', 'added'],
      [unusualPath, 'untracked'],
      ['untracked.txt', 'untracked'],
    ]))
    expect(result.changes.find(change => change.path === 'binary.dat')).toMatchObject({
      binary: true,
      diffPreview: 'Binary file changed.',
      truncated: false,
    })
    expect(result.changes.find(change => change.path === unusualPath)?.diffPreview).toContain('unusual')
    expect(result.changes.some(change => change.path.startsWith('.owlrunkit/executions/'))).toBe(false)
    expect(result.changes.some(change => change.path.startsWith('.owlcoda/'))).toBe(false)
    expect(result.changes.some(change => change.path.startsWith('desktop/osui/output/'))).toBe(false)
    expect(result.changes.some(change => change.path.startsWith('docs/execution-prompts/integration/'))).toBe(false)
  })

  it('resolves repository-wide truth when the project root is a nested directory', () => {
    const root = makeGitRepository()
    mkdirSync(join(root, 'packages', 'nested'), { recursive: true })
    writeFileSync(join(root, 'root.txt'), 'before\n', 'utf8')
    commitAll(root)
    writeFileSync(join(root, 'root.txt'), 'after\n', 'utf8')

    const result = listRepositoryUnstagedChanges({ projectRoot: join(root, 'packages', 'nested') })

    expect(result.scope.status).toBe('ready')
    expect(result.changes.map(change => change.path)).toEqual(['root.txt'])
  })

  it('returns current whole-file text evidence for Review without following symlinks', () => {
    const root = makeGitRepository()
    writeFileSync(join(root, 'modified.txt'), 'before\n', 'utf8')
    writeFileSync(join(root, 'deleted.txt'), 'remove me\n', 'utf8')
    commitAll(root)

    writeFileSync(join(root, 'modified.txt'), 'after\n', 'utf8')
    unlinkSync(join(root, 'deleted.txt'))
    writeFileSync(join(root, 'untracked.txt'), 'new file\n', 'utf8')

    const result = listRepositoryUnstagedChanges({ projectRoot: root })
    const byPath = new Map(result.changes.map(change => [change.path, change]))

    expect(byPath.get('modified.txt')).toMatchObject({ oldText: 'before\n', newText: 'after\n' })
    expect(byPath.get('deleted.txt')).toMatchObject({ oldText: 'remove me\n', newText: '' })
    expect(byPath.get('untracked.txt')).toMatchObject({ oldText: null, newText: 'new file\n' })
  })

  it('fails closed outside a Git repository', () => {
    const root = makeRoot()

    const result = listRepositoryUnstagedChanges({ projectRoot: root })

    expect(result.changes).toEqual([])
    expect(result.scope).toMatchObject({
      status: 'unavailable',
      reason: 'not_git_repository',
      changeCount: 0,
      excludedCount: 0,
    })
  })

  it('fails closed when Git cannot be executed', () => {
    const root = makeGitRepository()
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n', 'utf8')

    const result = listRepositoryUnstagedChanges({
      projectRoot: root,
      gitBinary: join(root, 'missing-git-binary'),
    })

    expect(result.changes).toEqual([])
    expect(result.scope).toMatchObject({
      status: 'unavailable',
      reason: 'git_status_failed',
      changeCount: 0,
      excludedCount: 0,
    })
  })

  it('discards partial repository results when a diff cannot be read', () => {
    const root = makeGitRepository()
    writeFileSync(join(root, 'tracked.txt'), 'before\n', 'utf8')
    commitAll(root)
    writeFileSync(join(root, 'tracked.txt'), 'after\n', 'utf8')
    const wrapper = join(root, 'git-with-failing-diff')
    writeFileSync(wrapper, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "diff" ]; then exit 2; fi',
      'done',
      'exec git "$@"',
      '',
    ].join('\n'), 'utf8')
    chmodSync(wrapper, 0o755)

    const result = listRepositoryUnstagedChanges({ projectRoot: root, gitBinary: wrapper })

    expect(result.changes).toEqual([])
    expect(result.scope).toMatchObject({
      status: 'unavailable',
      reason: 'git_diff_failed',
      changeCount: 0,
      excludedCount: 0,
    })
  })

  it('returns bounded markers for tracked and untracked binary files larger than the diff buffer', () => {
    const root = makeGitRepository()
    const binarySize = 17 * 1024 * 1024
    writeFileSync(join(root, 'large-tracked.bin'), randomBytes(binarySize))
    commitAll(root)
    writeFileSync(join(root, 'large-tracked.bin'), randomBytes(binarySize))
    writeFileSync(join(root, 'large-untracked.bin'), randomBytes(binarySize))

    const result = listRepositoryUnstagedChanges({ projectRoot: root })

    expect(result.scope.status).toBe('ready')
    expect(result.changes).toEqual([
      expect.objectContaining({
        path: 'large-tracked.bin',
        operation: 'modified',
        binary: true,
        diffPreview: 'Binary file changed.',
        truncated: false,
      }),
      expect.objectContaining({
        path: 'large-untracked.bin',
        operation: 'untracked',
        binary: true,
        diffPreview: 'Binary file changed.',
        truncated: false,
      }),
    ])
  })

  it('caps large text previews and marks them truncated', () => {
    const root = makeGitRepository()
    writeFileSync(join(root, 'large-text.txt'), 'line\n'.repeat(50_000), 'utf8')

    const result = listRepositoryUnstagedChanges({ projectRoot: root })

    expect(result.scope.status).toBe('ready')
    expect(result.changes[0]).toMatchObject({
      path: 'large-text.txt',
      binary: false,
      truncated: true,
    })
    expect(result.changes[0]?.diffPreview).toHaveLength(200_000)
  })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-repository-review-'))
  roots.push(root)
  return root
}

function makeGitRepository(): string {
  const root = makeRoot()
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'OwlCoda Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'owlcoda-test@example.invalid'], { cwd: root })
  return root
}

function commitAll(root: string): void {
  execFileSync('git', ['add', '--all'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'test baseline'], { cwd: root })
}

function writeExcludedArtifacts(root: string): void {
  const paths = [
    '.owlrunkit/executions/run-1/raw.json',
    '.owlcoda/app-server/state.json',
    'desktop/osui/output/delivery-packet.json',
    'docs/execution-prompts/integration/run-1/delivery-packet.json',
  ]
  for (const path of paths) {
    const absolutePath = join(root, path)
    mkdirSync(join(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, '{}\n', 'utf8')
  }
}
