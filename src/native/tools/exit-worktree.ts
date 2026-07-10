/**
 * OwlCoda Native ExitWorktree Tool
 *
 * Exits a worktree session created by EnterWorktree and restores the
 * original working directory. Supports "keep" (preserve) or "remove" (delete).
 *
 * Upstream parity notes:
 * - Upstream counts uncommitted changes and new commits before removal
 * - Requires discard_changes=true when work exists
 * - Restores CWD, clears caches, kills tmux sessions
 * - Our version: same safety checks, simpler session management
 */

import { execFileSync } from 'node:child_process'
import type { ExitWorktreeInput, NativeToolDef, ToolResult } from './types.js'
import type { WorktreeState } from './enter-worktree.js'
import { assertMatchingLedger, readLifecycleLedger, writeLifecycleLedger } from './worktree-lifecycle.js'

/** Count uncommitted files and new commits in a worktree. */
function countChanges(worktreePath: string, baseCommit: string): { changedFiles: number; commits: number } | null {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    const changedFiles = status.split('\n').filter(l => l.trim() !== '').length

    const ahead = execFileSync('git', ['rev-list', '--count', `${baseCommit}..HEAD`], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const commits = parseInt(ahead.trim(), 10) || 0

    return { changedFiles, commits }
  } catch {
    return null
  }
}

export function createExitWorktreeTool(state: WorktreeState): NativeToolDef<ExitWorktreeInput> {
  return {
    name: 'ExitWorktree',
    description:
      'Exit a worktree session and return to the original directory. ' +
      'Use action "keep" to preserve the worktree or "remove" to delete it.',
    maturity: 'beta' as const,

    async execute(input: ExitWorktreeInput): Promise<ToolResult> {
      if (!state.inWorktree || !state.worktreePath || !state.originalCwd) {
        return {
          output:
            'No active worktree session to exit. This tool only operates on ' +
            'worktrees created by EnterWorktree in the current session.',
          isError: true,
        }
      }

      const { worktreePath, worktreeBranch, originalCwd, baseCommit, ledgerPath } = state

      let ledger
      if (input.action === 'remove') {
        if (!baseCommit || !ledgerPath) {
          return { output: 'Refusing managed cleanup: lifecycle ledger state is missing.', isError: true }
        }
        try {
          ledger = readLifecycleLedger(ledgerPath)
          assertMatchingLedger(ledger, { worktreePath, branch: worktreeBranch, baseCommit })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: `Refusing managed cleanup: lifecycle ledger is missing, corrupt, or mismatched (${message}).`, isError: true }
        }
      }

      // Safety check for removal
      let verifiedChanges = { changedFiles: 0, commits: 0 }
      if (input.action === 'remove') {
        const changes = countChanges(worktreePath, baseCommit!)
        if (changes === null) {
          return {
            output:
              `Could not verify worktree state at ${worktreePath}. ` +
              'Managed cleanup is fail-closed; use action: "keep" and inspect it manually.',
            isError: true,
          }
        }
        verifiedChanges = changes
        const { changedFiles, commits } = changes
        if (changedFiles > 0 && input.discard_changes !== true) {
          return {
            output: `Worktree has ${changedFiles} uncommitted file(s). Re-invoke with discard_changes=true, or use action: "keep".`,
            isError: true,
          }
        }
        if (commits > 0 && input.discard_commits !== true) {
          return {
            output: `Worktree has ${commits} commit(s) created after base ${baseCommit}. discard_changes does not authorize deleting commits; re-invoke with discard_commits=true or keep the worktree.`,
            isError: true,
          }
        }
      }

      // Return to original directory
      process.chdir(originalCwd)

      if (input.action === 'remove') {
        try {
          const removeArgs = ['worktree', 'remove']
          if (input.discard_changes === true) removeArgs.push('--force')
          removeArgs.push(worktreePath)
          execFileSync('git', removeArgs, {
            cwd: originalCwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          if (worktreeBranch) {
            execFileSync('git', ['branch', input.discard_commits === true ? '-D' : '-d', worktreeBranch], {
              cwd: originalCwd,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          }
          writeLifecycleLedger(ledgerPath!, {
            ...ledger!,
            status: 'removed',
            cleanup: {
              action: 'remove',
              ...verifiedChanges,
              discardChanges: input.discard_changes === true,
              discardCommits: input.discard_commits === true,
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeLifecycleLedger(ledgerPath!, { ...ledger!, status: 'cleanup_failed', error: message })
          return { output: `Failed to remove managed worktree: ${message}`, isError: true }
        }
      } else if (ledgerPath) {
        try {
          const keepLedger = readLifecycleLedger(ledgerPath)
          writeLifecycleLedger(ledgerPath, {
            ...keepLedger,
            status: 'kept',
            cleanup: { action: 'keep', changedFiles: 0, commits: 0, discardChanges: false, discardCommits: false },
          })
        } catch {
          // Keeping is non-destructive and remains available even if its audit record is unavailable.
        }
      }

      // Clear state
      state.inWorktree = false
      state.worktreePath = undefined
      state.worktreeBranch = undefined
      state.originalCwd = undefined
      state.baseCommit = undefined
      state.ledgerPath = undefined

      const actionLabel = input.action === 'keep' ? 'Kept' : 'Removed'
      const branchNote = worktreeBranch ? ` on branch ${worktreeBranch}` : ''

      return {
        output:
          `${actionLabel} worktree at ${worktreePath}${branchNote}. ` +
          `Session is now back in ${originalCwd}.`,
        isError: false,
        metadata: {
          action: input.action,
          worktreePath,
          worktreeBranch,
          originalCwd,
        },
      }
    },
  }
}
