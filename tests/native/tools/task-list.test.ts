import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskListTool } from '../../../src/native/tools/task-list.js'
import { resetTaskStore, createTask } from '../../../src/native/tools/task-store.js'

describe('TaskList tool', () => {
  const tool = createTaskListTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskList')
  })

  it('returns empty message when no tasks', async () => {
    const r = await tool.execute({})
    expect(r.isError).toBe(false)
    expect(r.output).toContain('No tasks')
  })

  it('lists all tasks with status icons', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const r = await tool.execute({})
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Tasks (2)')
    expect(r.output).toContain('task-1')
    expect(r.output).toContain('task-2')
  })

  it('shows blocked indicator', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    // Manually set blocked
    const { blockTask } = await import('../../../src/native/tools/task-store.js')
    blockTask('task-1', 'task-2')
    const r = await tool.execute({})
    expect(r.output).toContain('blocked by')
  })

  it('includes metadata with task array', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({})
    expect(r.metadata).toBeDefined()
    expect((r.metadata as any).tasks).toHaveLength(1)
  })
})
