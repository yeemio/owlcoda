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
