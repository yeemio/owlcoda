import {
  buildAgentControlSnapshot,
  formatAgentControlDetail,
  formatAgentControlSummary,
  getAgentControlAgent,
} from '../agent-control.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export interface AgentControlListInput {
  limit?: number
}

export interface AgentControlGetInput {
  agentId: string
}

export function createAgentControlListTool(): NativeToolDef<AgentControlListInput> {
  return {
    name: 'AgentControlList',
    description:
      'List runtime AgentControl records with parent run links, status, inspect commands, and recovery policy. Read-only; this does not spawn, resume, retry, or mutate agents.',
    maturity: 'beta',
    async execute(input: AgentControlListInput = {}, context?: ToolExecutionContext): Promise<ToolResult> {
      const snapshot = buildAgentControlSnapshot({
        limit: input.limit,
        conversationId: context?.conversationId,
      })
      if (snapshot.agents.length === 0) {
        return {
          output: 'No AgentControl records are available for this conversation.',
          isError: false,
          metadata: { agent_control: snapshot },
        }
      }
      return {
        output: snapshot.agents.map(formatAgentControlSummary).join('\n'),
        isError: false,
        metadata: { agent_control: snapshot },
      }
    },
  }
}

export function createAgentControlGetTool(): NativeToolDef<AgentControlGetInput> {
  return {
    name: 'AgentControlGet',
    description:
      'Read one AgentControl record by agentId. Read-only; this does not spawn, resume, retry, or mutate agents.',
    maturity: 'beta',
    async execute(input: AgentControlGetInput, context?: ToolExecutionContext): Promise<ToolResult> {
      const agentId = typeof input?.agentId === 'string' ? input.agentId.trim() : ''
      if (!agentId) return { output: 'agentId is required.', isError: true }
      const agent = getAgentControlAgent(agentId, { conversationId: context?.conversationId })
      if (!agent) {
        return {
          output: `AgentControl record "${agentId}" not found.`,
          isError: true,
          metadata: { agentId },
        }
      }
      return {
        output: formatAgentControlDetail(agent),
        isError: false,
        metadata: { agent },
      }
    },
  }
}
