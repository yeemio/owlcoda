import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskGetTool } from '../../../src/native/tools/task-get.js'
import { resetTaskStore, createTask } from '../../../src/native/tools/task-store.js'

describe('TaskGet tool', () => {
  const tool = createTaskGetTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskGet')
  })

  it('retrieves task by ID', async () => {
    createTask({ subject: 'Build it', description: 'Do the build' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('task-1')
    expect(r.output).toContain('Build it')
    expect(r.output).toContain('Do the build')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ taskId: 'task-999' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('returns error for empty taskId', async () => {
    const r = await tool.execute({ taskId: '' })
    expect(r.isError).toBe(true)
  })

  it('includes full task in metadata', async () => {
    createTask({ subject: 'X', description: 'y' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect((r.metadata as any).task.id).toBe('task-1')
  })

  it('shows blocking info', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const { blockTask } = await import('../../../src/native/tools/task-store.js')
    blockTask('task-1', 'task-2')
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.output).toContain('Blocks: task-2')
  })
})
