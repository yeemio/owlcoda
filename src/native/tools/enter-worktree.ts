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

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EnterWorktreeInput, NativeToolDef, ToolResult } from './types.js'

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
}

/** Validate worktree slug — letters, digits, dots, underscores, dashes; max 64 chars. */
function validateSlug(slug: string): string | null {
  if (slug.length > 64) return 'Slug must be 64 characters or fewer.'
  if (!/^[a-zA-Z0-9._/-]+$/.test(slug)) {
    return 'Slug may only contain letters, digits, dots, underscores, dashes, and slashes.'
  }
  return null
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
        const err = validateSlug(input.name)
        if (err) return { output: err, isError: true }
      }

      const branchName = `owlcoda/${slug}`
      const worktreePath = resolve(gitRoot, '..', `.owlcoda-worktrees`, slug)

      if (existsSync(worktreePath)) {
        return {
          output: `Worktree path already exists: ${worktreePath}. Choose a different name.`,
          isError: true,
        }
      }

      // Create the worktree
      try {
        execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
          cwd: gitRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        })
      } catch (err) {
        return {
          output: `Failed to create worktree: ${(err as Error).message}`,
          isError: true,
        }
      }

      // Switch into it
      const originalCwd = process.cwd()
      process.chdir(worktreePath)

      // Update state
      state.inWorktree = true
      state.worktreePath = worktreePath
      state.worktreeBranch = branchName
      state.originalCwd = originalCwd

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
        },
      }
    },
  }
}
