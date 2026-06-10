import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskUpdateTool } from '../../../src/native/tools/task-update.js'
import { resetTaskStore, createTask, getTask, blockTask } from '../../../src/native/tools/task-store.js'

describe('TaskUpdate tool', () => {
  const tool = createTaskUpdateTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskUpdate')
  })

  it('updates subject and status', async () => {
    createTask({ subject: 'Old', description: 'desc' })
    const r = await tool.execute({ taskId: 'task-1', subject: 'New', status: 'in_progress' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('subject="New"')
    expect(r.output).toContain('status=in_progress')
    expect(getTask('task-1')!.subject).toBe('New')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ taskId: 'task-999', subject: 'x' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('returns error for empty taskId', async () => {
    const r = await tool.execute({ taskId: '' })
    expect(r.isError).toBe(true)
  })

  it('rejects invalid status', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1', status: 'bogus' as any })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Invalid status')
  })

  it('deletes task with status "deleted"', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1', status: 'deleted' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Deleted')
    expect(getTask('task-1')).toBeUndefined()
  })

  it('adds blocking relationships', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const r = await tool.execute({ taskId: 'task-1', addBlocks: ['task-2'] })
    expect(r.isError).toBe(false)
    expect(getTask('task-1')!.blocks).toContain('task-2')
    expect(getTask('task-2')!.blockedBy).toContain('task-1')
  })

  it('removes blocking relationships', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    blockTask('task-1', 'task-2')
    const r = await tool.execute({ taskId: 'task-1', removeBlocks: ['task-2'] })
    expect(r.isError).toBe(false)
    expect(getTask('task-1')!.blocks).not.toContain('task-2')
    expect(getTask('task-2')!.blockedBy).not.toContain('task-1')
  })

  it('reports no changes gracefully', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('no changes')
  })
})

// ---------------------------------------------------------------------------
// Slice 1: Step update tests
// ---------------------------------------------------------------------------

describe('TaskUpdate — step updates (Slice 1)', () => {
  const tool = createTaskUpdateTool()

  beforeEach(() => resetTaskStore())

  function makeTask() {
    return createTask({
      subject: 'Build deck', description: 'desc',
      steps: [
        { title: 'Step A', description: 'First' },
        { title: 'Step B', description: 'Second' },
      ],
    })
  }

  it('updates step to in_progress', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('step-1')
    expect(r.output).toContain('in_progress')
    expect((r.metadata as any).stepUpdate).toBe(true)
  })

  it('refuses second in_progress step', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-2', stepStatus: 'in_progress' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/already in_progress/)
  })

  it('updates step touchedPaths', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', touchedPaths: ['/tmp/out.html'] })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('touchedPaths +1')
  })

  it('updates verificationResults', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verificationResults: [{ checkId: 'v1', passed: true, checkedAt: new Date().toISOString() }],
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('verification 1/1 passed')
  })

  it('completes step after passed verification', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      stepStatus: 'completed',
      verificationResults: [{ checkId: 'v1', passed: true, checkedAt: new Date().toISOString() }],
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('completed')
  })

  it('refuses completed if verification failed', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      stepStatus: 'completed',
      verificationResults: [{ checkId: 'v1', passed: false, detail: 'missing', checkedAt: new Date().toISOString() }],
    })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/verification check/)
  })

  it('marks blocked with failureReason', async () => {
    makeTask()
    const r = await tool.execute({
      taskId: 'task-1', stepId: 'step-1',
      stepStatus: 'blocked',
      failureReason: 'missing template file',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('blocked')
  })

  it('refuses blocked without failureReason', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'blocked' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/failureReason/)
  })

  it('task-level update still works alongside steps', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', subject: 'New Subject' })
    expect(r.isError).toBe(false)
    const task = getTask('task-1')!
    expect(task.subject).toBe('New Subject')
    expect(task.steps).toHaveLength(2) // steps unchanged
  })
})
