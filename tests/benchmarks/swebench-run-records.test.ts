import { describe, expect, it } from 'vitest'
import {
  diagnoseSwebenchRun,
  shouldWriteSwebenchPrediction,
  summarizeSwebenchRecords,
  type SwebenchRunRecord,
} from '../../src/benchmark/swebench-run-records.js'

const baseRecord: SwebenchRunRecord = {
  instance_id: 'django__django-1',
  repo: 'django/django',
  workspace: '/tmp/work',
  exit_code: 0,
  parse_ok: true,
  approval_denials: [],
  patch_bytes: 0,
  patch_path: '/tmp/patch',
  stdout_path: '/tmp/stdout',
  stderr_path: '/tmp/stderr',
  interactive_prompt_detected: false,
  timed_out: false,
  post_patch_timeout: false,
  duration_ms: 1000,
}

describe('SWE-bench run record diagnostics', () => {
  it('classifies Kimi quota exhaustion as provider failure and unscored', () => {
    const diagnostics = diagnoseSwebenchRun({
      runtime_failure: {
        kind: 'http_error',
        message: 'kimi-code request failed',
        diagnostic: {
          status: 403,
          detail: "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
        },
      },
    })

    const record = { ...baseRecord, ...diagnostics }
    expect(diagnostics).toMatchObject({
      runtime_failure_kind: 'http_error',
      runtime_failure_status: 403,
      provider_failure: true,
      provider_quota_exhausted: true,
    })
    expect(shouldWriteSwebenchPrediction(record)).toBe(false)
  })

  it('keeps real task_no_progress empty patches in records but out of predictions', () => {
    const diagnostics = diagnoseSwebenchRun({ stop_reason: 'task_no_progress' })
    const record = { ...baseRecord, ...diagnostics }

    expect(diagnostics.task_no_progress).toBe(true)
    expect(shouldWriteSwebenchPrediction(record)).toBe(false)
  })

  it('keeps non-empty task_no_progress patches scoreable', () => {
    const diagnostics = diagnoseSwebenchRun({ stop_reason: 'task_no_progress' })
    const record = { ...baseRecord, ...diagnostics, patch_bytes: 42 }

    expect(diagnostics.task_no_progress).toBe(true)
    expect(shouldWriteSwebenchPrediction(record)).toBe(true)
  })

  it('summarizes task_no_progress recovery attempts and recovered patches', () => {
    const recovered: SwebenchRunRecord = {
      ...baseRecord,
      instance_id: 'task-no-progress-recovered',
      patch_bytes: 42,
      task_no_progress_recovery_attempted: true,
      task_no_progress_recovered: true,
    }
    const notRecovered: SwebenchRunRecord = {
      ...baseRecord,
      instance_id: 'task-no-progress-not-recovered',
      task_no_progress: true,
      task_no_progress_recovery_attempted: true,
    }

    expect(summarizeSwebenchRecords([recovered, notRecovered], 2, 'test')).toMatchObject({
      completed: 2,
      scoreEligiblePredictions: 1,
      taskNoProgressStops: 1,
      taskNoProgressRecoveryAttempts: 2,
      taskNoProgressRecovered: 1,
    })
  })

  it('classifies port collisions as unscored infrastructure contamination', () => {
    const diagnostics = diagnoseSwebenchRun(undefined, 'Port 19888 is already in use by a non-OwlCoda process')
    const record = { ...baseRecord, ...diagnostics }

    expect(diagnostics.port_collision).toBe(true)
    expect(shouldWriteSwebenchPrediction(record)).toBe(false)
  })

  it('summarizes timeout-empty-stdout separately from provider failures', () => {
    const record: SwebenchRunRecord = {
      ...baseRecord,
      instance_id: 'timeout-empty-stdout',
      exit_code: null,
      parse_ok: false,
      timed_out: true,
      timeout_empty_stdout: true,
      runtime_failure_kind: 'timeout_empty_stdout',
      error: 'timed out; stdout was empty',
    }

    expect(shouldWriteSwebenchPrediction(record)).toBe(false)
    expect(summarizeSwebenchRecords([record], 1, 'test')).toMatchObject({
      completed: 1,
      scoreEligiblePredictions: 0,
      parseFailures: 1,
      emptyPatches: 1,
      providerFailures: 0,
      timeouts: 1,
      timeoutEmptyStdout: 1,
    })
  })

  it('separates post-patch timeouts that preserved a non-empty patch from parse failures', () => {
    const record: SwebenchRunRecord = {
      ...baseRecord,
      instance_id: 'post-patch-timeout-preserved-patch',
      exit_code: null,
      parse_ok: false,
      post_patch_timeout: true,
      post_patch_timeout_preserved_patch: true,
      patch_bytes: 123,
      error: 'post-patch timeout; stdout was empty',
    }

    expect(shouldWriteSwebenchPrediction(record)).toBe(true)
    expect(summarizeSwebenchRecords([record], 1, 'test')).toMatchObject({
      completed: 1,
      scoreEligiblePredictions: 1,
      parseFailures: 0,
      postPatchTimeouts: 1,
      postPatchTimeoutPreservedPatches: 1,
      emptyPatches: 0,
    })
  })

  it('summarizes score-eligible rows separately from completed rows', () => {
    const rows: SwebenchRunRecord[] = [
      { ...baseRecord, instance_id: 'task-no-progress-empty', task_no_progress: true },
      { ...baseRecord, instance_id: 'scoreable-patch', patch_bytes: 42 },
      { ...baseRecord, instance_id: 'quota', provider_failure: true, provider_quota_exhausted: true },
      { ...baseRecord, instance_id: 'port', port_collision: true },
    ]

    expect(summarizeSwebenchRecords(rows, 4, 'test')).toMatchObject({
      completed: 4,
      scoreEligiblePredictions: 1,
      emptyPatches: 3,
      unscoredEmptyPatches: 3,
      providerFailures: 1,
      providerQuotaFailures: 1,
      taskNoProgressStops: 1,
      portCollisions: 1,
    })
  })
})
