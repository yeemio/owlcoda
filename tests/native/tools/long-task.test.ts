import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  recordLongTaskSnapshot,
  resetLongTaskLifecycleForTesting,
} from '../../../src/native/long-task-lifecycle.js'
import {
  createLongTaskAwaitTool,
  createLongTaskGetTool,
  createLongTaskListTool,
  createLongTaskReplaceTool,
} from '../../../src/native/tools/long-task.js'
import {
  createTask,
  getTask,
  resetTaskStore,
  spawnTaskCommand,
} from '../../../src/native/tools/task-store.js'

describe('LongTask lifecycle inspection tools', () => {
  beforeEach(() => {
    resetTaskStore()
    resetLongTaskLifecycleForTesting()
  })

  afterEach(() => {
    resetTaskStore()
    resetLongTaskLifecycleForTesting()
  })

  it('lists live waitable command tasks with lifecycle verdicts', async () => {
    const task = createTask({
      subject: 'Registry live command',
      description: 'Command should remain live long enough to inspect',
      conversationId: 'conv-long-task-registry',
      command: 'sleep 1; echo registry-live-done',
      cwd: '/tmp',
    })
    spawnTaskCommand(task.id)

    const result = await createLongTaskListTool().execute({}, {
      conversationId: 'conv-long-task-registry',
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('task:task-1')
    expect(result.output).toContain('source=task_command')
    expect(result.output).toContain('status=running')
    expect(result.output).toContain('supervision_state=live')
    expect(result.output).toContain('can_wait=true')
    expect(result.output).toContain('wait_strategy=runtime_await')
    expect(result.output).toContain(`inspect="TaskOutput task_id=${task.id} block=false"`)
    expect(result.metadata?.['long_tasks']).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          longTaskId: `task:${task.id}`,
          status: 'running',
        }),
        verdict: expect.objectContaining({
          long_task_id: `task:${task.id}`,
          supervision_state: 'live',
          can_wait: true,
          terminal: false,
          next_action: 'inspect_again_later',
          wait_policy: expect.objectContaining({
            strategy: 'runtime_await',
            recommended_wait_ms: 5000,
            max_wait_ms: 30000,
            stop_polling: false,
          }),
        }),
      }),
    ])
  })

  it('returns one lost-handle lifecycle object by id', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'agent:agent-lost-1',
      source: 'agent',
      status: 'incomplete',
      objective: 'Lost child run',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      agentId: 'agent-lost-1',
      inspectCommand: 'AgentRunGet agentId=agent-lost-1',
      timeoutKind: 'agent_run_handle_missing_after_resume',
      lastProgress: 'Agent record was restored without a live handle.',
    })

    const result = await createLongTaskGetTool().execute(
      { longTaskId: 'agent:agent-lost-1' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Long task agent:agent-lost-1')
    expect(result.output).toContain('source=agent')
    expect(result.output).toContain('status=incomplete')
    expect(result.output).toContain('Lifecycle: status=incomplete supervision_state=lost_handle can_wait=false terminal=false next_action=retry_or_report_incomplete')
    expect(result.output).toContain('WaitPolicy: strategy=replace_or_retry recommended_wait_ms=0 max_wait_ms=0 stop_polling=true')
    expect(result.output).toContain('Inspect: AgentRunGet agentId=agent-lost-1')
    expect(result.metadata?.['snapshot']).toMatchObject({
      longTaskId: 'agent:agent-lost-1',
      status: 'incomplete',
      timeoutKind: 'agent_run_handle_missing_after_resume',
    })
    expect(result.metadata?.['long_task_lifecycle']).toMatchObject({
      long_task_id: 'agent:agent-lost-1',
      supervision_state: 'lost_handle',
      can_wait: false,
      next_action: 'retry_or_report_incomplete',
      wait_policy: expect.objectContaining({
        strategy: 'replace_or_retry',
        stop_polling: true,
      }),
    })
  })

  it('awaits a live registry record through runtime policy until it becomes terminal', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-1',
      source: 'task_command',
      status: 'running',
      objective: 'Runtime await proof',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-1',
      command: 'sleep 1; echo done',
      inspectCommand: 'TaskOutput task_id=task-1 block=false',
    })
    setTimeout(() => {
      recordLongTaskSnapshot({
        longTaskId: 'task:task-1',
        source: 'task_command',
        status: 'completed',
        objective: 'Runtime await proof',
        startedAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.050Z',
        finishedAt: '2026-06-18T00:00:00.050Z',
        conversationId: 'conv-long-task-registry',
        taskId: 'task-1',
        command: 'sleep 1; echo done',
        inspectCommand: 'TaskOutput task_id=task-1 block=false',
        outputSnippet: 'stdout: done',
      })
    }, 20)

    const result = await createLongTaskAwaitTool().execute(
      { longTaskId: 'task:task-1', timeoutMs: 500 },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('LongTaskAwait: completed task:task-1')
    expect(result.output).toContain('Lifecycle: status=completed supervision_state=terminal can_wait=false terminal=true next_action=report_terminal_result')
    expect(result.output).toContain('WaitPolicy: strategy=report_terminal recommended_wait_ms=0 max_wait_ms=0 stop_polling=true')
    expect(result.metadata?.['await_status']).toBe('completed')
    expect(result.metadata?.['long_task_lifecycle']).toMatchObject({
      long_task_id: 'task:task-1',
      status: 'completed',
      wait_policy: expect.objectContaining({
        strategy: 'report_terminal',
        stop_polling: true,
      }),
    })
  })

  it('does not wait on lost-handle records and tells the model to stop polling', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-lost',
      source: 'task_command',
      status: 'incomplete',
      objective: 'Lost command',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-lost',
      command: 'sleep 60',
      inspectCommand: 'TaskOutput task_id=task-lost block=false',
      timeoutKind: 'process_handle_missing_after_resume',
    })

    const result = await createLongTaskAwaitTool().execute(
      { longTaskId: 'task:task-lost', timeoutMs: 500 },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('LongTaskAwait: not_waitable task:task-lost')
    expect(result.output).toContain('WaitPolicy: strategy=replace_or_retry recommended_wait_ms=0 max_wait_ms=0 stop_polling=true')
    expect(result.metadata?.['await_status']).toBe('not_waitable')
    expect(result.metadata?.['long_task_lifecycle']).toMatchObject({
      long_task_id: 'task:task-lost',
      supervision_state: 'lost_handle',
      wait_policy: expect.objectContaining({
        strategy: 'replace_or_retry',
        stop_polling: true,
      }),
    })
  })

  it('reports process liveness for lost-handle command records with process identity', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-lost-live-pid',
      source: 'task_command',
      status: 'incomplete',
      objective: 'Lost command with live pid',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-lost-live-pid',
      command: 'sleep 60',
      cwd: '/tmp',
      inspectCommand: 'TaskOutput task_id=task-lost-live-pid block=false',
      timeoutKind: 'process_handle_missing_after_resume',
      processIdentity: {
        schema_version: 1,
        pid: process.pid,
        command: 'sleep 60',
        cwd: '/tmp',
        spawnedAt: '2026-06-18T00:00:00.000Z',
      },
    })

    const result = await createLongTaskGetTool().execute(
      { longTaskId: 'task:task-lost-live-pid' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain(`ProcessIdentity: pid=${process.pid}`)
    expect(result.output).toContain('ProcessLiveness: status=alive confidence=pid_only')
    expect(result.output).toContain('next_action=inspect_process_before_replace')
    expect(result.metadata?.['process_liveness']).toMatchObject({
      schema_version: 1,
      pid: process.pid,
      status: 'alive',
      confidence: 'pid_only',
      next_action: 'inspect_process_before_replace',
    })
  })

  it('refuses replacement when restored process identity still appears alive', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-lost-live-pid',
      source: 'task_command',
      status: 'incomplete',
      objective: 'Lost command with live pid',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-lost-live-pid',
      command: 'sleep 60',
      cwd: '/tmp',
      inspectCommand: 'TaskOutput task_id=task-lost-live-pid block=false',
      timeoutKind: 'process_handle_missing_after_resume',
      processIdentity: {
        schema_version: 1,
        pid: process.pid,
        command: 'sleep 60',
        cwd: '/tmp',
        spawnedAt: '2026-06-18T00:00:00.000Z',
      },
    })

    const result = await createLongTaskReplaceTool().execute(
      { longTaskId: 'task:task-lost-live-pid' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('LongTaskReplace: inspect_process_first task:task-lost-live-pid')
    expect(result.output).toContain('ProcessLiveness: status=alive confidence=pid_only')
    expect(result.output).toContain('refusing automatic replacement')
    expect(result.metadata).toMatchObject({
      replacement_status: 'inspect_process_first',
      original_long_task_id: 'task:task-lost-live-pid',
      process_liveness: expect.objectContaining({
        status: 'alive',
        next_action: 'inspect_process_before_replace',
      }),
    })
    expect(getTask('task-1')).toBeUndefined()
  })

  it('starts a replacement command task for a lost-handle task_command record', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-lost',
      source: 'task_command',
      status: 'incomplete',
      objective: 'Lost command replacement',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-lost',
      command: 'sleep 0.2; echo replacement-done',
      cwd: '/tmp',
      inspectCommand: 'TaskOutput task_id=task-lost block=false',
      timeoutKind: 'process_handle_missing_after_resume',
    })

    const result = await createLongTaskReplaceTool().execute(
      { longTaskId: 'task:task-lost', reason: 'lost process handle after resume' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('LongTaskReplace: started replacement')
    expect(result.output).toContain('original_long_task_id=task:task-lost')
    expect(result.output).toContain('replacement_long_task_id=task:task-1')
    expect(result.output).toContain('replacement_task_id=task-1')
    expect(result.output).toContain('TaskOutputCommand: TaskOutput task_id=task-1 block=false')
    expect(result.output).toContain('command=sleep 0.2; echo replacement-done')
    expect(result.output).toContain('ReplacementPolicy: strategy=task_command_replace available=true')
    expect(getTask('task-1')).toMatchObject({
      id: 'task-1',
      status: 'in_progress',
      command: 'sleep 0.2; echo replacement-done',
      cwd: '/tmp',
      conversationId: 'conv-long-task-registry',
      metadata: expect.objectContaining({
        replacementForLongTaskId: 'task:task-lost',
        replacementReason: 'lost process handle after resume',
      }),
    })
    expect(result.metadata).toMatchObject({
      replacement_status: 'started',
      original_long_task_id: 'task:task-lost',
      replacement_long_task_id: 'task:task-1',
      replacement_task_id: 'task-1',
    })
  })

  it('refuses unsafe replacement commands before spawning', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:task-lost',
      source: 'task_command',
      status: 'incomplete',
      objective: 'Lost unsafe command replacement',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      taskId: 'task-lost',
      command: 'echo safe-original',
      inspectCommand: 'TaskOutput task_id=task-lost block=false',
      timeoutKind: 'process_handle_missing_after_resume',
    })

    const result = await createLongTaskReplaceTool().execute(
      { longTaskId: 'task:task-lost', command: 'rm -rf /tmp/owlcoda-nope' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('LongTaskReplace refused by risk classifier')
    expect(getTask('task-1')).toBeUndefined()
  })

  it('does not auto-retry Agent lost-handle records', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'agent:agent-lost-1',
      source: 'agent',
      status: 'incomplete',
      objective: 'Lost child run',
      startedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:01.000Z',
      conversationId: 'conv-long-task-registry',
      agentId: 'agent-lost-1',
      inspectCommand: 'AgentRunGet agentId=agent-lost-1',
      timeoutKind: 'agent_run_handle_missing_after_resume',
      promptSnippet: 'Inspect the repo and produce a report.',
    })

    const result = await createLongTaskReplaceTool().execute(
      { longTaskId: 'agent:agent-lost-1' },
      { conversationId: 'conv-long-task-registry' },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('LongTaskReplace: not_supported agent:agent-lost-1')
    expect(result.output).toContain('Agent records require an explicit new Agent call')
    expect(result.metadata).toMatchObject({
      replacement_status: 'not_supported',
      original_long_task_id: 'agent:agent-lost-1',
    })
  })

  it('does not leak another conversation long-task record', async () => {
    recordLongTaskSnapshot({
      longTaskId: 'task:foreign',
      source: 'task_command',
      status: 'running',
      objective: 'Foreign task',
      startedAt: '2026-06-18T00:00:00.000Z',
      conversationId: 'conv-foreign',
      taskId: 'foreign',
      command: 'sleep 60',
      inspectCommand: 'TaskOutput task_id=foreign block=false',
    })

    const list = await createLongTaskListTool().execute({}, {
      conversationId: 'conv-current',
    })
    const get = await createLongTaskGetTool().execute(
      { longTaskId: 'task:foreign' },
      { conversationId: 'conv-current' },
    )

    expect(list.output).toContain('No long-task lifecycle records')
    expect(list.metadata?.['long_tasks']).toEqual([])
    expect(get.isError).toBe(true)
    expect(get.output).toContain('not found')
  })
})
