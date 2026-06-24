import { describe, it, expect, beforeEach } from 'vitest'
import { createTodoWriteTool, getTodos, setTodos } from '../../src/native/tools/todo-write.js'

describe('TodoWrite Tool', () => {
  beforeEach(() => {
    setTodos([])
  })

  it('accepts a valid todo list', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: 'Build feature', status: 'pending', activeForm: 'Building feature' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      ],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Todo List:')
    expect(result.output).toContain('Build feature')
    expect(result.output).toContain('Writing tests')
    expect(result.output).toContain('○')
    expect(result.output).toContain('▶')
  })

  it('stores todos accessible via getTodos()', async () => {
    const tool = createTodoWriteTool()
    await tool.execute({
      todos: [{ content: 'Task A', status: 'pending', activeForm: 'Doing A' }],
    })
    const stored = getTodos()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.content).toBe('Task A')
  })

  it('replaces previous todos on each write', async () => {
    const tool = createTodoWriteTool()
    await tool.execute({
      todos: [{ content: 'Old', status: 'pending', activeForm: 'Old' }],
    })
    await tool.execute({
      todos: [
        { content: 'New A', status: 'completed', activeForm: 'New A' },
        { content: 'New B', status: 'pending', activeForm: 'New B' },
      ],
    })
    expect(getTodos()).toHaveLength(2)
    expect(getTodos()[0]!.content).toBe('New A')
  })

  it('shows progress count', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: 'Done', status: 'completed', activeForm: 'Done' },
        { content: 'Pending', status: 'pending', activeForm: 'Pending' },
        { content: 'WIP', status: 'in_progress', activeForm: 'Working' },
      ],
    })
    expect(result.output).toContain('Progress: 1/3')
  })

  it('accepts skipped and blocked todos with explicit failure reasons without counting them as done', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: 'Wave 1 shipped', status: 'completed', activeForm: 'Wave 1 shipped' },
        {
          content: 'Wave 4 blocked by runtime adapter_path gap',
          status: 'blocked',
          activeForm: 'Recording runtime blocker',
          failureReason: 'runtime adapter_path gap prevents serving Wave 4',
        },
        {
          content: 'Wave 5 skipped because Wave 4 did not serve',
          status: 'skipped',
          activeForm: 'Skipping dependent smoke',
          failureReason: 'dependent smoke requires Wave 4 runtime to serve',
        },
        { content: 'Wave 6 report blocked outcome', status: 'pending', activeForm: 'Writing blocked outcome' },
      ],
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('⊘ Wave 4 blocked by runtime adapter_path gap [blocked]')
    expect(result.output).toContain('↷ Wave 5 skipped because Wave 4 did not serve [skipped]')
    expect(result.output).toContain('Progress: 1/4 completed')
    expect(result.output).toContain('1 blocked')
    expect(result.output).toContain('1 skipped')
    expect(result.metadata).toMatchObject({
      completed: 1,
      blocked: 1,
      skipped: 1,
      successful: 1,
      terminalNonSuccess: 2,
    })
  })

  it('rejects skipped todos without a non-empty failureReason', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: 'Skip dependent smoke', status: 'skipped', activeForm: 'Skipping dependent smoke' } as any,
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('failureReason')
    expect(getTodos()).toHaveLength(0)
  })

  it('rejects blocked todos with a blank failureReason', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        {
          content: 'Wait for runtime adapter',
          status: 'blocked',
          activeForm: 'Waiting for runtime adapter',
          failureReason: '   ',
        },
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('failureReason')
    expect(getTodos()).toHaveLength(0)
  })

  it('handles empty todo list', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({ todos: [] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('empty')
  })

  it('uses completed icon for completed tasks', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [{ content: 'Done task', status: 'completed', activeForm: 'Done task' }],
    })
    expect(result.output).toContain('✓')
  })

  it('rejects invalid status', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [{ content: 'Bad', status: 'invalid' as any, activeForm: 'Bad' }],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('invalid status')
  })

  it('rejects missing content', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [{ content: '', status: 'pending', activeForm: 'X' }],
    })
    expect(result.isError).toBe(true)
  })

  it('rejects non-array input', async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({ todos: 'not-an-array' as any })
    expect(result.isError).toBe(true)
  })

  it('returns metadata with counts', async () => {
    setTodos([{ content: 'Old', status: 'pending', activeForm: 'Old' }])
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: 'A', status: 'completed', activeForm: 'A' },
        { content: 'B', status: 'pending', activeForm: 'B' },
      ],
    })
    expect(result.metadata).toEqual({ oldCount: 1, newCount: 2, completed: 1 })
  })
})
