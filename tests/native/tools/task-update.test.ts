import { describe, it, expect, beforeEach } from 'vitest'
import { createTaskUpdateTool } from '../../../src/native/tools/task-update.js'
import { resetTaskStore, createTask, getTask, getTaskStep, blockTask, recordTaskVerificationOutcome } from '../../../src/native/tools/task-store.js'

describe('TaskUpdate tool', () => {
  const tool = createTaskUpdateTool()

  beforeEach(() => resetTaskStore())

  it('has correct name', () => {
    expect(tool.name).toBe('TaskUpdate')
  })

  it('updates subject and status', async () => {
    createTask({ subject: 'Old', description: 'desc' })
    const r = await tool.execute({ taskId: 'task-1', subject: 'New', status: 'in_progress' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('subject="New"')
    expect(r.output).toContain('status=in_progress')
    expect(getTask('task-1')!.subject).toBe('New')
  })

  it('accepts short task id aliases like t-1 for task-level updates', async () => {
    createTask({ subject: 'Old', description: 'desc' })
    const r = await tool.execute({ taskId: 't-1', status: 'in_progress' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Resolved taskId alias: t-1 -> task-1')
    expect(getTask('task-1')!.status).toBe('in_progress')
  })

  it('returns error for missing task', async () => {
    const r = await tool.execute({ taskId: 'task-999', subject: 'x' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
    expect(r.output).toContain('Call TaskList')
    expect(r.metadata).toMatchObject({
      missingTask: true,
      recoveryAction: 'inspect_or_create_task',
    })
  })

  it('returns error for empty taskId', async () => {
    const r = await tool.execute({ taskId: '' })
    expect(r.isError).toBe(true)
  })

  it('rejects invalid status', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1', status: 'bogus' as any })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Invalid status')
  })

  it('deletes task with status "deleted"', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1', status: 'deleted' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Deleted')
    expect(getTask('task-1')).toBeUndefined()
  })

  it('adds blocking relationships', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    const r = await tool.execute({ taskId: 'task-1', addBlocks: ['task-2'] })
    expect(r.isError).toBe(false)
    expect(getTask('task-1')!.blocks).toContain('task-2')
    expect(getTask('task-2')!.blockedBy).toContain('task-1')
  })

  it('removes blocking relationships', async () => {
    createTask({ subject: 'A', description: 'a' })
    createTask({ subject: 'B', description: 'b' })
    blockTask('task-1', 'task-2')
    const r = await tool.execute({ taskId: 'task-1', removeBlocks: ['task-2'] })
    expect(r.isError).toBe(false)
    expect(getTask('task-1')!.blocks).not.toContain('task-2')
    expect(getTask('task-2')!.blockedBy).not.toContain('task-1')
  })

  it('reports no changes gracefully', async () => {
    createTask({ subject: 'A', description: 'a' })
    const r = await tool.execute({ taskId: 'task-1' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('no changes')
  })
})

// ---------------------------------------------------------------------------
// Slice 1: Step update tests
// ---------------------------------------------------------------------------

describe('TaskUpdate — step updates (Slice 1)', () => {
  const tool = createTaskUpdateTool()

  beforeEach(() => resetTaskStore())

  function makeTask() {
    return createTask({
      subject: 'Build deck', description: 'desc',
      steps: [
        { title: 'Step A', description: 'First' },
        { title: 'Step B', description: 'Second' },
      ],
    })
  }

  it('updates step to in_progress', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('step-1')
    expect(r.output).toContain('in_progress')
    expect((r.metadata as any).stepUpdate).toBe(true)
  })

  it('refuses second in_progress step', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-2', stepStatus: 'in_progress' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/already in_progress/)
  })

	  it('returns a structured repair hint when another step is already in_progress', async () => {
	    makeTask()
	    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-2', stepStatus: 'in_progress' })

    expect(r.isError).toBe(true)
    expect(r.output).toContain('repairHint')
    expect(r.output).toContain('TaskUpdate({ taskId: "task-1", stepId: "step-1", stepStatus: "completed" })')
    expect(r.output).toContain('TaskUpdate({ taskId: "task-1", stepId: "step-1", stepStatus: "blocked", failureReason: "..." })')
    expect(r.metadata).toMatchObject({
      repairHint: {
        kind: 'active_step_conflict',
        taskId: 'task-1',
        activeStepId: 'step-1',
        requestedStepId: 'step-2',
      },
	    })
	  })

  it('atomically completes the previous active step when moving another step in_progress', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })

    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-2',
      stepStatus: 'in_progress',
      completePrevious: true,
    })

    expect(r.isError).toBe(false)
    expect(r.output).toContain('completedPrevious=step-1')
    expect(getTaskStep('task-1', 'step-1')?.status).toBe('completed')
    expect(getTaskStep('task-1', 'step-2')?.status).toBe('in_progress')
    expect(r.metadata).toMatchObject({
      stepUpdate: true,
      completedPreviousStepId: 'step-1',
    })
  })

	  it('updates step touchedPaths', async () => {
	    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', touchedPaths: ['/tmp/out.html'] })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('touchedPaths +1')
  })

  it('rejects model-authored verificationResults', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verificationResults: [{ checkId: 'v1', passed: true, checkedAt: new Date().toISOString() }],
    } as any)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('TaskVerify')
    expect(getTaskStep('task-1', 'step-1')?.verificationResults).toEqual([])
  })

  it('rejects verification command checks that TaskVerify would refuse', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verification: [{
        id: 'curl-html',
        kind: 'command',
        command: 'curl -s http://127.0.0.1:5182/ | head -c 3000',
      }],
    })

    expect(r.isError).toBe(true)
    expect(r.output).toContain('Unsafe TaskVerify command check')
    expect(r.output).toContain('curl-html')
    expect(getTaskStep('task-1', 'step-1')?.verification).toEqual([])
  })

  it('refuses to combine step completion with model-authored passed evidence', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      stepStatus: 'completed',
      verificationResults: [{ checkId: 'v1', passed: true, checkedAt: new Date().toISOString() }],
    } as any)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('TaskVerify')
    expect(getTaskStep('task-1', 'step-1')?.status).toBe('in_progress')
  })

  it('refuses completed if verification failed', async () => {
    makeTask()
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [
      { checkId: 'v1', passed: false, detail: 'missing', checkedAt: new Date().toISOString() },
    ])
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'completed' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/verification check/)
  })

  it('refuses completed when verification checks have no results', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'completed' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/TaskVerify|verification result|verification checks failed/i)
  })

  it('does not allow failed verification to be bypassed by clearing results', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [
      { checkId: 'v1', passed: false, detail: 'missing', checkedAt: new Date().toISOString() },
    ])
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', verificationResults: [] } as any)

    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'completed' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/TaskVerify|verification result|verification checks failed/i)
  })

  it('replaces a broken verification spec and clears stale results until re-verified', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/xxx-report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [{
        checkId: 'v1',
        passed: false,
        detail: 'path looks like an unresolved placeholder',
        checkedAt: new Date().toISOString(),
        unsatisfiable: true,
      } as any])

    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/final-report.md' }],
    } as any)

    expect(r.isError).toBe(false)
    expect(r.output).toContain('verification spec 1 checks')
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verification[0]?.path).toBe('/tmp/final-report.md')
    expect(step.verificationResults).toEqual([])

    const complete = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'completed' })
    expect(complete.isError).toBe(true)
    expect(complete.output).toMatch(/TaskVerify|verification result/i)
  })

  it('refuses to weaken failed verification by clearing the spec', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [
      { checkId: 'v1', passed: false, detail: 'missing', checkedAt: new Date().toISOString() },
    ])

    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verification: [],
    })

    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/cannot.*weaken|failed verification/i)
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verification).toHaveLength(1)
    expect(step.verification[0]?.kind).toBe('file_exists')
    expect(step.verificationResults).toHaveLength(1)
  })

  it('refuses to weaken failed verification by replacing it with none', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [
      { checkId: 'v1', passed: false, detail: 'missing', checkedAt: new Date().toISOString() },
    ])

    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verification: [{ id: 'v1', kind: 'none', reason: 'skip after failed verification' }],
    })

    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/cannot.*weaken|failed verification/i)
    const step = getTaskStep('task-1', 'step-1')!
    expect(step.verification).toHaveLength(1)
    expect(step.verification[0]?.kind).toBe('file_exists')
    expect(step.verificationResults).toHaveLength(1)
  })

  it('refuses to change verification evidence on a completed step', async () => {
    createTask({
      subject: 'Build report',
      description: 'desc',
      steps: [{
        title: 'Write report',
        description: 'First',
        verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/report.md' }],
      }],
    })
    await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'in_progress' })
    recordTaskVerificationOutcome('task-1', 'step-1', [
      { checkId: 'v1', passed: true, checkedAt: new Date().toISOString() },
    ])

    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-1',
      verification: [{ id: 'v1', kind: 'file_exists', path: '/tmp/other.md' }],
    } as any)

    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/completed.*cannot.*verification/i)
  })

  it('marks blocked with failureReason', async () => {
    makeTask()
    const r = await tool.execute({
      taskId: 'task-1', stepId: 'step-1',
      stepStatus: 'blocked',
      failureReason: 'missing template file',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('blocked')
  })

  it('refuses blocked without failureReason', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-1', stepStatus: 'blocked' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/failureReason/)
  })

  it('marks skipped with failureReason for dependent work that cannot run', async () => {
    makeTask()
    const r = await tool.execute({
      taskId: 'task-1',
      stepId: 'step-2',
      stepStatus: 'skipped' as any,
      failureReason: 'Skipped because prerequisite Wave 4 is blocked.',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('skipped')
    expect(getTask('task-1')?.steps?.[1]?.status).toBe('skipped')
  })

  it('refuses skipped without failureReason', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', stepId: 'step-2', stepStatus: 'skipped' as any })
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/failureReason/)
  })

  it('task-level update still works alongside steps', async () => {
    makeTask()
    const r = await tool.execute({ taskId: 'task-1', subject: 'New Subject' })
    expect(r.isError).toBe(false)
    const task = getTask('task-1')!
    expect(task.subject).toBe('New Subject')
    expect(task.steps).toHaveLength(2) // steps unchanged
  })
})
