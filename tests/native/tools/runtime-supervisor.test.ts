import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getRunLifecycleSnapshot,
  resetRunLifecycleForTesting,
} from '../../../src/native/run-lifecycle.js'
import {
  getRuntimeSupervisorProcess,
  resetRuntimeSupervisorForTesting,
} from '../../../src/native/runtime-supervisor.js'
import {
  createRuntimeSupervisorGetTool,
  createRuntimeSupervisorListTool,
} from '../../../src/native/tools/runtime-supervisor.js'
import {
  createTask,
  resetTaskStore,
  restoreTaskStore,
  spawnTaskCommand,
  type TaskStoreSnapshot,
} from '../../../src/native/tools/task-store.js'

describe('RuntimeSupervisor process snapshots', () => {
  beforeEach(() => {
    resetTaskStore()
    resetRunLifecycleForTesting()
    resetRuntimeSupervisorForTesting()
  })

  afterEach(() => {
    resetTaskStore()
    resetRunLifecycleForTesting()
    resetRuntimeSupervisorForTesting()
  })

  it('mirrors command-backed tasks into process and run lifecycle snapshots', async () => {
    const task = createTask({
      subject: 'Supervisor live command',
      description: 'Keep a process visible for runtime supervisor inspection.',
      conversationId: 'conv-supervisor',
      command: 'sleep 1; echo supervisor-done',
      cwd: '/tmp',
    })
    spawnTaskCommand(task.id)

    const processId = `process:${task.id}`
    expect(getRuntimeSupervisorProcess(processId)).toMatchObject({
      processId,
      runId: `task:${task.id}`,
      status: 'running',
      command: 'sleep 1; echo supervisor-done',
    })
    expect(getRunLifecycleSnapshot(processId)).toMatchObject({
      runId: processId,
      kind: 'supervisor_process',
      status: 'running',
      parentRunId: `task:${task.id}`,
      owner: 'runtime_supervisor',
      recoveryPolicy: expect.objectContaining({
        strategy: 'runtime_await',
      }),
    })

    const list = await createRuntimeSupervisorListTool().execute({}, { conversationId: 'conv-supervisor' })
    expect(list.isError).toBe(false)
    expect(list.output).toContain(processId)
    expect(list.output).toContain(`run=task:${task.id}`)
    expect(list.output).toContain('status=running')

    const get = await createRuntimeSupervisorGetTool().execute({ processId }, { conversationId: 'conv-supervisor' })
    expect(get.isError).toBe(false)
    expect(get.output).toContain(`Runtime supervisor process ${processId}`)
    expect(get.output).toContain('Inspect: TaskOutput task_id=task-1 block=false')
    expect(get.metadata?.['process']).toMatchObject({
      processId,
      processIdentity: expect.objectContaining({ command: 'sleep 1; echo supervisor-done' }),
    })
  })

  it('restores missing handles as incomplete process snapshots instead of waitable live work', async () => {
    const snapshot: TaskStoreSnapshot = {
      schemaVersion: 1,
      nextId: 2,
      tasks: [{
        id: 'task-1',
        subject: 'Restored command',
        description: 'Was running before process restart.',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:01.000Z',
        command: 'sleep 60',
        cwd: '/tmp',
        conversationId: 'conv-supervisor',
      }],
    }

    restoreTaskStore(snapshot)

    expect(getRuntimeSupervisorProcess('process:task-1')).toMatchObject({
      processId: 'process:task-1',
      runId: 'task:task-1',
      status: 'incomplete',
      recoveryPolicy: expect.objectContaining({
        strategy: 'inspect_process_before_replace',
      }),
      evidence: expect.objectContaining({
        timeout_kind: 'process_handle_missing_after_resume',
      }),
    })
    expect(getRunLifecycleSnapshot('process:task-1')).toMatchObject({
      kind: 'supervisor_process',
      status: 'incomplete',
      recoveryPolicy: expect.objectContaining({
        strategy: 'inspect_process_before_replace',
      }),
    })
  })
})
