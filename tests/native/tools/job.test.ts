import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createJobCancelTool, createJobGetTool, createJobListTool } from '../../../src/native/tools/job.js'
import { createTaskCreateTool } from '../../../src/native/tools/task-create.js'
import { getTask, resetTaskStore } from '../../../src/native/tools/task-store.js'
import { createJob, finishJob, getJob, startJob } from '../../../src/native/job-supervisor.js'

describe('Job platform tools', () => {
  const taskCreate = createTaskCreateTool()
  const jobList = createJobListTool()
  const jobGet = createJobGetTool()
  const jobCancel = createJobCancelTool()

  beforeEach(() => resetTaskStore())
  afterEach(() => resetTaskStore())

  it('lists command-backed task jobs as read-only platform runtime state', async () => {
    const created = await taskCreate.execute({
      subject: 'job list command',
      description: 'platform job list visibility',
      command: 'sleep 0.2; echo listed',
    })
    expect(created.isError).toBe(false)
    const taskId = (created.metadata as any).task.id

    const listed = await jobList.execute({})

    expect(listed.isError).toBe(false)
    expect(listed.output).toContain(`job:task:${taskId}`)
    expect(listed.output).toContain('type=command')
    expect(listed.output).toContain('status=running')
    expect((listed.metadata as any).jobs).toHaveLength(1)
    expect((listed.metadata as any).jobs[0]).toMatchObject({
      jobId: `job:task:${taskId}`,
      type: 'command',
      status: 'running',
      source: { kind: 'task', id: taskId },
    })
  })

  it('filters listed jobs by status and type', async () => {
    await taskCreate.execute({
      subject: 'job filter command',
      description: 'platform job filter visibility',
      command: 'sleep 0.2; echo filtered',
    })

    const listed = await jobList.execute({ status: 'running', type: 'command', limit: 5 })

    expect(listed.isError).toBe(false)
    expect((listed.metadata as any).filters).toEqual({ status: 'running', type: 'command' })
    expect((listed.metadata as any).count).toBe(1)
    expect((listed.metadata as any).jobs[0]).toMatchObject({
      type: 'command',
      status: 'running',
    })
  })

  it('gets one job record by id with recovery and process identity', async () => {
    const created = await taskCreate.execute({
      subject: 'job get command',
      description: 'platform job detail visibility',
      command: 'sleep 0.2; echo detail',
      cwd: process.cwd(),
    })
    expect(created.isError).toBe(false)
    const taskId = (created.metadata as any).task.id

    const got = await jobGet.execute({ jobId: `job:task:${taskId}` })

    expect(got.isError).toBe(false)
    expect(got.output).toContain(`ID: job:task:${taskId}`)
    expect(got.output).toContain('Type: command')
    expect(got.output).toContain('Status: running')
    expect(got.output).toContain(`Recovery: TaskOutput task_id=${taskId} block=false`)
    expect(got.output).toContain('Suggested actions:')
    expect(got.output).toContain(`JobCancel jobId=job:task:${taskId}`)
    expect(got.output).toContain(`TaskOutput task_id=${taskId} block=false`)
    expect((got.metadata as any).job).toMatchObject({
      jobId: `job:task:${taskId}`,
      type: 'command',
      status: 'running',
      cwd: process.cwd(),
      command: 'sleep 0.2; echo detail',
      recoveryHint: `TaskOutput task_id=${taskId} block=false`,
      pid: expect.any(Number),
    })
    expect((got.metadata as any).actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'cancel',
        command: `JobCancel jobId=job:task:${taskId}`,
      }),
      expect.objectContaining({
        kind: 'read_output',
        command: `TaskOutput task_id=${taskId} block=false`,
      }),
    ]))
  })

  it('cancels command-backed task jobs through the task runner cleanup path', async () => {
    const created = await taskCreate.execute({
      subject: 'job cancel command',
      description: 'platform job cancel visibility',
      command: 'sleep 2; echo should-not-complete',
      cwd: process.cwd(),
    })
    expect(created.isError).toBe(false)
    const taskId = (created.metadata as any).task.id

    const cancelled = await jobCancel.execute({ jobId: `job:task:${taskId}` })

    expect(cancelled.isError).toBe(false)
    expect(cancelled.output).toContain(`Cancelled platform job job:task:${taskId}`)
    expect(cancelled.output).toContain('via TaskStop')
    expect(getTask(taskId)?.status).toBe('cancelled')
    const job = getJob(`job:task:${taskId}`)
    expect(job).toMatchObject({
      jobId: `job:task:${taskId}`,
      status: 'cancelled',
      stage: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: true,
    })
  })

  it('marks non-command jobs cancelled without pretending to kill external handles', async () => {
    createJob({
      jobId: 'job:agent:cancel-me',
      type: 'agent',
      stage: 'running',
      tool: 'Agent',
      provider: 'mimo-v2.5-pro',
      recoveryHint: 'AgentRunGet agentId=cancel-me',
      source: { kind: 'agent', id: 'cancel-me' },
    })
    startJob('job:agent:cancel-me', { externalHandle: 'agent:cancel-me', stage: 'running' })

    const cancelled = await jobCancel.execute({ jobId: 'job:agent:cancel-me', reason: 'user_cancel' })

    expect(cancelled.isError).toBe(false)
    expect(cancelled.output).toContain('Cancelled platform job job:agent:cancel-me')
    expect(cancelled.output).toContain('no live cancel adapter')
    expect((cancelled.metadata as any).job).toMatchObject({
      jobId: 'job:agent:cancel-me',
      status: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: false,
      cleanupSucceeded: false,
      remainingPids: [],
    })
  })

  it('does not mutate already terminal jobs through JobCancel', async () => {
    createJob({ jobId: 'job:api:done', type: 'api', stage: 'done' })
    finishJob('job:api:done', 'done', { stage: 'done' })

    const cancelled = await jobCancel.execute({ jobId: 'job:api:done' })

    expect(cancelled.isError).toBe(false)
    expect(cancelled.output).toContain('already terminal')
    expect(getJob('job:api:done')?.status).toBe('done')
  })
})
