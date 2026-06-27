import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskOutputTool } from '../../../src/native/tools/task-output.js'
import {
  resetTaskStore,
  createTask,
  updateTask,
  updateTaskStep,
  snapshotTaskStore,
  restoreTaskStore,
  spawnTaskCommand,
} from '../../../src/native/tools/task-store.js'

describe('TaskOutput tool', () => {
  const tool = createTaskOutputTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskOutput')
  })

  it('returns output for a completed task', async () => {
    createTask({ subject: 'Done task', description: 'finished work' })
    updateTask('task-1', { status: 'completed' })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Done task')
    expect(r.output).toContain('completed')
    expect((r.metadata as any).retrieval_status).toBe('success')
  })

  it('returns output immediately when block is false', async () => {
    createTask({ subject: 'Running', description: 'still going' })
    updateTask('task-1', { status: 'in_progress' })
    const r = await tool.execute({ task_id: 'task-1', block: false })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('in_progress')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ task_id: 'task-999' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('accepts task:<id> long-task aliases and resolves them to task ids', async () => {
    createTask({ subject: 'Alias task', description: 'longTaskId alias should work' })
    updateTask('task-1', { status: 'completed' })

    const r = await tool.execute({ task_id: 'task:task-1', block: false })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('Resolved task_id alias: task:task-1 -> task-1')
    expect(r.output).toContain('Task: task-1')
    expect((r.metadata as any).requested_task_id).toBe('task:task-1')
    expect((r.metadata as any).resolved_task_id).toBe('task-1')
    expect((r.metadata as any).retrieval_status).toBe('success')
  })

  it('returns error without task_id', async () => {
    const r = await tool.execute({ task_id: '' })
    expect(r.isError).toBe(true)
  })

  it('times out for non-terminal task with short timeout', async () => {
    createTask({ subject: 'Slow', description: 'waiting' })
    updateTask('task-1', { status: 'in_progress' })
    const r = await tool.execute({ task_id: 'task-1', block: true, timeout: 600 })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Timeout')
    expect((r.metadata as any).retrieval_status).toBe('timeout')
  }, 5000)

  it('returns incomplete immediately for a restored command task with no live process handle', async () => {
    const task = createTask({
      subject: 'Detached command',
      description: 'command was running before process restart',
      conversationId: 'conv-task-output-resume',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    updateTask(task.id, { status: 'in_progress' })
    const snapshot = snapshotTaskStore('conv-task-output-resume')
    resetTaskStore()
    restoreTaskStore(snapshot)

    const start = Date.now()
    const r = await tool.execute({ task_id: task.id, block: true, timeout: 600 })
    const elapsed = Date.now() - start

    expect(r.isError).toBe(false)
    expect(elapsed).toBeLessThan(200)
    expect(r.output).toContain('no live process handle')
    expect(r.output).toContain('Lifecycle: status=incomplete supervision_state=lost_handle can_wait=false terminal=false next_action=rerun_or_replace_command')
    expect(r.output).toContain('WaitPolicy: strategy=replace_or_retry recommended_wait_ms=0 max_wait_ms=0 stop_polling=true')
    expect((r.metadata as any).retrieval_status).toBe('incomplete')
    expect((r.metadata as any).task.longTaskSnapshot.status).toBe('incomplete')
    expect((r.metadata as any).long_task_lifecycle).toMatchObject({
      schema_version: 1,
      long_task_id: `task:${task.id}`,
      source: 'task_command',
      status: 'incomplete',
      supervision_state: 'lost_handle',
      terminal: false,
      can_wait: false,
      inspect_command: `TaskOutput task_id=${task.id} block=false`,
      next_action: 'rerun_or_replace_command',
      wait_policy: expect.objectContaining({
        strategy: 'replace_or_retry',
        stop_polling: true,
      }),
    })
  })

  it('restores the platform job snapshot for a command-backed task', async () => {
    const task = createTask({
      subject: 'Snapshot command job',
      description: 'job state survives task-store snapshot',
      conversationId: 'conv-task-output-job-snapshot',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    spawnTaskCommand(task.id)
    await new Promise(r => setTimeout(r, 20))
    const before = await tool.execute({ task_id: task.id, block: false })
    const beforeJob = (before.metadata as any).task.job

    const snapshot = snapshotTaskStore('conv-task-output-job-snapshot')
    resetTaskStore()
    restoreTaskStore(snapshot)

    const restored = await tool.execute({ task_id: task.id, block: false })
    expect((restored.metadata as any).task.job).toMatchObject({
      jobId: beforeJob.jobId,
      type: 'command',
      status: 'running',
      command: 'sleep 60; echo done',
      recoveryHint: `TaskOutput task_id=${task.id} block=false`,
    })
  })

  it('includes lifecycle verdict when a live command wait times out', async () => {
    const task = createTask({
      subject: 'Live command',
      description: 'command is still running in this process',
      conversationId: 'conv-task-output-live-timeout',
      command: 'sleep 1; echo done',
      cwd: '/tmp',
    })
    spawnTaskCommand(task.id)

    const r = await tool.execute({ task_id: task.id, block: true, timeout: 20 })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('Timeout waiting for task task-1')
    expect(r.output).toContain('Lifecycle: status=running supervision_state=live can_wait=true terminal=false next_action=inspect_again_later')
    expect(r.output).toContain('WaitPolicy: strategy=runtime_await recommended_wait_ms=5000 max_wait_ms=30000 stop_polling=false')
    expect((r.metadata as any).retrieval_status).toBe('timeout')
    expect((r.metadata as any).long_task_lifecycle).toMatchObject({
      long_task_id: `task:${task.id}`,
      status: 'running',
      supervision_state: 'live',
      terminal: false,
      can_wait: true,
      next_action: 'inspect_again_later',
      wait_policy: expect.objectContaining({
        strategy: 'runtime_await',
        recommended_wait_ms: 5000,
        max_wait_ms: 30000,
        stop_polling: false,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// Slice 1: Step board rendering tests
// ---------------------------------------------------------------------------

describe('TaskOutput — structured plan board (Slice 1)', () => {
  const tool = createTaskOutputTool()

  beforeEach(() => resetTaskStore())

  it('renders step board for task with steps', async () => {
    createTask({
      subject: 'Build deck', description: 'desc',
      steps: [
        { title: 'Extract outline', description: 'read docs' },
        { title: 'Generate slides', description: 'write HTML' },
      ],
    })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Steps:')
    expect(r.output).toContain('Extract outline')
    expect(r.output).toContain('Generate slides')
    expect(r.output).toContain('pending')
  })

  it('renders next step in output', async () => {
    createTask({
      subject: 'X', description: 'Y',
      steps: [
        { title: 'First Step', description: 'd1' },
        { title: 'Second Step', description: 'd2' },
      ],
    })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.output).toContain('Next:')
    expect(r.output).toContain('First Step')
  })

  it('block=true on structured plan returns immediately (no timeout)', async () => {
    createTask({
      subject: 'Plan', description: 'desc',
      steps: [{ title: 'S1', description: 'd' }],
    })
    const start = Date.now()
    const r = await tool.execute({ task_id: 'task-1', block: true, timeout: 100 })
    const elapsed = Date.now() - start
    expect(r.isError).toBe(false)
    // Should not wait 100ms — structured plan returns immediately
    expect(elapsed).toBeLessThan(200)
    expect((r.metadata as any).retrieval_status).toBe('success')
  })

  it('metadata includes nextStep for structured plan', async () => {
    createTask({
      subject: 'X', description: 'Y',
      steps: [{ title: 'Do thing', description: 'd' }],
    })
    const r = await tool.execute({ task_id: 'task-1' })
    const meta = (r.metadata as any).task
    expect(meta.nextStep).toBeDefined()
    expect(meta.nextStep.id).toBe('step-1')
    expect(meta.nextStep.title).toBe('Do thing')
    expect(meta.stepCount).toBe(1)
    expect(meta.openStepCount).toBe(1)
  })

  it('no-steps format unchanged', async () => {
    createTask({ subject: 'Plain', description: 'plain todo' })
    const r = await tool.execute({ task_id: 'task-1', block: false })
    expect(r.output).not.toContain('Steps:')
    expect(r.output).toContain('Plain')
  })

  it('shows in_progress step icon', async () => {
    createTask({
      subject: 'X', description: 'Y',
      steps: [
        { title: 'Step1', description: 'd' },
        { title: 'Step2', description: 'd' },
      ],
    })
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.output).toContain('▶')
    expect(r.output).toContain('in_progress')
  })
})
