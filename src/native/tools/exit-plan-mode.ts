/**
 * OwlCoda Native ExitPlanMode Tool
 *
 * Presents the designed plan to the user and exits plan mode,
 * restoring normal file-mutation permissions.
 *
 * Upstream parity notes:
 * - Upstream ExitPlanModeV2Tool restores prePlanMode permissions
 * - Writes plan to disk, handles teammate approval flow
 * - Our version is simpler: toggle state + store plan text
 */

import type { ExitPlanModeInput, NativeToolDef, ToolResult } from './types.js'
import type { PlanModeState } from './enter-plan-mode.js'

export function createExitPlanModeTool(state: PlanModeState): NativeToolDef<ExitPlanModeInput> {
  return {
    name: 'ExitPlanMode',
    description:
      'Present your implementation plan and exit plan mode. ' +
      'After approval the conversation returns to normal mode where file edits are allowed.',

    async execute(input: ExitPlanModeInput): Promise<ToolResult> {
      if (!state.inPlanMode) {
        return {
          output: 'Not currently in plan mode. Use EnterPlanMode first.',
          isError: true,
        }
      }

      state.inPlanMode = false

      // Store any allowedPrompts metadata for downstream use
      const prompts = input.allowedPrompts ?? []
      const promptsSummary = prompts.length > 0
        ? `\nAllowed operations: ${prompts.map(p => `${p.tool}: ${p.prompt}`).join(', ')}`
        : ''

      return {
        output:
          'Exited plan mode. You may now proceed with implementation.' +
          promptsSummary +
          '\n\nApply the plan you designed during the planning phase.',
        isError: false,
        metadata: { mode: 'normal', allowedPrompts: prompts },
      }
    },
  }
}
