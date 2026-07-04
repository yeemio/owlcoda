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
import { isModesEnabled } from '../modes.js'
import type { PlanModeState, SharedOperatingModeDeps } from './enter-plan-mode.js'

export function createExitPlanModeTool(
  state: PlanModeState,
  deps: SharedOperatingModeDeps = {},
): NativeToolDef<ExitPlanModeInput> {
  return {
    name: 'ExitPlanMode',
    description:
      'Present your implementation plan and request leaving plan mode. ' +
      'When explicit modes are enabled, only the user can switch to normal/auto.',

    async execute(input: ExitPlanModeInput): Promise<ToolResult> {
      if (isModesEnabled()) {
        const modeState = deps.getOperatingModeState?.()
        if (modeState) {
          if (modeState.mode !== 'plan') {
            state.inPlanMode = false
            return {
              output: 'Not currently in plan mode. Use /mode plan first.',
              isError: true,
            }
          }

          state.inPlanMode = true
          state.planText = summarizeAllowedPrompts(input.allowedPrompts ?? [])
          const prompts = input.allowedPrompts ?? []
          const promptsSummary = formatPromptsSummary(prompts)

          return {
            output:
              'Plan ready. Remain in read-only plan mode until the user explicitly switches modes.' +
              promptsSummary +
              '\n\nAsk the user to run /mode normal or /mode auto if they want implementation to proceed.',
            isError: false,
            metadata: {
              mode: 'plan',
              requestedMode: 'normal',
              exitRequested: true,
              allowedPrompts: prompts,
            },
          }
        }
      }

      if (!state.inPlanMode) {
        return {
          output: 'Not currently in plan mode. Use EnterPlanMode first.',
          isError: true,
        }
      }

      state.inPlanMode = false

      // Store any allowedPrompts metadata for downstream use
      const prompts = input.allowedPrompts ?? []
      const promptsSummary = formatPromptsSummary(prompts)

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

function formatPromptsSummary(prompts: Array<{ tool: string; prompt: string }>): string {
  return prompts.length > 0
    ? `\nAllowed operations: ${prompts.map(p => `${p.tool}: ${p.prompt}`).join(', ')}`
    : ''
}

function summarizeAllowedPrompts(prompts: Array<{ tool: string; prompt: string }>): string | undefined {
  if (prompts.length === 0) return undefined
  return prompts.map(p => `${p.tool}: ${p.prompt}`).join(', ')
}
