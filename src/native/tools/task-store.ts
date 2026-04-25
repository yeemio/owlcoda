/**
 * OwlCoda Native Task Store
 *
 * In-memory task management backing the Task* tools.
 * Tasks persist for the session lifetime.
 *
 * Upstream parity notes:
 * - Upstream uses utils/tasks.ts with file-backed JSON storage
 * - Supports task lists, hooks, teammate ownership
 * - Our version: in-memory Map with same field structure
 */

/** Task status values matching upstream TaskStatusSchema. */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked'

export interface Task {
  id: string
  subject: string
  description: string
  status: TaskStatus
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks: string[]
  blockedBy: string[]
  owner?: string
  createdAt: string
  updatedAt: string
}

let nextId = 1
const tasks = new Map<string, Task>()

/** Generate a sequential task ID. */
function genId(): string {
  return `task-${nextId++}`
}

/** Create a new task. */
export function createTask(opts: {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}): Task {
  const now = new Date().toISOString()
  const task: Task = {
    id: genId(),
    subject: opts.subject,
    description: opts.description,
    status: 'pending',
    activeForm: opts.activeForm,
    metadata: opts.metadata,
    blocks: [],
    blockedBy: [],
    createdAt: now,
    updatedAt: now,
  }
  tasks.set(task.id, task)
  return task
}

/** Get a task by ID. */
export function getTask(id: string): Task | undefined {
  return tasks.get(id)
}

/** List all tasks. */
export function listTasks(): Task[] {
  return [...tasks.values()]
}

/** Update a task's fields. Returns the updated task or undefined if not found. */
export function updateTask(
  id: string,
  updates: Partial<Pick<Task, 'subject' | 'description' | 'status' | 'activeForm' | 'metadata'>>,
): Task | undefined {
  const task = tasks.get(id)
  if (!task) return undefined

  if (updates.subject !== undefined) task.subject = updates.subject
  if (updates.description !== undefined) task.description = updates.description
  if (updates.status !== undefined) task.status = updates.status
  if (updates.activeForm !== undefined) task.activeForm = updates.activeForm
  if (updates.metadata !== undefined) task.metadata = { ...task.metadata, ...updates.metadata }
  task.updatedAt = new Date().toISOString()

  return task
}

/** Add a blocking relationship: taskId blocks blockedId. */
export function blockTask(taskId: string, blockedId: string): boolean {
  const task = tasks.get(taskId)
  const blocked = tasks.get(blockedId)
  if (!task || !blocked) return false
  if (!task.blocks.includes(blockedId)) task.blocks.push(blockedId)
  if (!blocked.blockedBy.includes(taskId)) blocked.blockedBy.push(taskId)
  return true
}

/** Delete a task. */
export function deleteTask(id: string): boolean {
  const task = tasks.get(id)
  if (!task) return false
  // Remove from blocking relationships
  for (const t of tasks.values()) {
    t.blocks = t.blocks.filter(bid => bid !== id)
    t.blockedBy = t.blockedBy.filter(bid => bid !== id)
  }
  return tasks.delete(id)
}

/** Stop a task (set to cancelled). */
export function stopTask(id: string): Task | undefined {
  return updateTask(id, { status: 'cancelled' })
}

/** Reset store (for testing). */
export function resetTaskStore(): void {
  tasks.clear()
  nextId = 1
}
