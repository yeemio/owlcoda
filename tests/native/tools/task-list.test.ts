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

  // Slice 1: step progress in list
  it('lists step progress completed/total for structured plans', async () => {
    createTask({
      subject: 'Deck', description: 'Make deck',
      steps: [
        { title: 'Step A', description: 'a' },
        { title: 'Step B', description: 'b' },
      ],
    })
    const { updateTaskStep } = await import('../../../src/native/tools/task-store.js')
    updateTaskStep('task-1', 'step-1', { status: 'in_progress' })
    updateTaskStep('task-1', 'step-1', { status: 'completed' })
    const r = await tool.execute({})
    expect(r.output).toContain('steps 1/2')
    const meta = (r.metadata as any).tasks[0]
    expect(meta.stepCount).toBe(2)
    expect(meta.completedSteps).toBe(1)
  })

  it('no-steps list unchanged — no step progress shown', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({})
    expect(r.output).not.toContain('steps')
  })
})
