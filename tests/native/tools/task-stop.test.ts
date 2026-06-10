import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskStopTool } from '../../../src/native/tools/task-stop.js'
import { resetTaskStore, createTask, updateTask, getTask } from '../../../src/native/tools/task-store.js'

describe('TaskStop tool', () => {
  const tool = createTaskStopTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskStop')
  })

  it('stops a running task', async () => {
    createTask({ subject: 'Running', description: 'doing stuff' })
    updateTask('task-1', { status: 'in_progress' })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Stopped')
    expect(getTask('task-1')!.status).toBe('cancelled')
  })

  it('accepts shell_id alias', async () => {
    createTask({ subject: 'A', description: 'a' })
    updateTask('task-1', { status: 'in_progress' })
    const r = await tool.execute({ shell_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Stopped')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ task_id: 'task-999' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('returns error without task_id', async () => {
    const r = await tool.execute({})
    expect(r.isError).toBe(true)
  })

  it('reports already completed tasks', async () => {
    createTask({ subject: 'Done', description: 'finished' })
    updateTask('task-1', { status: 'completed' })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('already completed')
  })

  it('reports already cancelled tasks', async () => {
    createTask({ subject: 'X', description: 'y' })
    updateTask('task-1', { status: 'cancelled' })
    const r = await tool.execute({ task_id: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('already cancelled')
  })
})
