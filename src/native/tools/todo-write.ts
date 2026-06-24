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
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
  activeForm: string
  failureReason?: string
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
    const icon =
      t.status === 'completed' ? '✓' :
      t.status === 'in_progress' ? '▶' :
      t.status === 'blocked' ? '⊘' :
      t.status === 'skipped' ? '↷' : '○'
    const status = t.status === 'in_progress' ? t.activeForm : t.content
    lines.push(`  ${icon} ${status} [${t.status}]`)
  }

  const completed = todos.filter(t => t.status === 'completed').length
  const active = todos.filter(t => t.status === 'in_progress').length
  const blocked = todos.filter(t => t.status === 'blocked').length
  const skipped = todos.filter(t => t.status === 'skipped').length
  const pending = todos.filter(t => t.status === 'pending').length
  const total = todos.length
  lines.push('')
  if (blocked > 0 || skipped > 0) {
    const parts = [`Progress: ${completed}/${total} completed`]
    if (active > 0) parts.push(`${active} active`)
    if (blocked > 0) parts.push(`${blocked} blocked`)
    if (skipped > 0) parts.push(`${skipped} skipped`)
    if (pending > 0) parts.push(`${pending} pending`)
    lines.push(parts.join(' · '))
  } else {
    lines.push(`Progress: ${completed}/${total}`)
  }
  return lines.join('\n')
}

export function createTodoWriteTool(): NativeToolDef<TodoWriteInput> {
  return {
    name: 'TodoWrite',
    description:
      'Update the todo list for the current session. Track progress on multi-step tasks with pending/in_progress/completed/blocked/skipped states. blocked/skipped todos require failureReason.',
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
        if (!['pending', 'in_progress', 'completed', 'blocked', 'skipped'].includes(item.status)) {
          return { output: `Error: invalid status "${item.status}" — must be pending|in_progress|completed|blocked|skipped`, isError: true }
        }
        if (!item.activeForm || typeof item.activeForm !== 'string') {
          return { output: 'Error: each todo must have an activeForm string', isError: true }
        }
        if ((item.status === 'blocked' || item.status === 'skipped') && (typeof item.failureReason !== 'string' || item.failureReason.trim().length === 0)) {
          return { output: `Error: ${item.status} todos require a non-empty failureReason`, isError: true }
        }
      }

      const oldTodos = getTodos()
      setTodos(todos)

      const completed = todos.filter(t => t.status === 'completed').length
      const blocked = todos.filter(t => t.status === 'blocked').length
      const skipped = todos.filter(t => t.status === 'skipped').length
      const metadata: Record<string, unknown> = {
        oldCount: oldTodos.length,
        newCount: todos.length,
        completed,
      }
      if (blocked > 0 || skipped > 0) {
        metadata['successful'] = completed
        metadata['blocked'] = blocked
        metadata['skipped'] = skipped
        metadata['terminalNonSuccess'] = blocked + skipped
      }

      return {
        output: formatTodos(todos),
        isError: false,
        metadata,
      }
    },
  }
}
