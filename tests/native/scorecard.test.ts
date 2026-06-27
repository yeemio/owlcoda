import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConversation } from '../../src/native/conversation.js'
import { createJob, finishJob, resetJobSupervisor } from '../../src/native/job-supervisor.js'
import { appendRuntimeEvent } from '../../src/native/runtime-events.js'
import { collectRuntimeFactsForRun } from '../../src/native/runtime-facts.js'
import { createRunWorkspace, readArtifactLedger, recordArtifact } from '../../src/native/run-workspace.js'
import {
  buildRunScorecard,
  buildRunTrajectory,
  scorecardToJson,
  summarizeRunScorecard,
  trajectoryToJsonl,
  writeTrajectoryJsonl,
} from '../../src/native/scorecard.js'

describe('scorecard and RL-ready trajectory v0', () => {
  afterEach(() => {
    resetJobSupervisor()
  })

  it('builds an evidence-grounded scorecard from runtime truth facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-scorecard-'))
    try {
      const runId = 'run-scorecard-good'
      const turnId = 'turn-scorecard-good'
      const taskId = 'task-scorecard-good'
      const jobId = 'job-scorecard-good'
      const proofId = 'proof-scorecard-good'
      const conversation = createConversation({ model: 'scorecard-model' })

      appendRuntimeEvent(conversation, {
        kind: 'turn_started',
        at: '2026-06-26T02:00:00.000Z',
        turnId,
        runId,
      })
      appendRuntimeEvent(conversation, {
        kind: 'item_completed',
        at: '2026-06-26T02:00:01.000Z',
        turnId,
        runId,
        itemId: 'verify-1',
        factRefs: { taskId, jobId, proofId },
        payload: {
          tool_name: 'TaskVerify',
          is_error: false,
          task_id: taskId,
          job_id: jobId,
          proof_id: proofId,
        },
      })
      appendRuntimeEvent(conversation, {
        kind: 'turn_completed',
        at: '2026-06-26T02:00:05.000Z',
        turnId,
        runId,
        payload: {
          ...turnCompletedPayload(),
          input_tokens: 1200,
          output_tokens: 320,
        },
      })

      const outputRoot = join(dir, 'out')
      await createRunWorkspace({ outputRoot, cwd: dir, runId })
      const artifactPath = join(outputRoot, 'report.md')
      await writeFile(artifactPath, 'verified report\n', 'utf8')
      await recordArtifact(outputRoot, {
        id: 'artifact-scorecard-report',
        path: artifactPath,
        origin: 'manual',
        threadId: conversation.id,
        turnId,
        taskId,
        jobId,
        proofId,
      })
      const artifactLedger = await readArtifactLedger(outputRoot)
      createJob({
        jobId,
        type: 'command',
        stage: 'verify',
        threadId: conversation.id,
        turnId,
        runId,
        taskId,
      })
      const job = finishJob(jobId, 'completed')!

      const facts = collectRuntimeFactsForRun({
        runId,
        runtimeEventLog: conversation.options?.runtimeEventLog,
        jobs: [job],
        artifacts: artifactLedger.artifacts,
      })
      const scorecard = buildRunScorecard({
        facts,
        finalText: `完成，TaskVerify passed，证据 ${proofId} 和 artifact-scorecard-report 已记录。`,
        generatedAt: '2026-06-26T02:00:06.000Z',
      })

      expect(scorecard).toMatchObject({
        scorecardVersion: 1,
        runId,
        verdict: 'pass',
        antiCheat: { verdict: 'pass' },
      })
      expect(scorecard.overallScore).toBeGreaterThanOrEqual(80)
      expect(scorecard.dimensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'task_completion', verdict: 'pass' }),
        expect.objectContaining({ id: 'verification', verdict: 'pass' }),
        expect.objectContaining({ id: 'evidence_grounding', verdict: 'pass' }),
        expect.objectContaining({ id: 'file_discipline', verdict: 'pass' }),
      ]))
      expect(scorecardToJson(scorecard)).toContain('"scorecardVersion": 1')
      expect(summarizeRunScorecard(scorecard)).toContain('anti_cheat=pass')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails anti-cheat when final text claims tests passed without verification evidence', () => {
    const runId = 'run-scorecard-cheat'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'turn_completed',
      at: '2026-06-26T03:00:00.000Z',
      turnId: 'turn-scorecard-cheat',
      runId,
      payload: turnCompletedPayload(),
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: '全部完成，tests passed，验证证据已齐全。',
    })

    expect(scorecard.antiCheat.verdict).toBe('fail')
    expect(scorecard.antiCheat.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unverified_pass_claim',
        status: 'fail',
      }),
      expect.objectContaining({
        id: 'fake_evidence_report',
        status: 'fail',
      }),
    ]))
    expect(scorecard.overallScore).toBeLessThan(80)
  })

  it('treats failed ArtifactVerify metadata as failed verification evidence', () => {
    const runId = 'run-scorecard-artifact-failed'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T06:00:00.000Z',
      turnId: 'turn-scorecard-artifact-failed',
      runId,
      itemId: 'artifact-verify-1',
      payload: {
        tool_name: 'ArtifactVerify',
        is_error: false,
        metadata: {
          result: {
            passed: false,
            failures: [
              { id: 'section_count', detail: 'expected 5 sections, found 3' },
            ],
          },
        },
      },
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: 'ArtifactVerify proof runtime_event-1',
    })

    expect(scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'verification',
        verdict: 'fail',
        evidenceRefs: ['runtime_event-1'],
      }),
    ]))
    expect(scorecard.overallScore).toBeLessThan(80)
  })

  it('treats failed TaskVerify metadata as failed verification evidence', () => {
    const runId = 'run-scorecard-taskverify-failed'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T06:05:00.000Z',
      turnId: 'turn-scorecard-taskverify-failed',
      runId,
      itemId: 'task-verify-1',
      payload: {
        tool_name: 'TaskVerify',
        is_error: false,
        metadata: {
          taskId: 'task-scorecard',
          stepId: 'step-scorecard',
          passed: false,
          results: [
            {
              checkId: 'v1',
              passed: false,
              detail: 'not found: /tmp/missing.md',
            },
          ],
        },
      },
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: 'TaskVerify evidence runtime_event-1',
    })

    expect(scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'verification',
        verdict: 'fail',
        evidenceRefs: ['runtime_event-1'],
      }),
    ]))
    expect(scorecard.overallScore).toBeLessThan(80)
  })

  it('treats unsupported DeliveryAudit claims as warning verification evidence', () => {
    const runId = 'run-scorecard-delivery-warn'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T06:10:00.000Z',
      turnId: 'turn-scorecard-delivery-warn',
      runId,
      itemId: 'delivery-audit-1',
      payload: {
        tool_name: 'DeliveryAudit',
        is_error: false,
        metadata: {
          unsupportedCount: 1,
          claimVerdicts: [
            {
              claim: 'tests pass',
              verdict: 'unsupported',
              evidence: 'tests-pass claims are unverifiable from disk',
            },
          ],
          vacuousAssertions: [],
        },
      },
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: 'DeliveryAudit evidence runtime_event-1',
    })

    expect(scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'verification',
        verdict: 'warn',
        evidenceRefs: ['runtime_event-1'],
      }),
    ]))
  })

  it('uses clean DeliveryAudit touched-file buckets as file discipline evidence', () => {
    const runId = 'run-scorecard-delivery-clean-files'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T06:20:00.000Z',
      turnId: 'turn-scorecard-delivery-clean-files',
      runId,
      itemId: 'delivery-audit-clean-files',
      payload: {
        tool_name: 'DeliveryAudit',
        is_error: false,
        metadata: {
          buckets: {
            touchedThisTurn: ['src/expected.ts'],
            trackedModifiedDeliverables: ['src/expected.ts'],
            newUntrackedDeliverables: [],
            unrelatedResidue: [],
            buildArtifacts: [],
          },
          unsupportedCount: 0,
          vacuousAssertions: [],
        },
      },
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: 'Updated src/expected.ts. Evidence runtime_event-1.',
    })

    expect(scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'file_discipline',
        verdict: 'pass',
        evidenceRefs: ['runtime_event-1'],
      }),
    ]))
    expect(scorecard.antiCheat.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'missing_artifact_evidence',
        status: 'pass',
        evidenceRefs: ['runtime_event-1'],
      }),
    ]))
  })

  it('warns file discipline when DeliveryAudit reports unrelated residue', () => {
    const runId = 'run-scorecard-delivery-residue'
    const conversation = createConversation({ model: 'scorecard-model' })
    appendRuntimeEvent(conversation, {
      kind: 'item_completed',
      at: '2026-06-26T06:30:00.000Z',
      turnId: 'turn-scorecard-delivery-residue',
      runId,
      itemId: 'delivery-audit-residue',
      payload: {
        tool_name: 'DeliveryAudit',
        is_error: false,
        metadata: {
          buckets: {
            touchedThisTurn: ['src/expected.ts'],
            trackedModifiedDeliverables: ['src/expected.ts'],
            newUntrackedDeliverables: [],
            unrelatedResidue: ['tmp/old-output.json'],
            buildArtifacts: [],
          },
          unsupportedCount: 0,
          vacuousAssertions: [],
        },
      },
    })
    const facts = collectRuntimeFactsForRun({
      runId,
      runtimeEventLog: conversation.options?.runtimeEventLog,
    })

    const scorecard = buildRunScorecard({
      facts,
      finalText: 'Updated src/expected.ts. Evidence runtime_event-1.',
    })

    expect(scorecard.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'file_discipline',
        verdict: 'warn',
        evidenceRefs: ['runtime_event-1'],
        notes: ['DeliveryAudit reported unrelated residue=1'],
      }),
    ]))
  })

  it('exports redacted RL-ready trajectory JSONL locally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-trajectory-'))
    try {
      const runId = 'run-trajectory'
      const conversation = createConversation({ model: 'scorecard-model' })
      appendRuntimeEvent(conversation, {
        kind: 'item_completed',
        at: '2026-06-26T04:00:00.000Z',
        turnId: 'turn-trajectory',
        runId,
        itemId: 'image-tool',
        payload: {
          tool_name: 'ArtifactVerify',
          is_error: false,
          data: 'x'.repeat(9000),
        },
      })
      const facts = collectRuntimeFactsForRun({
        runId,
        runtimeEventLog: conversation.options?.runtimeEventLog,
      })
      const scorecard = buildRunScorecard({
        facts,
        finalText: 'ArtifactVerify proof runtime_event-1',
      })

      const trajectory = buildRunTrajectory(facts, scorecard)
      expect(trajectory).toHaveLength(1)
      expect(trajectory[0]).toMatchObject({
        trajectory_version: 1,
        run_id: runId,
        action: {
          type: 'tool',
          tool_name: 'ArtifactVerify',
        },
        redaction: {
          mode: 'local_redacted_v0',
          fields: ['payload.data'],
        },
      })
      expect(trajectory[0].observation.payload).toMatchObject({
        data: '[redacted:9000 chars]',
      })

      const jsonl = trajectoryToJsonl(trajectory)
      expect(jsonl.split('\n')).toHaveLength(1)
      const outPath = join(dir, 'trajectory.jsonl')
      await writeTrajectoryJsonl(outPath, trajectory)
      expect(await readFile(outPath, 'utf8')).toBe(`${jsonl}\n`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('adds structured output artifacts to scorecard and trajectory with repair/salvage penalties', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-scorecard-'))
    try {
      const runId = 'run-structured-output-scorecard'
      const turnId = 'turn-structured-output-scorecard'
      const threadId = 'thread-structured-output-scorecard'
      const outputRoot = join(dir, 'out')
      await createRunWorkspace({ outputRoot, cwd: dir, runId })

      const artifactId = 'structured-output-scorecard-artifact'
      const attemptLedgerId = `${artifactId}-attempts`
      const artifactPath = join(outputRoot, `${artifactId}.json`)
      const attemptsPath = join(outputRoot, `${attemptLedgerId}.json`)
      await writeFile(artifactPath, JSON.stringify({
        version: 1,
        artifactKind: 'structured_output_artifact',
        role: 'evidence',
        model: 'capability-routed-model',
        preset: 'evidence-digest.v1',
        requestFingerprint: 'sha256:request',
        schemaHash: 'sha256:schema',
        policyHash: 'sha256:policy',
        ok: true,
        artifact: {
          role: 'evidence',
          artifact: 'evidence_digest.v1',
          summary: 'usable evidence digest',
        },
        rawText: '{"summary":"usable evidence digest"',
        parsed: true,
        schemaValid: true,
        validationErrors: [],
        repairCount: 1,
        salvageUsed: true,
        fallbackUsed: false,
        stopReason: 'max_tokens',
        inputTokens: 120,
        outputTokens: 48,
        durationMs: 900,
        capabilityGate: {
          ok: true,
          source: 'declared',
          maxOutputTokens: { requested: 2048, applied: 1024 },
        },
      }), 'utf8')
      await writeFile(attemptsPath, JSON.stringify({
        version: 1,
        artifactKind: 'structured_output_attempts',
        artifactId,
        attemptLedgerId,
        attempts: [
          {
            label: 'primary',
            model: 'capability-routed-model',
            outputTokens: 48,
            stopReason: 'max_tokens',
            parsed: false,
            schemaValid: false,
            error: 'unterminated JSON object',
          },
          {
            label: 'repair',
            model: 'capability-routed-model',
            outputTokens: 0,
            stopReason: 'repaired',
            parsed: true,
            schemaValid: true,
          },
        ],
      }), 'utf8')
      await recordArtifact(outputRoot, {
        id: artifactId,
        path: artifactPath,
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        threadId,
        turnId,
        runId,
        stepId: 'evidence',
        participatesInFinal: true,
      })
      await recordArtifact(outputRoot, {
        id: attemptLedgerId,
        path: attemptsPath,
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        threadId,
        turnId,
        runId,
        stepId: 'evidence',
        participatesInFinal: false,
      })
      const artifactLedger = await readArtifactLedger(outputRoot)
      const facts = collectRuntimeFactsForRun({
        runId,
        artifacts: artifactLedger.artifacts,
      })

      const scorecard = buildRunScorecard({
        facts,
        finalText: `Structured output artifact ${artifactId} recorded.`,
      })

      const dimension = scorecard.dimensions.find(item => item.id === 'model_output_artifact')
      expect(dimension).toMatchObject({
        verdict: 'warn',
        evidenceRefs: expect.arrayContaining([artifactId, attemptLedgerId]),
      })
      expect(dimension?.score).toBeLessThan(1)
      expect(dimension?.score).toBeGreaterThan(0.6)
      expect(dimension?.notes.join('\n')).toContain('repair penalty')
      expect(dimension?.notes.join('\n')).toContain('salvage penalty')

      const trajectory = buildRunTrajectory(facts, scorecard)
      const structuredRecord = trajectory.find(record => record.action.type === 'structured_output_model_call')
      expect(structuredRecord).toMatchObject({
        trajectory_version: 1,
        run_id: runId,
        action: {
          type: 'structured_output_model_call',
          model: 'capability-routed-model',
          preset: 'evidence-digest.v1',
          artifact_id: artifactId,
          attempt_ledger_id: attemptLedgerId,
        },
        reward: {
          structured_output: expect.objectContaining({
            schema_valid: true,
            repair_penalty: expect.any(Number),
            salvage_penalty: expect.any(Number),
            fallback_penalty: 0,
            policy_penalty: 0,
            verdict: 'warn',
          }),
        },
        next_state: {
          artifact_id: artifactId,
          attempt_ledger_id: attemptLedgerId,
          ok: true,
          schema_valid: true,
          fallback_used: false,
        },
        redaction: {
          mode: 'local_redacted_v0',
          fields: expect.arrayContaining(['rawText']),
        },
      })
      expect((structuredRecord?.reward as any).structured_output.repair_penalty).toBeGreaterThan(0)
      expect((structuredRecord?.reward as any).structured_output.salvage_penalty).toBeGreaterThan(0)
      expect(structuredRecord?.observation.rawText).toBe('[redacted:35 chars]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('penalizes structured output failed fallback and policy violations even when JSON is parseable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-fallback-'))
    try {
      const runId = 'run-structured-output-fallback'
      const outputRoot = join(dir, 'out')
      await createRunWorkspace({ outputRoot, cwd: dir, runId })

      const artifactId = 'structured-output-fallback-artifact'
      const attemptLedgerId = `${artifactId}-attempts`
      const artifactPath = join(outputRoot, `${artifactId}.json`)
      const attemptsPath = join(outputRoot, `${attemptLedgerId}.json`)
      await writeFile(artifactPath, JSON.stringify({
        version: 1,
        artifactKind: 'structured_output_artifact',
        role: 'judge',
        model: 'policy-leaky-model',
        preset: 'canonical-judge.v1',
        requestFingerprint: 'sha256:request-policy',
        schemaHash: 'sha256:schema-policy',
        policyHash: 'sha256:policy-policy',
        ok: false,
        artifact: {
          role: 'judge',
          artifact: 'failed_fallback.v1',
          reason: 'forbidden business execution phrase',
        },
        rawText: '{"summary":"建议买入，EV 很高"}',
        parsed: true,
        schemaValid: true,
        validationErrors: ['forbidden_phrase: EV', 'forbidden_phrase: 建议买'],
        repairCount: 0,
        salvageUsed: false,
        fallbackUsed: true,
        stopReason: 'end_turn',
        inputTokens: 80,
        outputTokens: 32,
        durationMs: 400,
      }), 'utf8')
      await writeFile(attemptsPath, JSON.stringify({
        version: 1,
        artifactKind: 'structured_output_attempts',
        artifactId,
        attemptLedgerId,
        attempts: [
          {
            label: 'fallback',
            model: 'policy-leaky-model',
            stopReason: 'end_turn',
            parsed: true,
            schemaValid: true,
            error: 'forbidden business execution phrase',
          },
        ],
      }), 'utf8')
      await recordArtifact(outputRoot, {
        id: artifactId,
        path: artifactPath,
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        runId,
        stepId: 'judge',
        participatesInFinal: false,
      })
      await recordArtifact(outputRoot, {
        id: attemptLedgerId,
        path: attemptsPath,
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        runId,
        stepId: 'judge',
        participatesInFinal: false,
      })
      const artifactLedger = await readArtifactLedger(outputRoot)
      const facts = collectRuntimeFactsForRun({
        runId,
        artifacts: artifactLedger.artifacts,
      })

      const scorecard = buildRunScorecard({
        facts,
        finalText: `Structured output failed fallback ${artifactId}.`,
      })

      const dimension = scorecard.dimensions.find(item => item.id === 'model_output_artifact')
      expect(dimension).toMatchObject({
        verdict: 'fail',
        evidenceRefs: expect.arrayContaining([artifactId, attemptLedgerId]),
      })
      expect(dimension?.score).toBeLessThanOrEqual(0.25)
      expect(dimension?.notes.join('\n')).toContain('failed fallback penalty')
      expect(dimension?.notes.join('\n')).toContain('policy violation penalty')

      const structuredRecord = buildRunTrajectory(facts, scorecard)
        .find(record => record.action.type === 'structured_output_model_call')
      expect(structuredRecord).toMatchObject({
        action: {
          type: 'structured_output_model_call',
          model: 'policy-leaky-model',
          preset: 'canonical-judge.v1',
        },
        reward: {
          structured_output: expect.objectContaining({
            schema_valid: true,
            fallback_penalty: expect.any(Number),
            policy_penalty: expect.any(Number),
            verdict: 'fail',
          }),
        },
      })
      expect((structuredRecord?.reward as any).structured_output.fallback_penalty).toBeGreaterThan(0)
      expect((structuredRecord?.reward as any).structured_output.policy_penalty).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function turnCompletedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stop_reason: 'end_turn',
    iterations: 1,
    request_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    assistant_response_count: 1,
    assistant_text_chars: 10,
    final_text_chars: 10,
    tool_use_count: 0,
    executed_tool_count: 0,
    empty_response_count: 0,
    ...overrides,
  }
}
