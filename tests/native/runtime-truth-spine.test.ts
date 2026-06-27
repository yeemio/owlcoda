import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConversation } from '../../src/native/conversation.js'
import { createJob, resetJobSupervisor } from '../../src/native/job-supervisor.js'
import { appendRuntimeRecoveryCheckpoint } from '../../src/native/runtime-recovery-ledger.js'
import { appendRuntimeEvent } from '../../src/native/runtime-events.js'
import { collectRuntimeFactsForRun } from '../../src/native/runtime-facts.js'
import {
  createRunWorkspace,
  readArtifactLedger,
  recordArtifact,
} from '../../src/native/run-workspace.js'

describe('runtime truth spine', () => {
  afterEach(() => {
    resetJobSupervisor()
  })

  it('correlates event, checkpoint, job, and artifact facts by run id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-runtime-truth-spine-'))
    try {
      const conv = createConversation({ system: 'test', model: 'test-model' })
      const threadId = conv.id
      const turnId = 'turn-runtime-truth'
      const runId = 'run-runtime-truth'
      const taskId = 'task-runtime-truth'
      const stepId = 'step-verify'
      const jobId = 'job-runtime-truth'

      const event = appendRuntimeEvent(conv, {
        kind: 'item_completed',
        threadId,
        turnId,
        runId,
        itemId: 'toolu-task-verify',
        factRefs: {
          taskId,
          stepId,
          jobId,
          proofId: 'proof-task-verify',
        },
        payload: {
          tool_name: 'TaskVerify',
          is_error: false,
          task_id: taskId,
          step_id: stepId,
          proof_id: 'proof-task-verify',
        },
      })

      const checkpoint = appendRuntimeRecoveryCheckpoint(conv, {
        kind: 'blocked_task_checkpoint',
        runId,
        payload: {
          schema_version: 1,
          kind: 'blocked_task_checkpoint',
          generated_at: '2026-06-26T00:00:00.000Z',
          blocked_task: {
            task_id: taskId,
            step_id: stepId,
            status: 'blocked',
            inspect_command: `TaskGet taskId=${taskId}`,
          },
        },
      })

      const job = createJob({
        jobId,
        type: 'command',
        stage: 'verify',
        threadId,
        turnId,
        runId,
        taskId,
        source: { kind: 'task', id: taskId },
        artifacts: [{ id: 'artifact-runtime-truth', path: join(dir, 'out.txt') }],
      })

      const outputRoot = join(dir, 'out')
      await createRunWorkspace({ outputRoot, cwd: dir, runId })
      const artifactPath = join(outputRoot, 'out.txt')
      await writeFile(artifactPath, 'runtime truth\n', 'utf8')
      const artifact = await recordArtifact(outputRoot, {
        id: 'artifact-runtime-truth',
        path: artifactPath,
        origin: 'manual',
        threadId,
        turnId,
        taskId,
        stepId,
        jobId,
        proofId: 'proof-task-verify',
      })

      const ledger = await readArtifactLedger(outputRoot)
      const facts = collectRuntimeFactsForRun({
        runId,
        runtimeEventLog: conv.options?.runtimeEventLog,
        runtimeRecoveryLedger: conv.options?.runtimeRecoveryLedger,
        jobs: [job],
        artifacts: ledger.artifacts,
      })

      expect(event.threadId).toBe(threadId)
      expect(event.runId).toBe(runId)
      expect(event.factRefs).toMatchObject({
        threadId,
        turnId,
        runId,
        taskId,
        stepId,
        jobId,
        proofId: 'proof-task-verify',
      })
      expect(checkpoint.factRefs).toMatchObject({
        threadId,
        runId,
        taskId,
        stepId,
        checkpointId: checkpoint.id,
      })
      expect(job.factRefs).toMatchObject({ threadId, turnId, runId, taskId, jobId })
      expect(artifact.factRefs).toMatchObject({
        threadId,
        turnId,
        runId,
        taskId,
        stepId,
        jobId,
        artifactId: 'artifact-runtime-truth',
        proofId: 'proof-task-verify',
      })
      expect(facts).toMatchObject({
        schemaVersion: 1,
        runId,
        threadIds: [threadId],
        turnIds: [turnId],
        taskIds: [taskId],
        stepIds: [stepId],
        jobIds: [jobId],
        artifactIds: ['artifact-runtime-truth'],
        checkpointIds: [checkpoint.id],
        proofIds: ['proof-task-verify'],
        eventIds: [event.id],
        checkpointRecordIds: [checkpoint.id],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
