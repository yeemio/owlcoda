import { afterEach, describe, expect, it } from 'vitest'
import {
  createJob,
  finishJob,
  resetJobSupervisor,
  startJob,
} from '../../src/native/job-supervisor.js'
import { buildRuntimeHealthSnapshot } from '../../src/native/runtime-health.js'

describe('runtime health snapshot', () => {
  afterEach(() => resetJobSupervisor())

  it('surfaces recent platform job failure reasons for recovery diagnostics', () => {
    createJob({
      jobId: 'job:agent:timeout-health',
      type: 'agent',
      stage: 'queued',
      tool: 'Agent',
      provider: 'mimo-v2.5-pro',
      recoveryHint: 'AgentRunGet agentId=timeout-health',
      source: { kind: 'agent', id: 'timeout-health' },
    })
    startJob('job:agent:timeout-health', { stage: 'running', externalHandle: 'agent:timeout-health' })
    finishJob('job:agent:timeout-health', 'timeout', {
      stage: 'timeout',
      terminationReason: 'agent:watchdog_timeout',
      error: 'child agent exceeded watchdog',
    })

    createJob({
      jobId: 'job:browser:failed-health',
      type: 'browser',
      stage: 'capture',
      tool: 'BrowserJob',
      provider: 'fetch_html',
      recoveryHint: 'BrowserJob retry with saved URL',
      source: { kind: 'browser', id: 'failed-health' },
    })
    finishJob('job:browser:failed-health', 'failed', {
      stage: 'failed',
      terminationReason: 'selector_missing',
      error: 'selector ".price" not found',
    })

    const snapshot = buildRuntimeHealthSnapshot({ projectRoot: process.cwd() })
    const jobSupervisor = snapshot.subsystems.jobSupervisor

    expect(jobSupervisor).toMatchObject({
      status: 'warn',
      jobCount: 2,
      failed: 1,
      timeout: 1,
      browserJobCount: 1,
    })
    expect(jobSupervisor.recentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId: 'job:agent:timeout-health',
        type: 'agent',
        status: 'timeout',
        terminationReason: 'agent:watchdog_timeout',
        error: 'child agent exceeded watchdog',
        recoveryHint: 'AgentRunGet agentId=timeout-health',
      }),
      expect.objectContaining({
        jobId: 'job:browser:failed-health',
        type: 'browser',
        status: 'failed',
        terminationReason: 'selector_missing',
        error: 'selector ".price" not found',
        recoveryHint: 'BrowserJob retry with saved URL',
      }),
    ]))
  })
})
