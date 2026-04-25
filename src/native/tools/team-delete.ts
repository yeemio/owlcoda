/**
 * OwlCoda Native TeamDelete Tool
 *
 * Removes team and task directories when swarm work is complete.
 *
 * Legacy parity notes:
 * - Older implementations removed vendor-specific team/task folders
 * - Fails if team still has active members
 * - OwlCoda performs the same cleanup under ~/.owlcoda
 */

import { rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { NativeToolDef, ToolResult } from './types.js'

export interface TeamDeleteInput {
  team_name: string
}

function getTeamDir(teamName: string): string {
  return join(homedir(), '.owlcoda', 'teams', teamName)
}

function getTaskDir(teamName: string): string {
  return join(homedir(), '.owlcoda', 'tasks', teamName)
}

export function createTeamDeleteTool(): NativeToolDef<TeamDeleteInput> {
  return {
    name: 'TeamDelete',
    description:
      'Remove team and task directories when swarm work is complete. ' +
      'Fails if the team still has active members.',
    maturity: 'experimental' as const,

    async execute(input: TeamDeleteInput): Promise<ToolResult> {
      const { team_name } = input

      if (!team_name || typeof team_name !== 'string') {
        return { output: 'Error: team_name is required.', isError: true }
      }

      const teamDir = getTeamDir(team_name)
      const taskDir = getTaskDir(team_name)

      // Check team exists
      try {
        await access(teamDir)
      } catch {
        return {
          output: `Team "${team_name}" not found at ${teamDir}`,
          isError: true,
        }
      }

      // Check for active members
      try {
        const configPath = join(teamDir, 'config.json')
        const raw = await readFile(configPath, 'utf-8')
        const config = JSON.parse(raw)
        if (Array.isArray(config.members) && config.members.length > 0) {
          return {
            output: `Cannot delete team "${team_name}": still has ${config.members.length} active member(s). Shut down teammates first.`,
            isError: true,
          }
        }
      } catch {
        // No config or unparseable — allow deletion
      }

      // Remove directories
      await rm(teamDir, { recursive: true, force: true })
      await rm(taskDir, { recursive: true, force: true })

      return {
        output: `Deleted team "${team_name}" and its task directory.`,
        isError: false,
        metadata: { team_name },
      }
    },
  }
}
