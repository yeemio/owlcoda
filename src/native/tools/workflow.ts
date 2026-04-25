/**
 * OwlCoda Native Workflow Tool (stub)
 *
 * Placeholder for workflow automation — not available in local-LLM mode.
 * Upstream has this as a disabled stub as well.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface WorkflowInput {
  [key: string]: unknown
}

export const WORKFLOW_TOOL_NAME = 'Workflow'

export function createWorkflowTool(): NativeToolDef<WorkflowInput> {
  return {
    name: WORKFLOW_TOOL_NAME,
    description: 'Workflow automation (not available in local mode).',
    maturity: 'experimental' as const,

    async execute(_input: WorkflowInput): Promise<ToolResult> {
      return {
        output: 'Workflow tool is not available in local-LLM mode.',
        isError: true,
      }
    },
  }
}
