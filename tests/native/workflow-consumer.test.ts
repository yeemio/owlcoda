import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildWorkflowConsumerManifest,
  listWorkflowRuns,
} from '../../src/native/workflow-consumer.js'

describe('workflow consumer manifest', () => {
  it('builds a manifest with receipt, plan, artifact refs, structured-output refs, and final-report blockers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-workflow-consumer-'))
    try {
      const workflowRoot = join(dir, '.owlcoda-workflows')
      const runDir = join(workflowRoot, 'run-failed')
      const artifactDir = join(runDir, 'run-failed-artifacts')
      await mkdir(artifactDir, { recursive: true })

      const receiptPath = join(runDir, 'receipt.json')
      const planPath = join(runDir, 'plan.json')
      const rawPath = join(artifactDir, 'large.response.json')
      const missingRawPath = join(artifactDir, 'missing.response.json')
      const structuredPath = join(artifactDir, 'structured-output-failed.json')

      await writeFile(planPath, JSON.stringify({
        run_id: 'run-failed',
        plan_version: 'slice-a.test',
        steps: [{ id: 'large', method: 'GET', url: 'https://example.test/large' }],
      }, null, 2), 'utf8')
      await writeFile(rawPath, JSON.stringify({ ok: true, rows: [1, 2, 3] }), 'utf8')
      await writeFile(structuredPath, JSON.stringify({
        version: 1,
        artifactKind: 'structured_output_artifact',
        role: 'judge',
        model: 'mimo',
        preset: 'canonical-judge.v1',
        ok: false,
        artifact: {
          artifact: 'failed_fallback.v1',
          ok: false,
          failureReason: 'parse_failed',
        },
        parsed: false,
        schemaValid: false,
        fallbackUsed: true,
        validationErrors: ['parse_failed'],
      }, null, 2), 'utf8')
      await writeFile(receiptPath, JSON.stringify({
        schema_version: 1,
        kind: 'workflow_invocation_receipt',
        run_id: 'run-failed',
        started_at: '2026-07-02T01:00:00.000Z',
        finished_at: '2026-07-02T01:01:00.000Z',
        plan_version: 'slice-a.test',
        plan_digest: 'digest-from-runner',
        plan_path: planPath,
        receipt_path: receiptPath,
        artifact_dir: artifactDir,
        required_steps_total: 3,
        required_steps_completed: 1,
        failed_steps: [{ step_id: 'required_failed', required: true, reason: 'status 500' }],
        skipped_steps: [{ step_id: 'missing_reason' }],
        endpoint_calls: [{
          step_id: 'large',
          required: true,
          method: 'GET',
          url: 'https://example.test/large',
          started_at: '2026-07-02T01:00:00.000Z',
          finished_at: '2026-07-02T01:00:01.000Z',
          latency_ms: 1000,
          attempts: 1,
          ok: true,
          status_code: 200,
          response_size_bytes: 100000,
          max_response_bytes: 100,
          response_truncated: true,
          response_artifact: rawPath,
          raw_ref: rawPath,
          artifact_ref: rawPath,
        }, {
          step_id: 'missing_raw',
          required: true,
          method: 'GET',
          url: 'https://example.test/missing',
          started_at: '2026-07-02T01:00:02.000Z',
          finished_at: '2026-07-02T01:00:03.000Z',
          latency_ms: 1000,
          attempts: 1,
          ok: true,
          status_code: 200,
          response_size_bytes: 100000,
          max_response_bytes: 100,
          response_truncated: true,
          response_artifact: missingRawPath,
          raw_ref: missingRawPath,
          artifact_ref: missingRawPath,
        }, {
          step_id: 'structured-output',
          required: true,
          method: 'POST',
          url: 'https://example.test/v1/structured-output',
          started_at: '2026-07-02T01:00:04.000Z',
          finished_at: '2026-07-02T01:00:05.000Z',
          latency_ms: 1000,
          attempts: 1,
          ok: true,
          status_code: 200,
          response_size_bytes: 500,
          max_response_bytes: 20000,
          response_truncated: false,
          projected_response: {
            ok: false,
            artifactId: 'structured-output-failed',
            fallbackUsed: true,
            schemaValid: false,
          },
        }],
        acceptance: 'fail',
        required_endpoint_calls: '1/3',
      }), 'utf8')

      const manifest = await buildWorkflowConsumerManifest({ cwd: dir, runId: 'run-failed' })

      expect(manifest).toMatchObject({
        schemaVersion: 1,
        kind: 'workflow_consumer_manifest',
        runId: 'run-failed',
        workflowRoot,
        plan: {
          path: planPath,
          exists: true,
          version: 'slice-a.test',
        },
        receipt: {
          path: receiptPath,
          exists: true,
          acceptance: 'fail',
        },
        acceptance: {
          status: 'fail',
        },
        normalizedState: 'failed',
        requiredCounts: {
          total: 3,
          completed: 1,
          failed: 1,
          skipped: 1,
        },
        stepSummary: {
          failed: [{ stepId: 'required_failed', required: true, reason: 'status 500' }],
          skipped: [{ stepId: 'missing_reason' }],
        },
        resume: {
          possible: true,
          command: expect.stringContaining('owlcoda workflow resume --run-id run-failed'),
        },
        finalReportEligibility: {
          allowed: false,
        },
      })
      expect(manifest.plan.digest).toMatch(/^sha256:/)
      expect(manifest.receipt.digest).toMatch(/^sha256:/)
      expect(manifest.endpointCalls).toHaveLength(3)
      expect(manifest.rawRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ stepId: 'large', path: rawPath, exists: true }),
        expect.objectContaining({ stepId: 'missing_raw', path: missingRawPath, exists: false }),
      ]))
      expect(manifest.artifactRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ stepId: 'large', path: rawPath, exists: true }),
      ]))
      expect(manifest.structuredOutputArtifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifactId: 'structured-output-failed',
          role: 'judge',
          status: 'failed',
          fallbackUsed: true,
          schemaValid: false,
          path: structuredPath,
        }),
      ]))
      expect(manifest.finalReportEligibility.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt_acceptance_failed' }),
        expect.objectContaining({ code: 'required_step_failed', stepId: 'required_failed' }),
        expect.objectContaining({ code: 'skipped_step_missing_reason', stepId: 'missing_reason' }),
        expect.objectContaining({ code: 'missing_required_artifact', stepId: 'missing_raw' }),
        expect.objectContaining({ code: 'failed_fallback_structured_output', artifactId: 'structured-output-failed' }),
      ]))
      expect(manifest.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'skipped_step_missing_reason', stepId: 'missing_reason' }),
      ]))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists workflow runs by updated time and keeps malformed receipts inspectable as unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-workflow-list-'))
    try {
      const workflowRoot = join(dir, '.owlcoda-workflows')
      const oldRun = join(workflowRoot, 'old-run')
      const badRun = join(workflowRoot, 'bad-run')
      await mkdir(oldRun, { recursive: true })
      await mkdir(badRun, { recursive: true })
      await writeFile(join(oldRun, 'plan.json'), JSON.stringify({ run_id: 'old-run', steps: [] }), 'utf8')
      await writeFile(join(oldRun, 'receipt.json'), JSON.stringify({
        schema_version: 1,
        kind: 'workflow_invocation_receipt',
        run_id: 'old-run',
        started_at: '2026-07-02T00:00:00.000Z',
        finished_at: '2026-07-02T00:00:01.000Z',
        plan_digest: 'old',
        receipt_path: join(oldRun, 'receipt.json'),
        artifact_dir: join(oldRun, 'old-run-artifacts'),
        required_steps_total: 1,
        required_steps_completed: 1,
        failed_steps: [],
        skipped_steps: [],
        endpoint_calls: [],
        acceptance: 'pass',
        required_endpoint_calls: '1/1',
      }), 'utf8')
      await writeFile(join(badRun, 'receipt.json'), '{not json', 'utf8')

      const runs = await listWorkflowRuns({ cwd: dir })

      expect(runs.runs.map(run => run.runId)).toEqual(['bad-run', 'old-run'])
      expect(runs.runs[0]).toMatchObject({
        runId: 'bad-run',
        normalizedState: 'unknown',
        acceptance: { status: 'unknown' },
      })
      expect(runs.runs[0].diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'receipt_parse_failed' }),
      ]))
      expect(runs.runs[1]).toMatchObject({
        runId: 'old-run',
        normalizedState: 'completed',
        finalReportEligibility: { allowed: true },
      })
      expect(existsSync(runs.runs[1].receipt.path!)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
