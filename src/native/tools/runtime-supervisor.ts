import {
  formatRuntimeSupervisorProcessDetail,
  formatRuntimeSupervisorProcessSummary,
  getRuntimeSupervisorProcess,
  recentRuntimeSupervisorProcesses,
} from '../runtime-supervisor.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface RuntimeSupervisorListInput {
  limit?: number
}

export interface RuntimeSupervisorGetInput {
  processId: string
}

export function createRuntimeSupervisorListTool(): NativeToolDef<RuntimeSupervisorListInput> {
  return {
    name: 'RuntimeSupervisorList',
    description:
      'List runtime-supervised process snapshots for command-backed long tasks. Read-only; this does not wait, kill, resume, retry, or mutate work.',
    maturity: 'beta',
    async execute(input: RuntimeSupervisorListInput = {}, context?: ToolExecutionContext): Promise<ToolResult> {
      const processes = recentRuntimeSupervisorProcesses({
        limit: input.limit,
        conversationId: context?.conversationId,
      })
      if (processes.length === 0) {
        return {
          output: 'No runtime supervisor process snapshots are available for this conversation.',
          isError: false,
          metadata: { processes: [] },
        }
      }
      return {
        output: processes.map(formatRuntimeSupervisorProcessSummary).join('\n'),
        isError: false,
        metadata: { processes },
      }
    },
  }
}

export function createRuntimeSupervisorGetTool(): NativeToolDef<RuntimeSupervisorGetInput> {
  return {
    name: 'RuntimeSupervisorGet',
    description:
      'Read one runtime-supervised process snapshot by processId. Read-only; this does not wait, kill, resume, retry, or mutate work.',
    maturity: 'beta',
    async execute(input: RuntimeSupervisorGetInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const processId = typeof input?.processId === 'string' ? input.processId.trim() : ''
      if (!processId) return { output: 'processId is required.', isError: true }
      const processSnapshot = getRuntimeSupervisorProcess(processId)
      if (!processSnapshot || (context?.conversationId && processSnapshot.conversationId !== context.conversationId)) {
        return {
          output: `Runtime supervisor process "${processId}" not found.`,
          isError: true,
          metadata: { processId },
        }
      }
      return {
        output: formatRuntimeSupervisorProcessDetail(processSnapshot),
        isError: false,
        metadata: { process: processSnapshot },
      }
    },
  }
}
