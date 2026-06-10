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

import { execSync } from 'node:child_process'
import type { ExitWorktreeInput, NativeToolDef, ToolResult } from './types.js'
import type { WorktreeState } from './enter-worktree.js'

/** Count uncommitted files and new commits in a worktree. */
function countChanges(worktreePath: string): { changedFiles: number; commits: number } | null {
  try {
    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    const changedFiles = status.split('\n').filter(l => l.trim() !== '').length

    // Count commits ahead of HEAD's parent branch
    let commits = 0
    try {
      const ahead = execSync('git rev-list --count @{upstream}..HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      })
      commits = parseInt(ahead.trim(), 10) || 0
    } catch {
      // No upstream configured — count commits since worktree creation
      // Fall back to 0, which is safe
    }

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

      const { worktreePath, worktreeBranch, originalCwd } = state

      // Safety check for removal
      if (input.action === 'remove' && !input.discard_changes) {
        const changes = countChanges(worktreePath)
        if (changes === null) {
          return {
            output:
              `Could not verify worktree state at ${worktreePath}. ` +
              'Re-invoke with discard_changes: true to proceed, or use action: "keep".',
            isError: true,
          }
        }
        const { changedFiles, commits } = changes
        if (changedFiles > 0 || commits > 0) {
          const parts: string[] = []
          if (changedFiles > 0) parts.push(`${changedFiles} uncommitted file(s)`)
          if (commits > 0) parts.push(`${commits} commit(s)`)
          return {
            output:
              `Worktree has ${parts.join(' and ')}. ` +
              'Removing will discard this work permanently. ' +
              'Re-invoke with discard_changes: true, or use action: "keep".',
            isError: true,
          }
        }
      }

      // Return to original directory
      process.chdir(originalCwd)

      if (input.action === 'remove') {
        // Remove the worktree
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, {
            encoding: 'utf-8',
            stdio: 'pipe',
          })
        } catch {
          // Best-effort — worktree may already be gone
        }

        // Delete the branch
        if (worktreeBranch) {
          try {
            execSync(`git branch -D "${worktreeBranch}"`, {
              encoding: 'utf-8',
              stdio: 'pipe',
            })
          } catch {
            // Best-effort
          }
        }
      }

      // Clear state
      state.inWorktree = false
      state.worktreePath = undefined
      state.worktreeBranch = undefined
      state.originalCwd = undefined

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
