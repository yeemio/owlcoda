/**
 * OwlCoda Native EnterPlanMode Tool
 *
 * Switches the conversation to read-only planning mode.
 * In plan mode the model explores the codebase and designs an approach
 * without writing or editing files.
 *
 * Upstream parity notes:
 * - Upstream EnterPlanModeTool sets toolPermissionContext.mode = 'plan'
 * - Blocks file mutations during plan phase
 * - Cannot be used in agent (sub-agent) contexts
 */

import type { EnterPlanModeInput, NativeToolDef, ToolResult } from './types.js'

/** Shared mutable plan-mode state. */
export interface PlanModeState {
  /** Whether the conversation is in plan mode. */
  inPlanMode: boolean
  /** Stored plan text (written by ExitPlanMode). */
  planText?: string
}

export function createEnterPlanModeTool(state: PlanModeState): NativeToolDef<EnterPlanModeInput> {
  return {
    name: 'EnterPlanMode',
    description:
      'Enter plan mode for complex tasks. In plan mode you explore the codebase ' +
      'and design an approach before writing any code. No file mutations allowed.',

    async execute(_input: EnterPlanModeInput): Promise<ToolResult> {
      if (state.inPlanMode) {
        return {
          output: 'Already in plan mode.',
          isError: false,
        }
      }

      state.inPlanMode = true
      state.planText = undefined

      return {
        output:
          'Entered plan mode. Focus on exploring the codebase and designing an ' +
          'implementation approach.\n\n' +
          'Rules while in plan mode:\n' +
          '1. Thoroughly explore the codebase to understand existing patterns\n' +
          '2. Identify similar features and architectural approaches\n' +
          '3. Consider multiple approaches and trade-offs\n' +
          '4. Use AskUserQuestion if clarification is needed\n' +
          '5. Design a concrete implementation strategy\n' +
          '6. Use ExitPlanMode to present your plan for approval\n\n' +
          'DO NOT write or edit any files yet. This is a read-only exploration and planning phase.',
        isError: false,
        metadata: { mode: 'plan' },
      }
    },
  }
}
