import { beforeEach, describe, expect, it } from 'vitest'

import { resetRunLifecycleForTesting, recordRunLifecycleSnapshot } from '../../../src/native/run-lifecycle.js'
import { createRuntimeLifecycleGetTool, createRuntimeLifecycleListTool } from '../../../src/native/tools/run-lifecycle.js'

describe('RuntimeLifecycle inspection tools', () => {
  beforeEach(() => resetRunLifecycleForTesting())

  it('lists and reads unified runtime lifecycle records without mutating them', async () => {
    recordRunLifecycleSnapshot({
      runId: 'task:task-1',
      kind: 'task_command',
      status: 'running',
      objective: 'Build release tarball',
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:01.000Z',
      owner: 'runtime_supervisor',
      inspectCommand: 'TaskOutput task_id=task-1 block=false',
      recoveryPolicy: {
        schema_version: 1,
        strategy: 'runtime_await',
        next_command: 'LongTaskAwait longTaskId=task:task-1 timeoutMs=5000',
        reason: 'Runtime can perform bounded awaits.',
      },
      evidence: {
        last_progress: 'stdout: packing',
      },
    })

    const list = await createRuntimeLifecycleListTool().execute({})
    expect(list.isError).toBe(false)
    expect(list.output).toContain('task:task-1')
    expect(list.output).toContain('kind=task_command')
    expect(list.output).toContain('status=running')
    expect(list.output).toContain('recovery=runtime_await')
    expect(list.metadata?.['runs']).toEqual([
      expect.objectContaining({
        runId: 'task:task-1',
        recoveryPolicy: expect.objectContaining({ strategy: 'runtime_await' }),
      }),
    ])

    const get = await createRuntimeLifecycleGetTool().execute({ runId: 'task:task-1' })
    expect(get.isError).toBe(false)
    expect(get.output).toContain('Runtime run task:task-1')
    expect(get.output).toContain('Inspect: TaskOutput task_id=task-1 block=false')
    expect(get.output).toContain('Recovery: strategy=runtime_await')
    expect(get.metadata?.['run']).toMatchObject({
      runId: 'task:task-1',
      kind: 'task_command',
      status: 'running',
    })
  })
})
