import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  finishJob,
  listJobs,
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
})
