import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskGetTool } from '../../../src/native/tools/task-get.js'
import { resetTaskStore, createTask, updateTaskStep } from '../../../src/native/tools/task-store.js'

describe('TaskGet tool', () => {
  const tool = createTaskGetTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskGet')
  })

  it('retrieves task by ID', async () => {
    createTask({ subject: 'Build it', description: 'Do the build' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('task-1')
    expect(r.output).toContain('Build it')
    expect(r.output).toContain('Do the build')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ taskId: 'task-999' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('returns error for empty taskId', async () => {
    const r = await tool.execute({ taskId: '' })
    expect(r.isError).toBe(true)
  })

  it('includes full task in metadata', async () => {
    createTask({ subject: 'X', description: 'y' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect((r.metadata as any).task.id).toBe('task-1')
  })

  it('shows blocking info', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const { blockTask } = await import('../../../src/native/tools/task-store.js')
    blockTask('task-1', 'task-2')
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.output).toContain('Blocks: task-2')
  })

  // Slice 1: step detail
  it('returns detailed step metadata for structured plan', async () => {
    createTask({
      subject: 'Build deck', description: 'desc',
      steps: [
        { title: 'Extract outline', description: 'read source' },
        { title: 'Generate slides', description: 'write HTML' },
      ],
    })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Step details:')
    expect(r.output).toContain('Extract outline')
    expect(r.output).toContain('Generate slides')
    const meta = (r.metadata as any).task
    expect(meta.stepCount).toBe(2)
    expect(meta.hasOpenRequiredSteps).toBe(true)
    expect(meta.nextStep).toBeDefined()
    expect(meta.nextStep.id).toBe('step-1')
  })

  it('shows skipped and blocked step accounting in structured plan details', async () => {
    createTask({
      subject: 'Canary', description: 'desc',
      steps: [
        { title: 'Wave 1', description: 'done' },
        { title: 'Wave 4', description: 'blocked runtime canary' },
        { title: 'Wave 5', description: 'dependent smoke' },
      ],
    })
    updateTaskStep('task-1', 'step-1', { status: 'completed' })
    updateTaskStep('task-1', 'step-2', { status: 'blocked', failureReason: 'runtime gap' })
    updateTaskStep('task-1', 'step-3', { status: 'skipped' as any, failureReason: 'Wave 4 blocked' })

    const r = await tool.execute({ taskId: 'task-1' })

    expect(r.output).toContain('Steps: 1/3 completed')
    expect(r.output).toContain('1 blocked')
    expect(r.output).toContain('1 skipped')
    expect(r.output).toContain('↷ step-3: Wave 5 [skipped]')
    const meta = (r.metadata as any).task
    expect(meta.completedSteps).toBe(1)
    expect(meta.blockedSteps).toBe(1)
    expect(meta.skippedSteps).toBe(1)
  })

  it('no-steps get unchanged', async () => {
    createTask({ subject: 'Simple', description: 'plain todo' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.output).not.toContain('Step details')
    expect(r.output).toContain('Simple')
  })
})
