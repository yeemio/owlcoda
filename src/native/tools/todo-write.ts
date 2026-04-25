/**
 * OwlCoda Native TodoWrite Tool
 *
 * Manages a structured task list for the current session.
 * The model uses this to track progress on multi-step tasks.
 *
 * Storage: in-memory array attached to the conversation context,
 * persisted via session save/restore.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

export interface TodoWriteInput {
  todos: TodoItem[]
}

/** Session-level todo storage (replaced each write). */
let currentTodos: TodoItem[] = []

export function getTodos(): TodoItem[] {
  return [...currentTodos]
}

export function setTodos(todos: TodoItem[]): void {
  currentTodos = [...todos]
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list is empty.'

  const lines: string[] = ['Todo List:', '']
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]!
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'
    const status = t.status === 'in_progress' ? t.activeForm : t.content
    lines.push(`  ${icon} ${status} [${t.status}]`)
  }

  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length
  lines.push('')
  lines.push(`Progress: ${completed}/${total}`)
  return lines.join('\n')
}

export function createTodoWriteTool(): NativeToolDef<TodoWriteInput> {
  return {
    name: 'TodoWrite',
    description:
      'Update the todo list for the current session. Track progress on multi-step tasks with pending/in_progress/completed states.',
    maturity: 'beta' as const,

    async execute(input: TodoWriteInput): Promise<ToolResult> {
      const { todos } = input

      if (!Array.isArray(todos)) {
        return { output: 'Error: todos must be an array', isError: true }
      }

      // Validate each item
      for (const item of todos) {
        if (!item.content || typeof item.content !== 'string') {
          return { output: 'Error: each todo must have a content string', isError: true }
        }
        if (!['pending', 'in_progress', 'completed'].includes(item.status)) {
          return { output: `Error: invalid status "${item.status}" — must be pending|in_progress|completed`, isError: true }
        }
        if (!item.activeForm || typeof item.activeForm !== 'string') {
          return { output: 'Error: each todo must have an activeForm string', isError: true }
        }
      }

      const oldTodos = getTodos()
      setTodos(todos)

      return {
        output: formatTodos(todos),
        isError: false,
        metadata: {
          oldCount: oldTodos.length,
          newCount: todos.length,
          completed: todos.filter(t => t.status === 'completed').length,
        },
      }
    },
  }
}
