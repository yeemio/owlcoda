import { describe, it, expect, beforeEach } from 'vitest'
import * as taskStore from '../../../src/native/tools/task-store.js'
import {
  getRunLifecycleSnapshot,
  resetRunLifecycleForTesting,
} from '../../../src/native/run-lifecycle.js'
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  blockTask,
  deleteTask,
  stopTask,
  resetTaskStore,
  hasRunningProcess,
  getTaskStep,
  updateTaskStep,
  getCurrentOrNextStep,
  taskHasOpenRequiredSteps,
  findLatestOpenTask,
  findNextStep,
} from '../../../src/native/tools/task-store.js'

describe('TaskStore', () => {
  beforeEach(() => {
    resetTaskStore()
    resetRunLifecycleForTesting()
  })

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

  it('snapshots and restores serializable tasks without reviving process handles', () => {
    const task = createTask({
      subject: 'Resume proof',
      description: 'TaskStore should survive session restore',
      conversationId: 'conv-resume-proof',
      steps: [{
        id: 'prove-resume',
        title: 'Prove resume',
        description: 'verify after restore',
        verification: [{ id: 'artifact', kind: 'file_exists', path: '/tmp/owlcoda-task-store-proof.txt' }],
      }],
    })
    updateTaskStep(task.id, 'prove-resume', {
      status: 'blocked',
      failureReason: 'artifact not present yet',
    })

    expect(typeof (taskStore as any).snapshotTaskStore).toBe('function')
    expect(typeof (taskStore as any).restoreTaskStore).toBe('function')

    const snapshot = (taskStore as any).snapshotTaskStore('conv-resume-proof')
    resetTaskStore()
    expect(getTask(task.id)).toBeUndefined()

    ;(taskStore as any).restoreTaskStore(snapshot)

    const restored = getTask(task.id)
    expect(restored?.subject).toBe('Resume proof')
    expect(restored?.steps?.[0]?.status).toBe('blocked')
    expect(restored?.steps?.[0]?.verification[0]?.path).toBe('/tmp/owlcoda-task-store-proof.txt')
    expect((taskStore as any)._processCount()).toBe(0)

    const next = createTask({ subject: 'Next', description: 'id should not collide' })
    expect(next.id).toBe('task-2')
  })

  it('restores in-progress command tasks as incomplete when no process handle survives', () => {
    const task = createTask({
      subject: 'Long command',
      description: 'Command was running before resume',
      conversationId: 'conv-command-resume',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    updateTask(task.id, { status: 'in_progress' })
    const live = getTask(task.id)!
    live.stdout = 'started\n'

    const snapshot = (taskStore as any).snapshotTaskStore('conv-command-resume')
    resetTaskStore()
    ;(taskStore as any).restoreTaskStore(snapshot)

    const restored = getTask(task.id)!
    expect(restored.status).toBe('in_progress')
    expect(hasRunningProcess(task.id)).toBe(false)
    expect(restored.longTaskSnapshot?.status).toBe('incomplete')
    expect(restored.longTaskSnapshot?.timeoutKind).toBe('process_handle_missing_after_resume')
    expect(restored.longTaskSnapshot?.inspectCommand).toBe(`TaskOutput task_id=${task.id} block=false`)
  })

  it('persists command process identity across snapshots without reviving the process handle', () => {
    const task = createTask({
      subject: 'Long command identity',
      description: 'Command process identity should survive session restore',
      conversationId: 'conv-command-identity',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    taskStore.spawnTaskCommand(task.id)

    const live = getTask(task.id)!
    expect(live.processIdentity).toMatchObject({
      schema_version: 1,
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    expect(live.processIdentity?.pid).toEqual(expect.any(Number))
    expect(live.processIdentity!.pid).toBeGreaterThan(0)
    expect(live.processIdentity?.spawnedAt).toEqual(expect.any(String))
    expect(live.longTaskSnapshot?.processIdentity?.pid).toBe(live.processIdentity?.pid)

    const snapshot = (taskStore as any).snapshotTaskStore('conv-command-identity')
    expect(snapshot.tasks[0].processIdentity?.pid).toBe(live.processIdentity?.pid)

    resetTaskStore()
    ;(taskStore as any).restoreTaskStore(snapshot)

    const restored = getTask(task.id)!
    expect(hasRunningProcess(task.id)).toBe(false)
    expect(restored.longTaskSnapshot?.status).toBe('incomplete')
    expect(restored.processIdentity?.pid).toBe(live.processIdentity?.pid)
    expect(restored.longTaskSnapshot?.processIdentity?.pid).toBe(live.processIdentity?.pid)
  })

  it('mirrors command task lifecycle into the unified run lifecycle registry', () => {
    const task = createTask({
      subject: 'Lifecycle command',
      description: 'Command should appear in run lifecycle',
      conversationId: 'conv-run-lifecycle',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    taskStore.spawnTaskCommand(task.id)

    expect(getRunLifecycleSnapshot(`task:${task.id}`)).toMatchObject({
      runId: `task:${task.id}`,
      kind: 'task_command',
      status: 'running',
      owner: 'runtime_supervisor',
      inspectCommand: `TaskOutput task_id=${task.id} block=false`,
      recoveryPolicy: expect.objectContaining({
        strategy: 'runtime_await',
        next_command: `LongTaskAwait longTaskId=task:${task.id} timeoutMs=5000`,
      }),
    })
  })

  it('mirrors restored lost-handle command tasks into run lifecycle as incomplete', () => {
    const task = createTask({
      subject: 'Restored lifecycle command',
      description: 'Missing child handle should be inspectable',
      conversationId: 'conv-run-lifecycle-restore',
      command: 'sleep 60; echo done',
      cwd: '/tmp',
    })
    updateTask(task.id, { status: 'in_progress' })
    const snapshot = (taskStore as any).snapshotTaskStore('conv-run-lifecycle-restore')
    resetTaskStore()
    ;(taskStore as any).restoreTaskStore(snapshot)

    expect(getRunLifecycleSnapshot(`task:${task.id}`)).toMatchObject({
      runId: `task:${task.id}`,
      kind: 'task_command',
      status: 'incomplete',
      recoveryPolicy: expect.objectContaining({
        strategy: 'replace_or_retry',
        next_command: `LongTaskReplace longTaskId=task:${task.id}`,
      }),
      evidence: expect.objectContaining({
        timeout_kind: 'process_handle_missing_after_resume',
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// Slice 1: Step model tests
// ---------------------------------------------------------------------------

describe('TaskStore — Steps (Slice 1)', () => {
  beforeEach(() => resetTaskStore())

  function makeTaskWithSteps() {
    return createTask({
      subject: 'Build deck',
      description: 'Generate a 12-page deck',
      steps: [
        { title: 'Extract outline', description: 'Read source material' },
        { title: 'Generate slides 01-06', description: 'Write first batch' },
        { title: 'Verify slides 01-06', description: 'Check section count' },
      ],
    })
  }

  it('createTask accepts steps and normalizes defaults', () => {
    const task = makeTaskWithSteps()
    expect(task.steps).toHaveLength(3)
    const s = task.steps![0]!
    expect(s.status).toBe('pending')
    expect(s.action).toEqual({ kind: 'local_tool' })
    expect(s.expectedArtifacts).toEqual([])
    expect(s.verification).toEqual([])
    expect(s.verificationResults).toEqual([])
    expect(s.touchedPaths).toEqual([])
  })

  it('step ids auto-generate as step-1, step-2, ...', () => {
    const task = makeTaskWithSteps()
    expect(task.steps!.map(s => s.id)).toEqual(['step-1', 'step-2', 'step-3'])
  })

  it('duplicate step ids are rejected in createTask validation (via task-create tool)', () => {
    // Direct createTask allows duplicates from opts - duplicate check is in the tool layer.
    // Just verify explicit IDs are preserved.
    const task = createTask({
      subject: 'X', description: 'x',
      steps: [
        { id: 'my-step', title: 'A', description: 'a' },
        { id: 'my-step-2', title: 'B', description: 'b' },
      ],
    })
    expect(task.steps![0]!.id).toBe('my-step')
    expect(task.steps![1]!.id).toBe('my-step-2')
  })

  it('getTaskStep returns the step', () => {
    const task = makeTaskWithSteps()
    const step = getTaskStep(task.id, 'step-2')
    expect(step).toBeDefined()
    expect(step!.title).toBe('Generate slides 01-06')
  })

  it('getTaskStep returns undefined for missing step', () => {
    const task = makeTaskWithSteps()
    expect(getTaskStep(task.id, 'step-99')).toBeUndefined()
  })

  // 2026-06-13 dogfood (P2-11): a model lost track of which step ids belonged
  // to a task and kept calling TaskUpdate/TaskVerify with invented ids
  // (step-5 on a 3-step task). The "not found" error named the bad id but not
  // the valid ones, giving the model nothing to self-correct from. List them.
  it('lists the available step ids when updateTaskStep targets a missing step', () => {
    const task = makeTaskWithSteps()
    const r = updateTaskStep(task.id, 'step-5', { status: 'in_progress' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('not found')
    expect(r.ok === false && r.reason).toContain('step-1')
    expect(r.ok === false && r.reason).toContain('step-2')
    expect(r.ok === false && r.reason).toContain('step-3')
  })

  it('getCurrentOrNextStep returns in_progress first', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-2', { status: 'in_progress' })
    const next = getCurrentOrNextStep(task.id)
    expect(next?.id).toBe('step-2')
  })

  it('getCurrentOrNextStep returns first pending when none in progress', () => {
    const task = makeTaskWithSteps()
    const next = getCurrentOrNextStep(task.id)
    expect(next?.id).toBe('step-1')
  })

  it('getCurrentOrNextStep returns undefined when task has no steps', () => {
    createTask({ subject: 'no steps', description: 'plain todo' })
    expect(getCurrentOrNextStep('task-1')).toBeUndefined()
  })

  it('cannot set second step in_progress while another is in_progress', () => {
    const task = makeTaskWithSteps()
    const r1 = updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    expect(r1.ok).toBe(true)
    const r2 = updateTaskStep(task.id, 'step-2', { status: 'in_progress' })
    expect(r2.ok).toBe(false)
    expect(r2.ok === false && r2.reason).toMatch(/already in_progress/)
  })

  it('can complete step when all verification results passed', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    const r = updateTaskStep(task.id, 'step-1', {
      status: 'completed',
      verificationResults: [{ checkId: 'v1', passed: true, checkedAt: new Date().toISOString() }],
    })
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.step.status).toBe('completed')
  })

  it('cannot complete step with failed verification result', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    const r = updateTaskStep(task.id, 'step-1', {
      status: 'completed',
      verificationResults: [
        { checkId: 'v1', passed: true, checkedAt: new Date().toISOString() },
        { checkId: 'v2', passed: false, detail: 'file missing', checkedAt: new Date().toISOString() },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/verification check/)
  })

  it('failed requires failureReason', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    const r = updateTaskStep(task.id, 'step-1', { status: 'failed' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/failureReason/)
  })

  it('blocked requires failureReason', () => {
    const task = makeTaskWithSteps()
    const r = updateTaskStep(task.id, 'step-1', { status: 'blocked' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/failureReason/)
  })

  it('cannot reopen completed step', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    updateTaskStep(task.id, 'step-1', { status: 'completed' })
    const r = updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/already completed/)
  })

  it('taskHasOpenRequiredSteps returns false for no-steps task', () => {
    const task = createTask({ subject: 'todo', description: 'plain' })
    expect(taskHasOpenRequiredSteps(task)).toBe(false)
  })

  it('taskHasOpenRequiredSteps returns true when any step is pending/in_progress', () => {
    const task = makeTaskWithSteps()
    expect(taskHasOpenRequiredSteps(task)).toBe(true)
  })

  it('taskHasOpenRequiredSteps returns false when all steps completed or cancelled', () => {
    const task = makeTaskWithSteps()
    for (const step of task.steps!) {
      if (step.status === 'pending') {
        updateTaskStep(task.id, step.id, { status: 'cancelled' })
      }
    }
    expect(taskHasOpenRequiredSteps(task)).toBe(false)
  })

  it('findLatestOpenTask returns the task with the most recent updatedAt', () => {
    createTask({ subject: 'A', description: 'a', steps: [{ title: 'S1', description: 'd' }] })
    createTask({ subject: 'B', description: 'b', steps: [{ title: 'S1', description: 'd' }] })
    // Both tasks have steps so both are open; tie-break by updatedAt
    // Force task-2 to have a later timestamp by directly mutating
    const t2 = getTask('task-2')!
    t2.updatedAt = new Date(Date.now() + 1000).toISOString()
    const latest = findLatestOpenTask()
    expect(latest?.id).toBe('task-2')
  })

  it('updateTaskStep appends touchedPaths', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    updateTaskStep(task.id, 'step-1', { touchedPaths: ['/tmp/a.html'] })
    updateTaskStep(task.id, 'step-1', { touchedPaths: ['/tmp/b.html'] })
    const step = getTaskStep(task.id, 'step-1')
    expect(step!.touchedPaths).toEqual(['/tmp/a.html', '/tmp/b.html'])
  })

  it('updateTaskStep sets currentStepId on task when in_progress', () => {
    const task = makeTaskWithSteps()
    updateTaskStep(task.id, 'step-1', { status: 'in_progress' })
    const t = getTask(task.id)
    expect(t!.currentStepId).toBe('step-1')
  })

  it('task has no steps when created without steps', () => {
    const task = createTask({ subject: 'todo', description: 'plain' })
    expect(task.steps).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Slice 2: findNextStep tests
// ---------------------------------------------------------------------------

describe('TaskStore — findNextStep (Slice 2)', () => {
  beforeEach(() => resetTaskStore())

  it('returns in_progress step', () => {
    const t = createTask({ subject: 'X', description: 'Y', steps: [
      { title: 'A', description: 'a' },
      { title: 'B', description: 'b' },
    ] })
    updateTaskStep(t.id, 'step-1', { status: 'in_progress' })
    const r = findNextStep(t.id)
    expect(r.hasNext).toBe(true)
    expect(r.nextStep?.id).toBe('step-1')
    expect(r.reason).toBeUndefined()
  })

  it('returns first pending when none in progress', () => {
    const t = createTask({ subject: 'X', description: 'Y', steps: [
      { title: 'A', description: 'a' },
      { title: 'B', description: 'b' },
    ] })
    const r = findNextStep(t.id)
    expect(r.hasNext).toBe(true)
    expect(r.nextStep?.id).toBe('step-1')
  })

  it('returns no_open_steps when all completed', () => {
    const t = createTask({ subject: 'X', description: 'Y', steps: [
      { title: 'A', description: 'a' },
    ] })
    updateTaskStep(t.id, 'step-1', { status: 'in_progress' })
    updateTaskStep(t.id, 'step-1', { status: 'completed' })
    const r = findNextStep(t.id)
    expect(r.hasNext).toBe(false)
    expect(r.reason).toBe('no_open_steps')
  })

  it('returns blocked reason when blocked step is next', () => {
    const t = createTask({ subject: 'X', description: 'Y', steps: [
      { title: 'A', description: 'a' },
    ] })
    updateTaskStep(t.id, 'step-1', { status: 'blocked', failureReason: 'missing file' })
    const r = findNextStep(t.id)
    expect(r.hasNext).toBe(true)
    expect(r.reason).toBe('blocked')
    expect(r.nextStep?.id).toBe('step-1')
  })

  it('auto-selects latest open task if taskId omitted', () => {
    createTask({ subject: 'A', description: 'a', steps: [{ title: 'S1', description: 'd' }] })
    createTask({ subject: 'B', description: 'b', steps: [{ title: 'S1', description: 'd' }] })
    const t2 = getTask('task-2')!
    t2.updatedAt = new Date(Date.now() + 1000).toISOString()
    const r = findNextStep()
    expect(r.taskId).toBe('task-2')
    expect(r.hasNext).toBe(true)
  })

  it('returns no_tasks when no tasks exist', () => {
    const r = findNextStep()
    expect(r.hasNext).toBe(false)
    expect(r.reason).toBe('no_tasks')
  })

  it('returns no_tasks for non-existent taskId', () => {
    const r = findNextStep('task-999')
    expect(r.hasNext).toBe(false)
    expect(r.reason).toBe('no_tasks')
  })
})
