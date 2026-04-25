import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  blockTask,
  deleteTask,
  stopTask,
  resetTaskStore,
} from '../../../src/native/tools/task-store.js'

describe('TaskStore', () => {
  beforeEach(() => resetTaskStore())

  it('creates a task with auto-incremented ID', () => {
    const t = createTask({ subject: 'Build feature', description: 'Do the thing' })
    expect(t.id).toBe('task-1')
    expect(t.subject).toBe('Build feature')
    expect(t.status).toBe('pending')
    expect(t.blocks).toEqual([])
    expect(t.blockedBy).toEqual([])
  })

  it('increments IDs sequentially', () => {
    const t1 = createTask({ subject: 'A', description: 'a' })
    const t2 = createTask({ subject: 'B', description: 'b' })
    expect(t1.id).toBe('task-1')
    expect(t2.id).toBe('task-2')
  })

  it('gets a task by ID', () => {
    createTask({ subject: 'X', description: 'y' })
    const found = getTask('task-1')
    expect(found).toBeDefined()
    expect(found!.subject).toBe('X')
  })

  it('returns undefined for missing task', () => {
    expect(getTask('task-999')).toBeUndefined()
  })

  it('lists all tasks', () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const tasks = listTasks()
    expect(tasks).toHaveLength(2)
  })

  it('updates task fields', () => {
    createTask({ subject: 'Old', description: 'old' })
    const updated = updateTask('task-1', { subject: 'New', status: 'in_progress' })
    expect(updated).toBeDefined()
    expect(updated!.subject).toBe('New')
    expect(updated!.status).toBe('in_progress')
  })

  it('updateTask returns undefined for missing ID', () => {
    expect(updateTask('nope', { subject: 'x' })).toBeUndefined()
  })

  it('blocks a task', () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    blockTask('task-1', 'task-2')
    const t1 = getTask('task-1')!
    const t2 = getTask('task-2')!
    expect(t1.blocks).toContain('task-2')
    expect(t2.blockedBy).toContain('task-1')
  })

  it('deletes a task', () => {
    createTask({ subject: 'A', description: 'a' })
    expect(deleteTask('task-1')).toBe(true)
    expect(getTask('task-1')).toBeUndefined()
    expect(listTasks()).toHaveLength(0)
  })

  it('deleteTask returns false for missing', () => {
    expect(deleteTask('nope')).toBe(false)
  })

  it('stops a task (sets cancelled)', () => {
    createTask({ subject: 'A', description: 'a' })
    updateTask('task-1', { status: 'in_progress' })
    const stopped = stopTask('task-1')
    expect(stopped).toBeDefined()
    expect(stopped!.status).toBe('cancelled')
  })

  it('resetTaskStore clears all tasks and resets counter', () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    resetTaskStore()
    expect(listTasks()).toHaveLength(0)
    const t = createTask({ subject: 'C', description: 'c' })
    expect(t.id).toBe('task-1')
  })
})
