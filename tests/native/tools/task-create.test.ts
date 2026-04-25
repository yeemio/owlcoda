import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskCreateTool } from '../../../src/native/tools/task-create.js'
import { resetTaskStore, listTasks } from '../../../src/native/tools/task-store.js'

describe('TaskCreate tool', () => {
  const tool = createTaskCreateTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskCreate')
  })

  it('creates a task', async () => {
    const r = await tool.execute({ subject: 'Build API', description: 'Create REST endpoints' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('task-1')
    expect(r.output).toContain('Build API')
    expect(listTasks()).toHaveLength(1)
  })

  it('returns error if subject is missing', async () => {
    const r = await tool.execute({ subject: '', description: 'x' })
    expect(r.isError).toBe(true)
  })

  it('returns error if description is missing', async () => {
    const r = await tool.execute({ subject: 'x', description: '' })
    expect(r.isError).toBe(true)
  })

  it('includes metadata with task ID', async () => {
    const r = await tool.execute({ subject: 'Test', description: 'desc' })
    expect(r.metadata).toBeDefined()
    expect((r.metadata as any).task.id).toBe('task-1')
  })
})
