import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  finishJob,
  getJob,
  getJobStateDescriptor,
  isTerminalJobStatus,
  listJobs,
  markJobDetached,
  reconcileJobsAfterRuntimeRestart,
  resetJobSupervisor,
  startJob,
} from '../../src/native/job-supervisor.js'

describe('job supervisor durable store', () => {
  let tempDir = ''
  let previousStorePath: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-job-supervisor-'))
    previousStorePath = process.env['OWLCODA_JOB_STORE_PATH']
    process.env['OWLCODA_JOB_STORE_PATH'] = join(tempDir, 'jobs.json')
    resetJobSupervisor({ clearPersisted: true })
  })

  afterEach(async () => {
    resetJobSupervisor({ clearPersisted: true })
    if (previousStorePath === undefined) delete process.env['OWLCODA_JOB_STORE_PATH']
    else process.env['OWLCODA_JOB_STORE_PATH'] = previousStorePath
    await rm(tempDir, { recursive: true, force: true })
  })

  it('persists job state to disk and reloads it after in-memory reset', async () => {
    createJob({
      jobId: 'job:api:durable',
      type: 'api',
      stage: 'queued',
      tool: 'JudgeBackendProbe',
      provider: 'mimo',
      recoveryHint: 'JudgeBackendProbe endpoint=http://127.0.0.1:8019/v1/chat/completions models=mimo',
    })
    startJob('job:api:durable', { stage: 'probing', externalHandle: 'http://127.0.0.1:8019/v1/chat/completions' })
    finishJob('job:api:durable', 'failed', {
      stage: 'failed',
      terminationReason: 'judge_backend_fetch_error',
    })

    const raw = JSON.parse(await readFile(process.env['OWLCODA_JOB_STORE_PATH']!, 'utf-8'))
    expect(raw.jobs).toEqual([expect.objectContaining({
      jobId: 'job:api:durable',
      status: 'failed',
      terminationReason: 'judge_backend_fetch_error',
    })])

    resetJobSupervisor()

    expect(listJobs()).toEqual([expect.objectContaining({
      jobId: 'job:api:durable',
      status: 'failed',
      recoveryHint: expect.stringContaining('JudgeBackendProbe'),
    })])
  })

  it('defines durable execution descriptors for every P0-B status', () => {
    const statuses = [
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'cancelled',
      'detached',
      'recovering',
      'unrecoverable',
      'orphaned',
    ] as const

    for (const status of statuses) {
      expect(getJobStateDescriptor(status)).toMatchObject({
        status,
        userMessage: expect.any(String),
        terminal: expect.any(Boolean),
        canCancel: expect.any(Boolean),
        canResume: expect.any(Boolean),
        requiresProof: expect.any(Boolean),
      })
    }
    expect(isTerminalJobStatus('completed')).toBe(true)
    expect(isTerminalJobStatus('detached')).toBe(false)
    expect(isTerminalJobStatus('recovering')).toBe(false)
    expect(isTerminalJobStatus('orphaned')).toBe(true)
  })

  it('marks a normal completed job as terminal with proof required', () => {
    createJob({
      jobId: 'job:command:completed',
      type: 'command',
      stage: 'queued',
    })
    startJob('job:command:completed', { stage: 'running' })

    const completed = finishJob('job:command:completed', 'completed', {
      stage: 'completed',
      terminationReason: 'exit_0',
    })

    expect(completed).toMatchObject({
      jobId: 'job:command:completed',
      status: 'completed',
      recoveryClass: 'terminal',
      recoveryReason: 'exit_0',
      proofRequired: true,
      terminationReason: 'exit_0',
    })
    expect(isTerminalJobStatus(completed!.status)).toBe(true)
  })

  it('marks a disconnected live process as detached rather than pretending it is still owned', () => {
    createJob({
      jobId: 'job:command:detached',
      type: 'command',
      stage: 'queued',
      recoveryHint: 'TaskOutput task_id=detached block=false',
    })
    startJob('job:command:detached', { stage: 'running', pid: 12345 })

    const detached = markJobDetached('job:command:detached', {
      reason: 'client disconnected while process was still alive',
      updatedAt: '2026-06-26T00:00:00.000Z',
      resumeCommand: 'TaskOutput task_id=detached block=false',
    })

    expect(detached).toMatchObject({
      status: 'detached',
      stage: 'detached',
      recoveryClass: 'detached_process',
      recoveryReason: 'client disconnected while process was still alive',
      recoveryUpdatedAt: '2026-06-26T00:00:00.000Z',
      resumeCommand: 'TaskOutput task_id=detached block=false',
      proofRequired: true,
    })
    expect(isTerminalJobStatus(detached!.status)).toBe(false)
  })

  it('reconciles restart with an external handle into recovering', () => {
    createJob({
      jobId: 'job:api:recovering',
      type: 'api',
      stage: 'queued',
      recoveryHint: 'JudgeBackendProbe model=mimo',
    })
    startJob('job:api:recovering', {
      stage: 'probing',
      externalHandle: 'http://127.0.0.1:8019/v1/chat/completions',
    })

    const results = reconcileJobsAfterRuntimeRestart({
      now: '2026-06-26T00:00:01.000Z',
    })

    expect(results).toEqual([expect.objectContaining({
      jobId: 'job:api:recovering',
      previousStatus: 'running',
      status: 'recovering',
      recoveryClass: 'external_reconnect_required',
      action: 'recovering',
    })])
    expect(getJob('job:api:recovering')).toMatchObject({
      status: 'recovering',
      recoveryClass: 'external_reconnect_required',
      recoveryUpdatedAt: '2026-06-26T00:00:01.000Z',
      resumeCommand: 'JudgeBackendProbe model=mimo',
      proofRequired: false,
    })
  })

  it('reconciles restart with a dead pid into unrecoverable', () => {
    createJob({
      jobId: 'job:command:dead-pid',
      type: 'command',
      stage: 'queued',
    })
    startJob('job:command:dead-pid', { stage: 'running', pid: 424242 })

    const results = reconcileJobsAfterRuntimeRestart({
      now: '2026-06-26T00:00:02.000Z',
      isProcessAlive: () => false,
    })

    expect(results).toEqual([expect.objectContaining({
      jobId: 'job:command:dead-pid',
      previousStatus: 'running',
      status: 'unrecoverable',
      recoveryClass: 'unrecoverable',
      action: 'unrecoverable',
    })])
    expect(getJob('job:command:dead-pid')).toMatchObject({
      status: 'unrecoverable',
      stage: 'unrecoverable',
      recoveryClass: 'unrecoverable',
      endedAt: '2026-06-26T00:00:02.000Z',
      proofRequired: true,
    })
  })

  it('reconciles active jobs with no handles or source records into orphaned', () => {
    createJob({
      jobId: 'job:command:orphaned',
      type: 'command',
      stage: 'queued',
    })
    startJob('job:command:orphaned', { stage: 'running' })

    const results = reconcileJobsAfterRuntimeRestart({
      now: '2026-06-26T00:00:03.000Z',
    })

    expect(results).toEqual([expect.objectContaining({
      jobId: 'job:command:orphaned',
      previousStatus: 'running',
      status: 'orphaned',
      recoveryClass: 'orphaned',
      action: 'orphaned',
    })])
    expect(getJob('job:command:orphaned')).toMatchObject({
      status: 'orphaned',
      stage: 'orphaned',
      recoveryClass: 'orphaned',
      endedAt: '2026-06-26T00:00:03.000Z',
      proofRequired: true,
    })
  })
})
