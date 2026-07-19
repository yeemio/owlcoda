/**
 * OwlCoda Native EnterWorktree Tool
 *
 * Creates an isolated git worktree and switches the session into it.
 * This allows working on branches without disturbing the main checkout.
 *
 * Upstream parity notes:
 * - Upstream uses createWorktreeForSession with slug validation
 * - Mutates CWD, originalCwd, clears system prompt caches
 * - Our version: straightforward `git worktree add` + process.chdir
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EnterWorktreeInput, NativeToolDef, ToolResult } from './types.js'
import {
  assertMatchingLedger,
  formatUntrackedWorktreePreflight,
  lifecycleLedgerPath,
  listHighRiskUntrackedFiles,
  readLifecycleLedger,
  validateWorktreeSlug,
  writeLifecycleLedger,
  type WorktreeLifecycleLedger,
} from './worktree-lifecycle.js'

/** Shared worktree session state. */
export interface WorktreeState {
  /** Whether we're currently in a worktree session. */
  inWorktree: boolean
  /** Path to the worktree directory. */
  worktreePath?: string
  /** Branch name in the worktree. */
  worktreeBranch?: string
  /** Original CWD before entering worktree. */
  originalCwd?: string
  /** Commit from which this managed worktree was created. */
  baseCommit?: string
  /** Durable lifecycle record required for managed cleanup. */
  ledgerPath?: string
}

/** Generate a random slug for unnamed worktrees. */
function randomSlug(): string {
  return `wt-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`
}

/** Find the git root for the current directory. */
function findGitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

export function createEnterWorktreeTool(state: WorktreeState): NativeToolDef<EnterWorktreeInput> {
  return {
    name: 'EnterWorktree',
    description:
      'Create an isolated git worktree and switch the session into it. ' +
      'Useful for working on branches without disturbing the main checkout.',
    maturity: 'beta' as const,

    async execute(input: EnterWorktreeInput): Promise<ToolResult> {
      if (state.inWorktree) {
        return {
          output: 'Already in a worktree session. Use ExitWorktree to return first.',
          isError: true,
        }
      }

      // Check we're in a git repo
      const gitRoot = findGitRoot()
      if (!gitRoot) {
        return {
          output: 'Not in a git repository. EnterWorktree requires a git repo.',
          isError: true,
        }
      }

      // Validate or generate slug
      const slug = input.name ?? randomSlug()
      if (input.name) {
        const err = validateWorktreeSlug(input.name)
        if (err) return { output: err, isError: true }
      }

      const branchName = `owlcoda/${slug}`
      const worktreePath = resolve(gitRoot, '..', `.owlcoda-worktrees`, slug)
      const ledgerPath = lifecycleLedgerPath(gitRoot, slug)

      if (existsSync(worktreePath)) {
        if (input.existing === 'resume') {
          try {
            const ledger = readLifecycleLedger(ledgerPath)
            assertMatchingLedger(ledger, { worktreePath, branch: branchName })
            const actualBranch = execFileSync('git', ['branch', '--show-current'], {
              cwd: worktreePath,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()
            if (actualBranch !== branchName) throw new Error(`worktree branch is ${actualBranch || '(detached)'}`)
            const originalCwd = process.cwd()
            process.chdir(worktreePath)
            state.inWorktree = true
            state.worktreePath = worktreePath
            state.worktreeBranch = branchName
            state.originalCwd = originalCwd
            state.baseCommit = ledger.baseCommit
            state.ledgerPath = ledgerPath
            writeLifecycleLedger(ledgerPath, { ...ledger, status: 'active', error: undefined })
            return {
              output: `Resumed managed worktree at ${worktreePath} on branch ${branchName}.`,
              isError: false,
              metadata: { worktreePath, worktreeBranch: branchName, baseCommit: ledger.baseCommit, ledgerPath, resumed: true },
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { output: `Cannot resume existing worktree: ${message}`, isError: true }
          }
        }
        return {
          output: `Worktree path already exists: ${worktreePath}. Choose a different name.`,
          isError: true,
        }
      }

      const riskyUntrackedFiles = listHighRiskUntrackedFiles(gitRoot)
      if (riskyUntrackedFiles.length > 0 && input.allow_untracked !== true) {
        return {
          output: formatUntrackedWorktreePreflight(riskyUntrackedFiles),
          isError: true,
          metadata: {
            preflightFailure: 'untracked_dependency_or_source_files',
            untrackedFiles: riskyUntrackedFiles,
          },
        }
      }

      const originalCwd = process.cwd()
      const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: gitRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      const now = new Date().toISOString()
      const ledger: WorktreeLifecycleLedger = {
        version: 1,
        slug,
        status: 'creating',
        gitRoot,
        originalCwd,
        worktreePath,
        branch: branchName,
        baseCommit,
        createdAt: now,
        updatedAt: now,
      }
      writeLifecycleLedger(ledgerPath, ledger)

      // Create the worktree
      try {
        execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
          cwd: gitRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        })
      } catch (err) {
        writeLifecycleLedger(ledgerPath, { ...ledger, status: 'creation_failed', error: (err as Error).message })
        return {
          output: `Failed to create worktree: ${(err as Error).message}`,
          isError: true,
        }
      }

      // Switch into it
      process.chdir(worktreePath)

      // Update state
      state.inWorktree = true
      state.worktreePath = worktreePath
      state.worktreeBranch = branchName
      state.originalCwd = originalCwd
      state.baseCommit = baseCommit
      state.ledgerPath = ledgerPath
      writeLifecycleLedger(ledgerPath, { ...ledger, status: 'active' })

      return {
        output:
          `Created worktree at ${worktreePath} on branch ${branchName}. ` +
          `Session is now working in the worktree. ` +
          `Use ExitWorktree to leave and return to ${originalCwd}.`,
        isError: false,
        metadata: {
          worktreePath,
          worktreeBranch: branchName,
          originalCwd,
          baseCommit,
          ledgerPath,
          ...(riskyUntrackedFiles.length > 0
            ? { untrackedPreflightBypassed: true, untrackedFiles: riskyUntrackedFiles }
            : {}),
        },
      }
    },
  }
}
