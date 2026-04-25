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
