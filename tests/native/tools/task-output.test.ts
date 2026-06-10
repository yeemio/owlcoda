import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskOutputTool } from '../../../src/native/tools/task-output.js'
import { resetTaskStore, createTask, updateTask, updateTaskStep } from '../../../src/native/tools/task-store.js'

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
