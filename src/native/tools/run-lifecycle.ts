import {
  getRunLifecycleSnapshot,
  recentRunLifecycleSnapshots,
  type RunLifecycleSnapshot,
} from '../run-lifecycle.js'
import type { NativeToolDef, ToolResult } from './types.js'

export interface RuntimeLifecycleListInput {
  limit?: number
  kind?: string
}

export interface RuntimeLifecycleGetInput {
  runId: string
}

export function createRuntimeLifecycleListTool(): NativeToolDef<RuntimeLifecycleListInput> {
  return {
    name: 'RuntimeLifecycleList',
    description:
      'List unified runtime lifecycle records for long tasks, agent runs, supervisor processes, mailbox messages, and checkpoints. Read-only; this does not wait, resume, retry, or mutate work.',
    maturity: 'beta',
    async execute(input: RuntimeLifecycleListInput = {}): Promise<ToolResult> {
      const limit = parsePositiveLimit(input.limit, 20)
      const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : undefined
      const runs = recentRunLifecycleSnapshots(limit)
        .filter((snapshot) => !kind || snapshot.kind === kind)
      if (runs.length === 0) {
        return {
          output: 'No runtime lifecycle records are available.',
          isError: false,
          metadata: { runs: [] },
        }
      }
      return {
        output: runs.map(formatRuntimeLifecycleSummary).join('\n'),
        isError: false,
        metadata: { runs },
      }
    },
  }
}

export function createRuntimeLifecycleGetTool(): NativeToolDef<RuntimeLifecycleGetInput> {
  return {
    name: 'RuntimeLifecycleGet',
    description:
      'Read one unified runtime lifecycle record by runId. Read-only; this does not wait, resume, retry, or mutate work.',
    maturity: 'beta',
    async execute(input: RuntimeLifecycleGetInput): Promise<ToolResult> {
      const runId = typeof input?.runId === 'string' ? input.runId.trim() : ''
      if (!runId) return { output: 'runId is required.', isError: true }
      const run = getRunLifecycleSnapshot(runId)
      if (!run) {
        return {
          output: `Runtime run "${runId}" not found.`,
          isError: true,
          metadata: { runId },
        }
      }
      return {
        output: formatRuntimeLifecycleDetail(run),
        isError: false,
        metadata: { run },
      }
    },
  }
}

function formatRuntimeLifecycleSummary(snapshot: RunLifecycleSnapshot): string {
  const fields = [
    snapshot.runId,
    `kind=${snapshot.kind}`,
    `status=${snapshot.status}`,
    `owner=${snapshot.owner}`,
    `objective="${compactLifecycleText(snapshot.objective, 80)}"`,
  ]
  if (snapshot.parentRunId) fields.push(`parent=${snapshot.parentRunId}`)
  if (snapshot.recoveryPolicy) fields.push(`recovery=${snapshot.recoveryPolicy.strategy}`)
  return fields.join(' ')
}

function formatRuntimeLifecycleDetail(snapshot: RunLifecycleSnapshot): string {
  const lines = [
    `Runtime run ${snapshot.runId}`,
    `kind=${snapshot.kind}`,
    `status=${snapshot.status}`,
    `owner=${snapshot.owner}`,
    `objective=${snapshot.objective}`,
    `startedAt=${snapshot.startedAt}`,
    `updatedAt=${snapshot.updatedAt}`,
  ]
  if (snapshot.finishedAt) lines.push(`finishedAt=${snapshot.finishedAt}`)
  if (snapshot.parentRunId) lines.push(`parentRunId=${snapshot.parentRunId}`)
  lines.push(`Inspect: ${snapshot.inspectCommand}`)
  if (snapshot.recoveryPolicy) {
    lines.push(`Recovery: strategy=${snapshot.recoveryPolicy.strategy} next="${snapshot.recoveryPolicy.next_command}" reason=${snapshot.recoveryPolicy.reason}`)
  }
  if (snapshot.evidence?.timeout_kind) lines.push(`timeoutKind=${snapshot.evidence.timeout_kind}`)
  if (snapshot.evidence?.last_progress) lines.push(`lastProgress=${snapshot.evidence.last_progress}`)
  if (snapshot.evidence?.last_output_summary) lines.push(`lastOutput=${snapshot.evidence.last_output_summary}`)
  if (snapshot.evidence?.terminal_summary) lines.push(`terminal=${snapshot.evidence.terminal_summary}`)
  return lines.join('\n')
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), 100)
}

function compactLifecycleText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit).trimEnd()}...`
}
