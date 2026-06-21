import { describe, expect, it } from 'vitest'

import {
  appendRuntimeRecoveryCheckpoint,
  appendContextReplacementCheckpoint,
  buildRuntimeRecoveryLedgerPrompt,
  injectRuntimeRecoveryLedgerPromptIfNeeded,
  markBlockedTaskRecoveryCheckpointAcknowledged,
  markLongTaskReplacementCheckpointResolved,
  markLongTaskRecoveryCheckpointResolved,
} from '../../src/native/runtime-recovery-ledger.js'
import {
  reconstructRuntimeTruthFromEvents,
} from '../../src/native/runtime-events.js'
import type { RuntimeRecoveryLedger } from '../../src/native/protocol/types.js'
import { createConversation } from '../../src/native/conversation.js'

function blockedPayload(stepId: string, generatedAt: string) {
  return {
    schema_version: 1,
    kind: 'blocked_task_checkpoint',
    generated_at: generatedAt,
    blocked_task: {
      task_id: 'task-1',
      step_id: stepId,
      status: 'blocked',
      inspect_command: 'TaskGet taskId=task-1',
    },
  }
}

function longTaskPayload(longTaskIds: string[], generatedAt: string) {
  return {
    schema_version: 1,
    kind: 'long_task_checkpoint',
    generated_at: generatedAt,
    long_tasks: longTaskIds.map((id) => ({
      long_task_id: id,
      source: 'task_command',
      status: 'running',
      objective: `work for ${id}`,
      started_at: '2026-06-17T00:00:00.000Z',
      updated_at: generatedAt,
      inspect_command: `TaskOutput task_id=${id.replace(/^task:/, '')} block=false`,
    })),
  }
}

function longTaskReplacementPayload(generatedAt: string) {
  return {
    schema_version: 1,
    kind: 'long_task_replacement_checkpoint',
    generated_at: generatedAt,
    replacement: {
      original_long_task_id: 'task:task-1',
      replacement_long_task_id: 'task:task-2',
      replacement_task_id: 'task-2',
      status: 'started',
      reason: 'process handle missing after resume',
      inspect_command: 'LongTaskGet longTaskId=task:task-2',
      output_command: 'TaskOutput task_id=task-2 block=false',
    },
  }
}

describe('runtime recovery ledger disposition', () => {
  it('marks an older active checkpoint superseded when a newer checkpoint has the same identity', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'blocked_task_checkpoint',
      payload: blockedPayload('prove-ledger', '2026-06-17T00:00:01.000Z'),
    })
    const second = appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'blocked_task_checkpoint',
      payload: blockedPayload('prove-ledger', '2026-06-17T00:00:02.000Z'),
    })

    const checkpoints = conv.options?.runtimeRecoveryLedger?.checkpoints ?? []
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]?.disposition).toBe('superseded')
    expect(checkpoints[0]?.dispositionReason).toContain(second.id)
    expect(checkpoints[1]?.disposition).toBe('active')
  })

  it('records checkpoint disposition change events when an older checkpoint is superseded', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'blocked_task_checkpoint',
      payload: blockedPayload('prove-ledger', '2026-06-17T00:00:01.000Z'),
    })
    const second = appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'blocked_task_checkpoint',
      payload: blockedPayload('prove-ledger', '2026-06-17T00:00:02.000Z'),
    })

    const events = conv.options?.runtimeEventLog?.events ?? []
    expect(events.map((event) => event.kind)).toEqual([
      'checkpoint_installed',
      'checkpoint_disposition_changed',
      'checkpoint_installed',
    ])
    expect(events[1]).toMatchObject({
      kind: 'checkpoint_disposition_changed',
      checkpointId: 'blocked_task_checkpoint-1',
      checkpointKind: 'blocked_task_checkpoint',
      payload: {
        checkpoint_id: 'blocked_task_checkpoint-1',
        checkpoint_kind: 'blocked_task_checkpoint',
        previous_disposition: 'active',
        disposition: 'superseded',
        reason: `Superseded by newer checkpoint ${second.id}.`,
      },
    })
  })

  it('records checkpoint disposition change events when a checkpoint is acknowledged', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'blocked_task_checkpoint',
      payload: blockedPayload('prove-ledger', '2026-06-17T00:00:01.000Z'),
    })

    const updated = markBlockedTaskRecoveryCheckpointAcknowledged(conv, {
      taskId: 'task-1',
      stepId: 'prove-ledger',
      reason: 'Model produced the required text-only blocked checkpoint report.',
      updatedAt: '2026-06-17T00:00:02.000Z',
    })

    const events = conv.options?.runtimeEventLog?.events ?? []
    expect(updated).toBe(1)
    expect(events.map((event) => event.kind)).toEqual([
      'checkpoint_installed',
      'checkpoint_disposition_changed',
    ])
    expect(events[1]).toMatchObject({
      kind: 'checkpoint_disposition_changed',
      checkpointId: 'blocked_task_checkpoint-1',
      checkpointKind: 'blocked_task_checkpoint',
      payload: {
        checkpoint_id: 'blocked_task_checkpoint-1',
        checkpoint_kind: 'blocked_task_checkpoint',
        previous_disposition: 'active',
        disposition: 'acknowledged',
        reason: 'Model produced the required text-only blocked checkpoint report.',
      },
    })
  })

  it('builds resume prompt from unresolved checkpoints and omits resolved checkpoint payloads', () => {
    const ledger: RuntimeRecoveryLedger = {
      schemaVersion: 1,
      updatedAt: '2026-06-17T00:00:03.000Z',
      checkpoints: [
        {
          id: 'blocked_task_checkpoint-1',
          kind: 'blocked_task_checkpoint',
          generatedAt: '2026-06-17T00:00:01.000Z',
          conversationId: 'conv-test',
          disposition: 'resolved',
          dispositionUpdatedAt: '2026-06-17T00:00:02.000Z',
          dispositionReason: 'Task step completed.',
          inspectCommands: ['TaskGet taskId=task-1'],
          payload: blockedPayload('old-resolved-step', '2026-06-17T00:00:01.000Z'),
        },
        {
          id: 'blocked_task_checkpoint-2',
          kind: 'blocked_task_checkpoint',
          generatedAt: '2026-06-17T00:00:03.000Z',
          conversationId: 'conv-test',
          disposition: 'active',
          inspectCommands: ['TaskGet taskId=task-2'],
          payload: {
            schema_version: 1,
            kind: 'blocked_task_checkpoint',
            blocked_task: {
              task_id: 'task-2',
              step_id: 'still-blocked-step',
              status: 'blocked',
              inspect_command: 'TaskGet taskId=task-2',
            },
          },
        },
      ],
    }

    const prompt = buildRuntimeRecoveryLedgerPrompt(ledger)

    expect(prompt).toContain('"unresolved_checkpoints"')
    expect(prompt).toContain('still-blocked-step')
    expect(prompt).not.toContain('old-resolved-step')
    expect(prompt).toContain('"resolved_checkpoint_count": 1')
  })

  it('keeps loop-intercept closeout checkpoints in the resume prompt', () => {
    const ledger: RuntimeRecoveryLedger = {
      schemaVersion: 1,
      updatedAt: '2026-06-19T00:00:03.000Z',
      checkpoints: [{
        id: 'loop_intercept_closeout_checkpoint-1',
        kind: 'loop_intercept_closeout_checkpoint',
        generatedAt: '2026-06-19T00:00:03.000Z',
        conversationId: 'conv-test',
        disposition: 'active',
        inspectCommands: [],
        payload: {
          schema_version: 1,
          kind: 'loop_intercept_closeout_checkpoint',
          loop_intercept_closeout: {
            loop_reason: 'task stuck in tool loop: Skill nonexistent',
            intent_key: 'Skill:nonexistent',
            last_attempt: {
              tool: 'Skill',
              intent_target: 'nonexistent',
            },
            last_error: 'Skill "nonexistent" not found',
            resume_packet: {
              source: 'runtime_loop_intercept',
              next_action: 'closeout the loop before retrying',
            },
          },
        },
      }],
    }

    const prompt = buildRuntimeRecoveryLedgerPrompt(ledger)

    expect(prompt).toContain('loop_intercept_closeout_checkpoint')
    expect(prompt).toContain('"last_error"')
    expect(prompt).toContain('nonexistent')
    expect(prompt).toContain('loop_intercept_closeout_report')
    expect(prompt).toContain('closeout the loop before retrying')
  })

  it('resolves long-task checkpoints by long task identity', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'long_task_checkpoint',
      payload: longTaskPayload(['task:task-1', 'agent:agent-D1'], '2026-06-17T00:00:01.000Z'),
    })

    const updated = markLongTaskRecoveryCheckpointResolved(conv, {
      longTaskIds: ['agent:agent-D1', 'task:task-1'],
      reason: 'Long-task report covered all checkpoint targets.',
    })

    const checkpoint = conv.options?.runtimeRecoveryLedger?.checkpoints[0]
    expect(updated).toBe(1)
    expect(checkpoint?.disposition).toBe('resolved')
    expect(checkpoint?.dispositionReason).toContain('covered all')
  })

  it('resolves long-task replacement checkpoints by original and replacement identities', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'long_task_replacement_checkpoint',
      payload: longTaskReplacementPayload('2026-06-18T00:00:01.000Z'),
    })

    const updated = markLongTaskReplacementCheckpointResolved(conv, {
      originalLongTaskId: 'task:task-1',
      replacementLongTaskId: 'task:task-2',
      reason: 'Terminal replacement inspect result covered task:task-2.',
    })

    const checkpoint = conv.options?.runtimeRecoveryLedger?.checkpoints[0]
    expect(updated).toBe(1)
    expect(checkpoint?.disposition).toBe('resolved')
    expect(checkpoint?.dispositionReason).toContain('Terminal replacement')
  })

  it('records checkpoint lifecycle events when checkpoints are installed and resolved', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    appendRuntimeRecoveryCheckpoint(conv, {
      kind: 'long_task_replacement_checkpoint',
      payload: longTaskReplacementPayload('2026-06-18T00:00:01.000Z'),
    })

    markLongTaskReplacementCheckpointResolved(conv, {
      originalLongTaskId: 'task:task-1',
      replacementLongTaskId: 'task:task-2',
      reason: 'Replacement task reached terminal state.',
      updatedAt: '2026-06-18T00:00:02.000Z',
    })

    const events = conv.options?.runtimeEventLog?.events ?? []
    expect(events.map((event) => event.kind)).toEqual([
      'checkpoint_installed',
      'checkpoint_resolved',
    ])
    expect(events[0]).toMatchObject({
      kind: 'checkpoint_installed',
      checkpointId: 'long_task_replacement_checkpoint-1',
      checkpointKind: 'long_task_replacement_checkpoint',
    })
    expect(events[1]).toMatchObject({
      kind: 'checkpoint_resolved',
      checkpointId: 'long_task_replacement_checkpoint-1',
      checkpointKind: 'long_task_replacement_checkpoint',
    })
  })

  it('installs context replacement checkpoints and reconstructs the latest replacement truth from runtime events', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    const inputHistory = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'original goal' }], timestamp: 1 },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old answer' }], timestamp: 2 },
    ]
    const replacementHistory = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: '[Conversation compacted]\nCurrent goal: original goal' }], timestamp: 3 },
    ]

    const checkpoint = appendContextReplacementCheckpoint(conv, {
      inputHistory,
      replacementHistory,
      reason: 'threshold',
      windowId: 'window-1',
      sourceTurnId: 'turn-7',
      generatedAt: '2026-06-18T00:00:03.000Z',
    })

    const snapshot = reconstructRuntimeTruthFromEvents({
      runtimeEventLog: conv.options?.runtimeEventLog,
      runtimeRecoveryLedger: conv.options?.runtimeRecoveryLedger,
    })

    expect(checkpoint.kind).toBe('context_replacement_checkpoint')
    const contextReplacement = checkpoint.payload.context_replacement as Record<string, unknown>
    expect(contextReplacement).toMatchObject({
      reason: 'threshold',
      window_id: 'window-1',
      source_turn_id: 'turn-7',
      ledger_status: 'active',
      replacement_history: replacementHistory,
    })
    expect(checkpoint.payload.context_replacement).toHaveProperty('input_history_digest')
    expect(snapshot.latestContextReplacement?.checkpoint.id).toBe(checkpoint.id)
    expect(snapshot.latestContextReplacement?.replacementHistory).toEqual(replacementHistory)
    expect(snapshot.latestContextReplacement?.suffixEvents).toEqual([])

    const installEvent = conv.options?.runtimeEventLog?.events.find((event) =>
      event.kind === 'checkpoint_installed'
      && event.checkpointId === checkpoint.id
      && event.checkpointKind === 'context_replacement_checkpoint'
    )
    expect(installEvent?.payload?.['context_replacement']).toMatchObject({
      input_history_digest: contextReplacement.input_history_digest,
      reason: 'threshold',
      window_id: 'window-1',
      source_turn_id: 'turn-7',
      ledger_status: 'active',
      replacement_history_turns: replacementHistory.length,
    })
  })

  it('does not inject generic recovery prompts for context replacement checkpoints alone', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.turns.push({
      role: 'user',
      content: [{ type: 'text', text: 'Resume after compaction.' }],
      timestamp: Date.now(),
    })

    appendContextReplacementCheckpoint(conv, {
      inputHistory: [{
        role: 'user',
        content: [{ type: 'text', text: 'before compact' }],
        timestamp: 1,
      }],
      replacementHistory: [{
        role: 'user',
        content: [{ type: 'text', text: '[Conversation compacted]\nCurrent goal: before compact' }],
        timestamp: 2,
      }],
      reason: 'threshold',
      windowId: 'window-1',
      sourceTurnId: 'turn-1',
      generatedAt: '2026-06-18T00:00:03.000Z',
    })

    const injected = injectRuntimeRecoveryLedgerPromptIfNeeded(conv)

    expect(injected).toBe(false)
    expect(conv.turns.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: 'Resume after compaction.',
    })
  })

  it('creates a parent synthesis checkpoint for mixed-source unresolved long-task evidence on resume', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.turns.push({
      role: 'user',
      content: [{ type: 'text', text: 'Resume mixed long task recovery.' }],
      timestamp: Date.now(),
    })
    ;(conv as any).options = {
      runtimeRecoveryLedger: {
        schemaVersion: 1,
        updatedAt: '2026-06-17T01:00:00.000Z',
        checkpoints: [{
          id: 'long_task_checkpoint-1',
          kind: 'long_task_checkpoint',
          generatedAt: '2026-06-17T00:50:00.000Z',
          conversationId: conv.id,
          disposition: 'active',
          inspectCommands: ['TaskOutput task_id=task-1 block=false'],
          payload: longTaskPayload(['task:task-1'], '2026-06-17T00:50:00.000Z'),
        }, {
          id: 'child_run_synthesis_checkpoint-2',
          kind: 'child_run_synthesis_checkpoint',
          generatedAt: '2026-06-17T00:55:00.000Z',
          conversationId: conv.id,
          disposition: 'active',
          inspectCommands: ['AgentRunGet agentId=agent-D1'],
          payload: {
            schema_version: 1,
            kind: 'child_run_synthesis_checkpoint',
            generated_at: '2026-06-17T00:55:00.000Z',
            child_count: 1,
            children: [{
              agent_id: 'agent-D1',
              status: 'timeout',
              failure_category: 'agent:watchdog_timeout',
              inspect_command: 'AgentRunGet agentId=agent-D1',
            }],
          },
        }],
      },
    }

    const injected = injectRuntimeRecoveryLedgerPromptIfNeeded(conv)
    const ledger = (conv.options as any)?.runtimeRecoveryLedger
    const synthesis = ledger?.checkpoints?.find((checkpoint: any) => checkpoint.kind === 'long_task_synthesis_checkpoint')
    const prompt = JSON.stringify(conv.turns.at(-1)?.content).replace(/\\"/g, '"')

    expect(injected).toBe(true)
    expect(synthesis).toBeTruthy()
    expect(synthesis.payload.kind).toBe('long_task_synthesis_checkpoint')
    expect(synthesis.payload.source_checkpoint_ids).toEqual([
      'long_task_checkpoint-1',
      'child_run_synthesis_checkpoint-2',
    ])
    expect(synthesis.payload.long_tasks.map((task: any) => task.long_task_id).sort()).toEqual([
      'agent:agent-D1',
      'task:task-1',
    ])
    expect(prompt).toContain('[Runtime long-task synthesis checkpoint]')
    expect(prompt).toContain('Your next reply MUST be a single JSON object')
    expect(prompt).toContain('"kind": "long_task_synthesis_report"')
    expect(prompt).toContain('"long_tasks":')
    expect(prompt).not.toContain('Your next reply MUST be plain text')
  })
})
