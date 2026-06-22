import {
  snapshotAgentRunHistory,
  type AgentRunRecord,
} from './tools/agent.js'
import type { RunRecoveryPolicy } from './run-lifecycle.js'

export interface AgentControlSnapshot {
  schema_version: 1
  generated_at: string
  agents: AgentControlAgent[]
}

export interface AgentControlAgent {
  agent_id: string
  run_id: string
  parent_run_id?: string
  parent_step_id?: string
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'incomplete' | 'cancelled'
  description: string
  agent_type: string
  model?: string
  started_at: string
  updated_at: string
  finished_at?: string
  inspect_command: string
  recovery: RunRecoveryPolicy
  last_progress?: string
  output_summary?: string
}

export interface AgentControlSnapshotOptions {
  conversationId?: string
  limit?: number
}

export function buildAgentControlSnapshot(options: AgentControlSnapshotOptions = {}): AgentControlSnapshot {
  const limit = parsePositiveLimit(options.limit, 20)
  const records = snapshotAgentRunHistory(options.conversationId).records
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents: records.map(toAgentControlAgent),
  }
}

export function getAgentControlAgent(
  agentId: string,
  options: Omit<AgentControlSnapshotOptions, 'limit'> = {},
): AgentControlAgent | undefined {
  return buildAgentControlSnapshot({ ...options, limit: 100 }).agents.find((agent) => agent.agent_id === agentId)
}

export function formatAgentControlSummary(agent: AgentControlAgent): string {
  const fields = [
    agent.agent_id,
    `run=${agent.run_id}`,
    `status=${agent.status}`,
    `type=${agent.agent_type}`,
    `description="${compactAgentControlText(agent.description, 80)}"`,
  ]
  if (agent.parent_run_id) fields.push(`parent=${agent.parent_run_id}${agent.parent_step_id ? `/${agent.parent_step_id}` : ''}`)
  fields.push(`recovery=${agent.recovery.strategy}`)
  return fields.join(' ')
}

export function formatAgentControlDetail(agent: AgentControlAgent): string {
  const lines = [
    `AgentControl ${agent.agent_id}`,
    `run=${agent.run_id}`,
    `status=${agent.status}`,
    `type=${agent.agent_type}`,
    `description=${agent.description}`,
    `startedAt=${agent.started_at}`,
    `updatedAt=${agent.updated_at}`,
  ]
  if (agent.finished_at) lines.push(`finishedAt=${agent.finished_at}`)
  if (agent.model) lines.push(`model=${agent.model}`)
  if (agent.parent_run_id || agent.parent_step_id) lines.push(`parent=${agent.parent_run_id ?? '-'}${agent.parent_step_id ? `/${agent.parent_step_id}` : ''}`)
  lines.push(`Inspect: ${agent.inspect_command}`)
  lines.push(`Recovery: strategy=${agent.recovery.strategy} next="${agent.recovery.next_command}" reason=${agent.recovery.reason}`)
  if (agent.last_progress) lines.push(`lastProgress=${agent.last_progress}`)
  if (agent.output_summary) lines.push(`output=${agent.output_summary}`)
  return lines.join('\n')
}

function toAgentControlAgent(record: AgentRunRecord): AgentControlAgent {
  const runId = `agent:${record.agentId}`
  const parentRunId = record.parentTaskId
    ? runIdFromTaskId(record.parentTaskId)
    : undefined
  const recovery = agentControlRecovery(record)
  return {
    agent_id: record.agentId,
    run_id: runId,
    ...(parentRunId ? { parent_run_id: parentRunId } : {}),
    ...(record.parentStepId ? { parent_step_id: record.parentStepId } : {}),
    status: agentControlStatus(record),
    description: record.description,
    agent_type: record.agentType,
    ...(record.model ? { model: record.model } : {}),
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    ...(record.finishedAt ? { finished_at: record.finishedAt } : {}),
    inspect_command: `AgentRunGet agentId=${record.agentId}`,
    recovery,
    ...(record.lastProgress ? { last_progress: formatProgressRecord(record.lastProgress) } : {}),
    ...(record.outputSnippet ? { output_summary: record.outputSnippet } : {}),
  }
}

function agentControlStatus(record: AgentRunRecord): AgentControlAgent['status'] {
  if (record.failureCategory === 'agent:watchdog_timeout' || record.longTaskSnapshot?.status === 'timeout') return 'timeout'
  if (record.status === 'success') return 'completed'
  if (record.status === 'cancelled') return 'cancelled'
  if (record.status === 'failed') return 'failed'
  if (record.status === 'running' && record.timeoutKind !== 'agent_run_handle_missing_after_resume') return 'running'
  return 'incomplete'
}

function agentControlRecovery(record: AgentRunRecord): RunRecoveryPolicy {
  const inspect = `AgentRunGet agentId=${record.agentId}`
  if (
    record.recoveryPolicy
    || record.failureCategory === 'agent:watchdog_timeout'
    || record.timeoutKind === 'agent_run_handle_missing_after_resume'
    || record.longTaskSnapshot?.status === 'timeout'
    || record.longTaskSnapshot?.status === 'incomplete'
  ) {
    return {
      schema_version: 1,
      strategy: 'inspect_before_retry',
      next_command: inspect,
      reason: record.recoveryPolicy?.reason
        ?? 'Agent run is timeout/incomplete or restored without a live handle. Inspect saved evidence before any narrower manual retry.',
    }
  }
  if (record.status === 'running') {
    return {
      schema_version: 1,
      strategy: 'inspect_later',
      next_command: inspect,
      reason: 'Agent run is still live; inspect its current record before waiting or intervening.',
    }
  }
  return {
    schema_version: 1,
    strategy: 'report_terminal',
    next_command: inspect,
    reason: 'Agent run is terminal; report saved evidence instead of retrying blindly.',
  }
}

function runIdFromTaskId(taskId: string): string {
  return taskId.startsWith('task:') ? taskId : `task:${taskId}`
}

function formatProgressRecord(mark: AgentRunRecord['lastProgress']): string | undefined {
  if (!mark) return undefined
  return mark.detail ? `${mark.type}:${mark.detail}` : mark.type
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), 100)
}

function compactAgentControlText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}
