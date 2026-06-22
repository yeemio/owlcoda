import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildRunLifecycleCheckpointPayload,
  formatRunLifecycleSnapshotsForPrompt,
  getRunLifecycleSnapshot,
  recentRunLifecycleSnapshots,
  recordRunLifecycleSnapshot,
  resetRunLifecycleForTesting,
  transitionRunLifecycleSnapshot,
} from '../../src/native/run-lifecycle.js'

describe('Run lifecycle registry', () => {
  beforeEach(() => resetRunLifecycleForTesting())

  it('records unified lifecycle snapshots for command and agent runs', () => {
    recordRunLifecycleSnapshot({
      runId: 'task:task-1',
      kind: 'task_command',
      status: 'running',
      objective: 'Generate shards',
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:02.000Z',
      owner: 'runtime_supervisor',
      inspectCommand: 'TaskOutput task_id=task-1 block=false',
      recoveryPolicy: {
        schema_version: 1,
        strategy: 'runtime_await',
        next_command: 'LongTaskAwait longTaskId=task:task-1 timeoutMs=5000',
        reason: 'Runtime has a live handle and can perform bounded awaits.',
      },
      evidence: {
        last_progress: 'stdout: shard-1',
        last_output_summary: 'first shard emitted',
      },
    })
    recordRunLifecycleSnapshot({
      runId: 'agent:agent-D1',
      kind: 'agent_run',
      status: 'timeout',
      objective: 'Inspect package boundary',
      startedAt: '2026-06-22T00:00:01.000Z',
      updatedAt: '2026-06-22T00:10:01.000Z',
      owner: 'agent_control',
      parentRunId: 'task:task-1',
      inspectCommand: 'AgentRunGet agentId=agent-D1',
      recoveryPolicy: {
        schema_version: 1,
        strategy: 'inspect_before_retry',
        next_command: 'AgentRunGet agentId=agent-D1',
        reason: 'Agent timed out; inspect before a narrower manual retry.',
      },
      evidence: {
        last_progress: 'tool_start:bash',
        timeout_kind: 'idle',
      },
    })

    expect(recentRunLifecycleSnapshots()).toEqual([
      expect.objectContaining({
        runId: 'agent:agent-D1',
        kind: 'agent_run',
        status: 'timeout',
        parentRunId: 'task:task-1',
      }),
      expect.objectContaining({
        runId: 'task:task-1',
        kind: 'task_command',
        status: 'running',
      }),
    ])
    expect(formatRunLifecycleSnapshotsForPrompt()).toContain('agent:agent-D1 kind=agent_run status=timeout')
    expect(formatRunLifecycleSnapshotsForPrompt()).toContain('inspect="AgentRunGet agentId=agent-D1"')

    const payload = buildRunLifecycleCheckpointPayload()
    expect(payload).toMatchObject({
      schema_version: 1,
      kind: 'run_lifecycle_checkpoint',
      runs: [
        expect.objectContaining({
          run_id: 'agent:agent-D1',
          kind: 'agent_run',
          status: 'timeout',
          recovery_policy: expect.objectContaining({
            strategy: 'inspect_before_retry',
          }),
        }),
        expect.objectContaining({
          run_id: 'task:task-1',
          kind: 'task_command',
          status: 'running',
          recovery_policy: expect.objectContaining({
            strategy: 'runtime_await',
          }),
        }),
      ],
    })
  })

  it('transitions a run with terminal evidence without losing startedAt', () => {
    recordRunLifecycleSnapshot({
      runId: 'task:task-2',
      kind: 'task_command',
      status: 'running',
      objective: 'Long compile',
      startedAt: '2026-06-22T00:00:00.000Z',
      owner: 'runtime_supervisor',
      inspectCommand: 'TaskOutput task_id=task-2 block=false',
    })

    transitionRunLifecycleSnapshot('task:task-2', {
      status: 'completed',
      finishedAt: '2026-06-22T00:01:00.000Z',
      evidence: {
        terminal_summary: 'exitCode=0',
        last_output_summary: 'compile finished',
      },
    })

    expect(getRunLifecycleSnapshot('task:task-2')).toMatchObject({
      runId: 'task:task-2',
      status: 'completed',
      startedAt: '2026-06-22T00:00:00.000Z',
      finishedAt: '2026-06-22T00:01:00.000Z',
      evidence: expect.objectContaining({
        terminal_summary: 'exitCode=0',
      }),
    })
  })
})
