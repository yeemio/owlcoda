/**
 * OwlCoda Native TeamCreate Tool
 *
 * Creates a team directory structure for coordinating multiple agents.
 * Teams have a 1:1 correspondence with task lists.
 *
 * Legacy parity notes:
 * - Older implementations created vendor-specific team/task folders
 * - OwlCoda uses the same directory shape under ~/.owlcoda
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

export interface TeamCreateInput {
  team_name: string
  description?: string
}

function getTeamDir(teamName: string): string {
  return join(homedir(), '.owlcoda', 'teams', teamName)
}

function getTaskDir(teamName: string): string {
  return join(homedir(), '.owlcoda', 'tasks', teamName)
}

export function createTeamCreateTool(): NativeToolDef<TeamCreateInput> {
  return {
    name: 'TeamCreate',
    description:
      'Create a new team to coordinate multiple agents. ' +
      'Teams have a 1:1 correspondence with task lists.',
    maturity: 'experimental' as const,

    async execute(input: TeamCreateInput): Promise<ToolResult> {
      const { team_name, description } = input

      if (!team_name || typeof team_name !== 'string') {
        return { output: 'Error: team_name is required.', isError: true }
      }

      // Validate name (slug-safe)
      if (!/^[a-zA-Z0-9_-]+$/.test(team_name)) {
        return {
          output: `Error: team_name "${team_name}" is invalid. Use only letters, numbers, hyphens, and underscores.`,
          isError: true,
        }
      }

      const teamDir = getTeamDir(team_name)
      const taskDir = getTaskDir(team_name)

      // Check if already exists
      try {
        await access(teamDir)
        return {
          output: `Team "${team_name}" already exists at ${teamDir}`,
          isError: true,
        }
      } catch {
        // Does not exist — proceed
      }

      // Create directories
      await mkdir(teamDir, { recursive: true })
      await mkdir(taskDir, { recursive: true })

      // Write config
      const config = {
        name: team_name,
        description: description ?? '',
        created: new Date().toISOString(),
        members: [],
      }
      await writeFile(
        join(teamDir, 'config.json'),
        JSON.stringify(config, null, 2),
        'utf-8',
      )

      return {
        output: `Created team "${team_name}":\n  Team: ${teamDir}\n  Tasks: ${taskDir}`,
        isError: false,
        metadata: { team_name, teamDir, taskDir },
      }
    },
  }
}
