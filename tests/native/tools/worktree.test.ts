import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEnterWorktreeTool, type WorktreeState } from '../../../src/native/tools/enter-worktree.js'
import { createExitWorktreeTool } from '../../../src/native/tools/exit-worktree.js'

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

    const result = await exit.execute({ action: 'remove', discard_changes: true })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Removed worktree')
    expect(state.inWorktree).toBe(false)
    // Worktree directory should be gone (or at least we tried)
    expect(existsSync(wtPath)).toBe(false)
  })
})
