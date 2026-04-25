import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskOutputTool } from '../../../src/native/tools/task-output.js'
import { resetTaskStore, createTask, updateTask } from '../../../src/native/tools/task-store.js'

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
