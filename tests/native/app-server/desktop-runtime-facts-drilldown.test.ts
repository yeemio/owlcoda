import { describe, expect, it } from 'vitest'
import {
  buildDesktopRuntimeFactsDrilldown,
} from '../../../src/native/app-server/desktop-runtime-facts-drilldown.js'

describe('desktop runtime facts drilldown', () => {
  it('links runtime facts with scorecard, jobs, artifacts, proofs, checkpoints, and events', () => {
    const drilldown = buildDesktopRuntimeFactsDrilldown({
      facts: {
        schemaVersion: 1,
        runId: 'run-1',
        threadId: 'thread-1',
        projectId: 'project-1',
        threadIds: ['thread-1'],
        turnIds: ['turn-1'],
        taskIds: ['task-1'],
        stepIds: ['step-1'],
        jobIds: ['job-1'],
        artifactIds: ['artifact-1'],
        checkpointIds: ['checkpoint-1'],
        proofIds: ['proof-1'],
        eventIds: ['event-1'],
        checkpointRecordIds: ['checkpoint-1'],
        runtimeEventCount: 1,
        checkpointCount: 1,
        jobCount: 1,
        artifactCount: 1,
        events: [{
          id: 'event-1',
          seq: 1,
          kind: 'item_completed',
          at: '2026-06-26T01:00:00.000Z',
          runId: 'run-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          factRefs: {
            runId: 'run-1',
            taskId: 'task-1',
            stepId: 'step-1',
            jobId: 'job-1',
            artifactId: 'artifact-1',
            proofId: 'proof-1',
          },
          payload: { tool_name: 'TaskVerify', is_error: false },
        }],
        checkpoints: [{
          id: 'checkpoint-1',
          kind: 'blocked_task_checkpoint',
          generatedAt: '2026-06-26T01:00:01.000Z',
          runId: 'run-1',
          threadId: 'thread-1',
          factRefs: {
            runId: 'run-1',
            taskId: 'task-1',
            checkpointId: 'checkpoint-1',
          },
          payload: {} as any,
        }],
        jobs: [{
          jobId: 'job-1',
          runId: 'run-1',
          taskId: 'task-1',
          status: 'completed',
          stage: 'verify',
          artifacts: [{ id: 'artifact-1', path: 'out/report.json', artifactType: 'json' }],
          proofRequired: true,
          recoveryHint: 'JobGet jobId=job-1',
        } as any],
        artifacts: [{
          id: 'artifact-1',
          runId: 'run-1',
          taskId: 'task-1',
          jobId: 'job-1',
          proofId: 'proof-1',
          factRefs: {
            runId: 'run-1',
            artifactPath: 'out/report.json',
          },
        }],
      },
      scorecard: {
        schemaVersion: 1,
        threadId: 'thread-1',
        projectId: 'project-1',
        runId: 'run-1',
        summary: 'Scorecard run=run-1 score=92 verdict=pass anti_cheat=pass',
        scorecard: {
          scorecardVersion: 1,
          runId: 'run-1',
          threadIds: ['thread-1'],
          turnIds: ['turn-1'],
          generatedAt: '2026-06-26T01:00:02.000Z',
          overallScore: 92,
          verdict: 'pass',
          dimensions: [{
            id: 'verification',
            score: 1,
            verdict: 'pass',
            evidenceRefs: ['event-1'],
            notes: ['verification passed'],
          }],
          antiCheat: {
            verdict: 'pass',
            gates: [{
              id: 'unverified_pass_claim',
              status: 'pass',
              evidenceRefs: ['event-1'],
              notes: ['claim is verified'],
            }],
          },
          evidenceRefs: ['event-1', 'job-1', 'artifact-1', 'proof-1'],
        },
        trajectory: {
          recordCount: 1,
          localOnly: true,
          redactionMode: 'local_redacted_v0',
          records: [],
        },
        facts: {
          runtimeEventCount: 1,
          checkpointCount: 1,
          jobCount: 1,
          artifactCount: 1,
        },
      },
      rail: {
        projectId: 'project-1',
        freshness: 'fresh',
        packet: null,
        gate: null,
        claim: null,
        proofs: [{
          kind: 'verification',
          title: 'Task proof',
          status: 'recorded',
          sourceRef: 'proof-1',
          at: '2026-06-26T01:00:03.000Z',
        }],
        rejectedPaths: [],
        nextAction: null,
        source: 'project_truth_packet',
      },
    })

    expect(drilldown).toMatchObject({
      surface: 'desktop-runtime-facts-drilldown',
      runId: 'run-1',
      scorecardStatus: 'ready',
      scorecard: {
        overallScore: 92,
        verdict: 'pass',
        antiCheat: 'pass',
      },
      summary: {
        events: 1,
        checkpoints: 1,
        jobs: 1,
        artifacts: 1,
        tasks: 1,
        proofs: 1,
      },
      entities: {
        jobs: [expect.objectContaining({
          jobId: 'job-1',
          status: 'completed',
          stage: 'verify',
          artifactCount: 1,
          proofRequired: true,
        })],
        artifacts: [expect.objectContaining({
          artifactId: 'artifact-1',
          path: 'out/report.json',
          jobId: 'job-1',
          proofId: 'proof-1',
        })],
        proofs: [expect.objectContaining({
          proofId: 'proof-1',
          title: 'Task proof',
          status: 'recorded',
        })],
        checkpoints: [expect.objectContaining({
          checkpointId: 'checkpoint-1',
          kind: 'blocked_task_checkpoint',
        })],
        events: [expect.objectContaining({
          eventId: 'event-1',
          kind: 'item_completed',
          toolName: 'TaskVerify',
          jobId: 'job-1',
        })],
      },
    })
    expect(drilldown.evidenceRefs).toEqual(['event-1', 'job-1', 'artifact-1', 'proof-1'])
  })
})
