import { afterEach, describe, expect, it, vi } from 'vitest'

import { createJudgeBackendProbeTool } from '../../../src/native/tools/judge-backend-probe.js'
import { createJobCancelTool } from '../../../src/native/tools/job.js'
import { getJob, listJobs, resetJobSupervisor } from '../../../src/native/job-supervisor.js'

describe('JudgeBackendProbe tool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetJobSupervisor()
  })

  it('runs fixed judge prompts and returns machine-readable fallback telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"score":1,"reason":"ok"}' } }],
      }), { status: 200 }),
    ))

    const result = await createJudgeBackendProbeTool().execute({
      endpoint: 'http://127.0.0.1:8019/v1/chat/completions',
      models: ['kimi-code'],
      prompts: ['probe-a', 'probe-b', 'probe-c'],
      timeoutMs: 100,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('recommended_model=kimi-code')
    expect(result.output).toContain('json_ok=3/3')
    expect(result.metadata?.['result']).toMatchObject({
      recommendedModel: 'kimi-code',
    })
    expect(result.metadata?.['job']).toMatchObject({
      type: 'api',
      status: 'done',
      tool: 'JudgeBackendProbe',
      provider: 'kimi-code',
      command: 'http://127.0.0.1:8019/v1/chat/completions',
      recoveryHint: expect.stringContaining('JudgeBackendProbe'),
    })
    const jobId = (result.metadata?.['job'] as { jobId: string }).jobId
    expect(getJob(jobId)).toMatchObject({
      jobId,
      type: 'api',
      status: 'done',
    })
    expect(listJobs().filter(job => job.type === 'api')).toHaveLength(1)
  })

  it('cancels a running API probe through a live cancel adapter', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = () => {
          const err = new Error('probe aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ))

    const running = createJudgeBackendProbeTool().execute({
      endpoint: 'http://127.0.0.1:8019/v1/chat/completions',
      models: ['mimo'],
      prompts: ['probe-a'],
      timeoutMs: 5000,
    })
    const jobId = listJobs().find(job => job.type === 'api' && job.status === 'running')?.jobId
    expect(jobId).toBeTruthy()

    const cancelled = await createJobCancelTool().execute({ jobId: jobId! })

    expect(cancelled.isError).toBe(false)
    expect(cancelled.metadata).toMatchObject({
      liveCancelAdapter: true,
    })

    const result = await running
    expect(result.isError).toBe(true)
    expect(result.output).toContain('cancelled')
    expect(result.metadata?.['job']).toMatchObject({
      jobId,
      type: 'api',
      status: 'cancelled',
      terminationReason: 'user_cancel',
      cleanupAttempted: true,
      cleanupSucceeded: true,
    })
  })
})
