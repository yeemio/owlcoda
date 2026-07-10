import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEnterWorktreeTool, type WorktreeState } from '../../../src/native/tools/enter-worktree.js'
import { createExitWorktreeTool } from '../../../src/native/tools/exit-worktree.js'
import { lifecycleLedgerPath } from '../../../src/native/tools/worktree-lifecycle.js'

function makeTmpGitRepo(): string {
  const raw = join(tmpdir(), `owlcoda-wt-test-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  const dir = realpathSync(raw)
  mkdirSync(dir, { recursive: true })
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    stdio: 'pipe',
  })
  return dir
}

describe('EnterWorktree tool', () => {
  let tmpRepo: string
  let savedCwd: string

  beforeEach(() => {
    savedCwd = process.cwd()
    tmpRepo = makeTmpGitRepo()
    process.chdir(tmpRepo)
  })

  afterEach(() => {
    process.chdir(savedCwd)
    if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    // Clean up worktree dir
    const wtDir = join(tmpRepo, '..', '.owlcoda-worktrees')
    if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    expect(tool.name).toBe('EnterWorktree')
  })

  it('creates a worktree and changes CWD', async () => {
    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({ name: 'test-branch' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Created worktree')
    expect(result.output).toContain('owlcoda/test-branch')
    expect(state.inWorktree).toBe(true)
    expect(state.worktreePath).toBeDefined()
    expect(process.cwd()).toBe(state.worktreePath)
    // Restore CWD for cleanup
    process.chdir(savedCwd)
  }, 20_000)
  // 0.13.98: 5s default tripped under full-suite load. This test does
  // git init + commit (in beforeEach) + git worktree add + chdir + tmpfs
  // write — multiple syscall round-trips. Under cold disk cache and
  // contention with parallel test workers the chain can exceed 5s. 20s
  // matches the conservative tier already used by other slow integration
  // tests in this repo.

  it('preflights untracked dependency/source files before creating a worktree', async () => {
    writeFileSync(join(tmpRepo, 'package-lock.json'), '{}\n')
    mkdirSync(join(tmpRepo, 'src'), { recursive: true })
    writeFileSync(join(tmpRepo, 'src', 'new-helper.ts'), 'export const answer = 42\n')

    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({ name: 'dirty-preflight' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('untracked dependency/source files')
    expect(result.output).toContain('package-lock.json')
    expect(result.output).toContain('src/new-helper.ts')
    expect(result.metadata).toMatchObject({
      preflightFailure: 'untracked_dependency_or_source_files',
      untrackedFiles: ['package-lock.json', 'src/new-helper.ts'],
    })
    expect(state.inWorktree).toBe(false)
    expect(existsSync(join(tmpRepo, '..', '.owlcoda-worktrees', 'dirty-preflight'))).toBe(false)
  })

  it('allows explicit override of untracked worktree preflight', async () => {
    writeFileSync(join(tmpRepo, 'package-lock.json'), '{}\n')

    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({ name: 'dirty-override', allow_untracked: true } as any)

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Created worktree')
    expect(result.metadata).toMatchObject({
      untrackedPreflightBypassed: true,
      untrackedFiles: ['package-lock.json'],
    })
    process.chdir(savedCwd)
  }, 20_000)

  it('resumes an existing managed worktree from its lifecycle ledger', async () => {
    const firstState: WorktreeState = { inWorktree: false }
    const firstEnter = createEnterWorktreeTool(firstState)
    const firstExit = createExitWorktreeTool(firstState)
    await firstEnter.execute({ name: 'resume-test' })
    const wtPath = firstState.worktreePath
    await firstExit.execute({ action: 'keep' })

    const resumedState: WorktreeState = { inWorktree: false }
    const result = await createEnterWorktreeTool(resumedState).execute({
      name: 'resume-test',
      existing: 'resume',
    })

    expect(result.isError).toBe(false)
    expect(result.metadata?.resumed).toBe(true)
    expect(resumedState.worktreePath).toBe(wtPath)
    expect(resumedState.baseCommit).toBeTruthy()
    expect(resumedState.ledgerPath).toBeTruthy()
  }, 20_000)

  it('keeps lifecycle ledger paths distinct when normalized slugs would collide', () => {
    const slashSlug = lifecycleLedgerPath(tmpRepo, 'a/b')
    const underscoreSlug = lifecycleLedgerPath(tmpRepo, 'a_b')

    expect(slashSlug).not.toBe(underscoreSlug)
  })

  it('rejects if already in worktree', async () => {
    const state: WorktreeState = { inWorktree: true, worktreePath: '/tmp/x', originalCwd: savedCwd }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Already in a worktree')
  })

  it('rejects invalid slug', async () => {
    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({ name: 'invalid slug!@#' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('may only contain')
  })

  it('rejects when not in a git repo', async () => {
    const noGitDir = join(tmpdir(), `owlcoda-wt-nogit-${Date.now()}`)
    mkdirSync(noGitDir, { recursive: true })
    process.chdir(noGitDir)
    const state: WorktreeState = { inWorktree: false }
    const tool = createEnterWorktreeTool(state)
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Not in a git repository')
    process.chdir(savedCwd)
    rmSync(noGitDir, { recursive: true })
  })
})

describe('ExitWorktree tool', () => {
  let tmpRepo: string
  let savedCwd: string

  beforeEach(() => {
    savedCwd = process.cwd()
    tmpRepo = makeTmpGitRepo()
    process.chdir(tmpRepo)
  })

  afterEach(() => {
    process.chdir(savedCwd)
    if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    const wtDir = join(tmpRepo, '..', '.owlcoda-worktrees')
    if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true })
  })

  it('has correct name', () => {
    const state: WorktreeState = { inWorktree: false }
    const tool = createExitWorktreeTool(state)
    expect(tool.name).toBe('ExitWorktree')
  })

  it('errors when no worktree session is active', async () => {
    const state: WorktreeState = { inWorktree: false }
    const tool = createExitWorktreeTool(state)
    const result = await tool.execute({ action: 'keep' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No active worktree session')
  })

  it('keeps and exits a worktree', async () => {
    // First enter
    const state: WorktreeState = { inWorktree: false }
    const enter = createEnterWorktreeTool(state)
    const exit = createExitWorktreeTool(state)
    await enter.execute({ name: 'keep-test' })
    expect(state.inWorktree).toBe(true)

    // Now exit with keep
    const result = await exit.execute({ action: 'keep' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Kept worktree')
    expect(state.inWorktree).toBe(false)
    expect(process.cwd()).toBe(tmpRepo)
  })

  it('removes and exits a worktree', async () => {
    const state: WorktreeState = { inWorktree: false }
    const enter = createEnterWorktreeTool(state)
    const exit = createExitWorktreeTool(state)
    await enter.execute({ name: 'rm-test' })
    const wtPath = state.worktreePath!
    const ledgerPath = state.ledgerPath!

    const result = await exit.execute({ action: 'remove', discard_changes: true })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Removed worktree')
    expect(state.inWorktree).toBe(false)
    // Worktree directory should be gone (or at least we tried)
    expect(existsSync(wtPath)).toBe(false)
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
      status: 'removed',
      cleanup: { action: 'remove', discardChanges: true, discardCommits: false },
    })
  })

  it('does not let discard_changes delete commits created after the worktree base', async () => {
    const state: WorktreeState = { inWorktree: false }
    const enter = createEnterWorktreeTool(state)
    const exit = createExitWorktreeTool(state)
    await enter.execute({ name: 'commit-protection' })
    const wtPath = state.worktreePath!
    writeFileSync(join(wtPath, 'committed.txt'), 'keep me\n')
    execSync('git add committed.txt && git commit -m "worktree commit"', { cwd: wtPath, stdio: 'pipe' })

    const result = await exit.execute({ action: 'remove', discard_changes: true })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('discard_commits')
    expect(existsSync(wtPath)).toBe(true)
    expect(execSync('git branch --list owlcoda/commit-protection', { cwd: tmpRepo, encoding: 'utf8' })).toContain('owlcoda/commit-protection')
  })

  it.each(['missing', 'corrupt'])('fails closed when the lifecycle ledger is %s', async (mode) => {
    const state: WorktreeState = { inWorktree: false }
    const enter = createEnterWorktreeTool(state)
    const exit = createExitWorktreeTool(state)
    await enter.execute({ name: `ledger-${mode}` })
    const wtPath = state.worktreePath!
    const ledgerPath = state.ledgerPath!
    if (mode === 'missing') unlinkSync(ledgerPath)
    else writeFileSync(ledgerPath, '{not valid json')

    const result = await exit.execute({
      action: 'remove',
      discard_changes: true,
      discard_commits: true,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('lifecycle ledger')
    expect(existsSync(wtPath)).toBe(true)
    expect(execSync(`git branch --list owlcoda/ledger-${mode}`, { cwd: tmpRepo, encoding: 'utf8' })).toContain(`owlcoda/ledger-${mode}`)
  })
})
