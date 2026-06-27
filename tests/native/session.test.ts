import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  restoreConversation,
  getSessionsDir,
} from '../../src/native/session.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'
import { createTaskVerifyTool } from '../../src/native/tools/task-verify.js'
import { createTaskUpdateTool } from '../../src/native/tools/task-update.js'
import {
  createAgentRunGetTool,
  __resetAgentRunHistoryForTesting,
  restoreAgentRunHistory,
} from '../../src/native/tools/agent.js'
import { createJobGetTool } from '../../src/native/tools/job.js'
import {
  createTask,
  getTask,
  resetTaskStore,
  updateTaskStep,
} from '../../src/native/tools/task-store.js'
import {
  createJob,
  finishJob,
  getJob,
  resetJobSupervisor,
  startJob,
} from '../../src/native/job-supervisor.js'

// Use a temp dir to avoid polluting real sessions
const REAL_DIR = getSessionsDir()
const SESSION_IO_TEST_TIMEOUT_MS = 15000
let tmpDir: string

// We'll mock the sessions dir by writing to the real dir then cleaning up
// Instead, let's test the core logic with real save/load

describe('Native Session Persistence', { timeout: SESSION_IO_TEST_TIMEOUT_MS }, () => {
  const testId = `test-session-${Date.now()}`

  afterEach(() => {
    // Clean up test sessions
    deleteSession(testId)
    resetTaskStore()
    __resetAgentRunHistoryForTesting()
  })

  it('saves and loads a conversation', () => {
    const conv = createConversation({
      system: 'Be helpful',
      model: 'test-model',
      maxTokens: 2048,
    })
    // Override ID for predictable testing
    ;(conv as any).id = testId

    addUserMessage(conv, 'Hello there')

    const filePath = saveSession(conv, 'Test Session')
    expect(filePath).toContain(testId)
    expect(fs.existsSync(filePath)).toBe(true)

    const loaded = loadSession(testId)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(testId)
    expect(loaded!.model).toBe('test-model')
    expect(loaded!.system).toBe('Be helpful')
    expect(loaded!.maxTokens).toBe(2048)
    expect(loaded!.title).toBe('Test Session')
    expect(loaded!.turns).toHaveLength(1)
    expect(loaded!.version).toBe(1)
  })

  it('returns null for non-existent session', () => {
    expect(loadSession('non-existent-id-123')).toBeNull()
  })

  it('updates existing session on re-save', () => {
    const conv = createConversation({
      system: 'test',
      model: 'm',
    })
    ;(conv as any).id = testId

    addUserMessage(conv, 'first')
    saveSession(conv)
    const first = loadSession(testId)!
    expect(first.turns).toHaveLength(1)

    addUserMessage(conv, 'second')
    saveSession(conv)
    const second = loadSession(testId)!
    expect(second.turns).toHaveLength(2)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
  })

  it('persists runtime recovery ledger independently of transcript turns', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'start a long-running job')
    ;(conv as any).options = {
      runtimeRecoveryLedger: {
        schemaVersion: 1,
        updatedAt: '2026-06-17T00:00:01.000Z',
        checkpoints: [{
          id: 'checkpoint-1',
          kind: 'long_task_checkpoint',
          generatedAt: '2026-06-17T00:00:01.000Z',
          conversationId: testId,
          payload: {
            schema_version: 1,
            kind: 'long_task_checkpoint',
            generated_at: '2026-06-17T00:00:01.000Z',
            long_tasks: [{
              long_task_id: 'task:task-1',
              inspect_command: 'TaskOutput task_id=task-1 block=false',
            }],
          },
          inspectCommands: ['TaskOutput task_id=task-1 block=false'],
        }],
      },
    }

    saveSession(conv, 'ledger session')
    const loaded = loadSession(testId) as any
    expect(loaded.runtimeRecoveryLedger?.checkpoints).toHaveLength(1)
    expect(loaded.runtimeRecoveryLedger.checkpoints[0].kind).toBe('long_task_checkpoint')
    expect(loaded.runtimeRecoveryLedger.checkpoints[0].inspectCommands).toEqual([
      'TaskOutput task_id=task-1 block=false',
    ])

    const restored = restoreConversation(loaded, [])
    expect((restored.options as any)?.runtimeRecoveryLedger?.checkpoints[0].payload.kind).toBe('long_task_checkpoint')
  })

  it('persists runtime event log independently of transcript turns', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'install a runtime checkpoint')
    ;(conv as any).options = {
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-18T00:00:02.000Z',
        nextSeq: 3,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'turn_started',
          at: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          turnId: 'turn-1',
          payload: { source: 'test' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'checkpoint_installed',
          at: '2026-06-18T00:00:02.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint',
          payload: { reason: 'threshold' },
        }],
      },
    }

    saveSession(conv, 'runtime events')
    const loaded = loadSession(testId) as any
    expect(loaded.runtimeEventLog?.events).toHaveLength(2)
    expect(loaded.runtimeEventLog.events[1]).toMatchObject({
      kind: 'checkpoint_installed',
      checkpointKind: 'context_replacement_checkpoint',
    })

    const restored = restoreConversation(loaded, [])
    expect((restored.options as any)?.runtimeEventLog?.events[1].checkpointId).toBe('context_replacement_checkpoint-1')
  })

  it('reconstructs resume context from the latest context replacement checkpoint', () => {
    const staleTurn = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'stale transcript memory that should not be restored' }],
      timestamp: 1,
    }
    const replacementTurns = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'compacted goal from runtime checkpoint' }],
      timestamp: 2,
    }, {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'latest evidence preserved by replacement history' }],
      timestamp: 3,
    }]
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 1024,
      turns: [staleTurn],
      createdAt: 1,
      updatedAt: 2,
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:04.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            schema_version: 1,
            kind: 'context_replacement_checkpoint',
            context_replacement: {
              input_history_digest: 'sha256:checkpoint-digest',
              replacement_history: replacementTurns,
              reason: 'threshold',
              window_id: 'window-1',
              source_turn_id: 'turn-1',
              ledger_status: 'active',
            },
          },
          inspectCommands: [],
        }, {
          id: 'long_task_checkpoint-1',
          kind: 'long_task_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:04.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            schema_version: 1,
            kind: 'long_task_checkpoint',
            long_tasks: [{
              long_task_id: 'task:slow-build',
              source: 'task_command',
              status: 'incomplete',
              inspect_command: 'TaskOutput task_id=slow-build block=false',
            }],
          },
          inspectCommands: ['TaskOutput task_id=slow-build block=false'],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:05.000Z',
        nextSeq: 6,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed' as const,
          at: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: { reason: 'threshold' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'item_completed' as const,
          at: '2026-06-18T00:00:03.000Z',
          conversationId: testId,
          itemId: 'toolu-1',
          payload: { tool: 'TaskOutput', summary: 'slow-build still running' },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'turn_completed' as const,
          at: '2026-06-18T00:00:05.000Z',
          conversationId: testId,
          turnId: 'turn-2',
          payload: { stop_reason: 'long_task_wait_policy' },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).not.toContain('stale transcript memory')
    expect(text).toContain('compacted goal from runtime checkpoint')
    expect(text).toContain('[Runtime truth resume snapshot]')
    expect(text).toContain('context_replacement_checkpoint-1')
    expect(text).toContain('sha256:checkpoint-digest')
    expect(text).toContain('item_completed')
    expect(text).toContain('long_task_checkpoint-1')
    expect(text).toContain('Use this runtime snapshot as the source of truth')
  })

  it('injects a runtime truth resume snapshot from event-only saved runtime truth', () => {
    const staleTurn = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'stale transcript says the slow task finished' }],
      timestamp: 1,
    }
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 1024,
      turns: [staleTurn],
      createdAt: 1,
      updatedAt: 2,
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-21T00:00:03.000Z',
        checkpoints: [{
          id: 'long_task_checkpoint-event-only-1',
          kind: 'long_task_checkpoint' as const,
          generatedAt: '2026-06-21T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            schema_version: 1,
            kind: 'long_task_checkpoint',
            long_tasks: [{
              long_task_id: 'task:event-only-slow-build',
              status: 'incomplete',
              inspect_command: 'LongTaskGet longTaskId=task:event-only-slow-build',
            }],
          },
          inspectCommands: ['LongTaskGet longTaskId=task:event-only-slow-build'],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-21T00:00:04.000Z',
        nextSeq: 3,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'runtime_intervention' as const,
          at: '2026-06-21T00:00:03.000Z',
          conversationId: testId,
          itemId: 'sleep-policy-violation',
          payload: {
            intervention_kind: 'long_task_wait_policy',
            action: 'skipped_tool_use',
            tool_name: 'Sleep',
            violation_kind: 'sleep_polling',
            long_task_id: 'task:event-only-slow-build',
            next_check_command: 'LongTaskAwait longTaskId=task:event-only-slow-build timeoutMs=5000',
          },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'turn_completed' as const,
          at: '2026-06-21T00:00:04.000Z',
          conversationId: testId,
          turnId: 'turn-event-only',
          payload: { stop_reason: 'long_task_wait_policy', iterations: 2 },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).toContain('stale transcript says the slow task finished')
    expect(text).toContain('[Runtime truth resume snapshot]')
    expect(text).toContain('runtime_event_log_snapshot')
    expect(text).toContain('No context replacement checkpoint was present')
    expect(text).toContain('long_task_wait_policy')
    expect(text).toContain('LongTaskAwait longTaskId=task:event-only-slow-build timeoutMs=5000')
    expect(text).toContain('long_task_checkpoint-event-only-1')
    expect(text).toContain('LongTaskGet longTaskId=task:event-only-slow-build')
  })

  it('replays runtime intervention events in the runtime truth resume snapshot', () => {
    const replacementTurns = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'runtime-owned replacement goal' }],
      timestamp: 2,
    }]
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 4096,
      turns: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'stale transcript text' }],
        timestamp: 1,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:03.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            context_replacement: {
              input_history_digest: 'sha256:intervention-digest',
              reason: 'runtime intervention replay',
              replacement_history: replacementTurns,
            },
          },
          inspectCommands: [],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:05.000Z',
        nextSeq: 6,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed' as const,
          at: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_intervention' as const,
          at: '2026-06-18T00:00:03.000Z',
          conversationId: testId,
          turnId: 'turn-resume-report',
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: {
            intervention_kind: 'runtime_truth_resume_report_gate',
            action: 'dropped_tool_use_synthesized_report',
            ignored_tool_count: 1,
            ignored_tools: [{
              tool_use_id: 'tool-longtask-get',
              tool_name: 'LongTaskGet',
              input_keys: ['longTaskId'],
            }],
          },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'runtime_intervention' as const,
          at: '2026-06-18T00:00:04.000Z',
          conversationId: testId,
          itemId: 'sleep-policy-violation',
          payload: {
            intervention_kind: 'long_task_wait_policy',
            action: 'skipped_tool_use',
            tool_name: 'Sleep',
            violation_kind: 'sleep_polling',
            long_task_id: 'task:task-1',
            next_check_command: 'LongTaskAwait longTaskId=task:task-1 timeoutMs=5000',
          },
        }, {
          id: 'runtime_event-4',
          seq: 4,
          kind: 'runtime_intervention' as const,
          at: '2026-06-18T00:00:04.500Z',
          conversationId: testId,
          itemId: 'tool-redundant-update',
          payload: {
            intervention_kind: 'post_recovery_overrun_guard',
            action: 'skipped_redundant_task_update',
            tool_name: 'TaskUpdate',
            task_id: 'task-1',
            step_id: 'prove-verify',
            checkpoint_id: 'verification_repair_checkpoint-1',
          },
        }, {
          id: 'runtime_event-5',
          seq: 5,
          kind: 'turn_completed' as const,
          at: '2026-06-18T00:00:05.000Z',
          conversationId: testId,
          turnId: 'turn-resume-report',
          payload: {
            stop_reason: 'end_turn',
            closure_reason: 'runtime_truth_resume_report_satisfied',
          },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).toContain('"runtime_interventions"')
    expect(text).toContain('"runtime_closures"')
    expect(text).toContain('runtime_truth_resume_report_gate')
    expect(text).toContain('dropped_tool_use_synthesized_report')
    expect(text).toContain('LongTaskGet')
    expect(text).toContain('long_task_wait_policy')
    expect(text).toContain('sleep-policy-violation')
    expect(text).toContain('post_recovery_overrun_guard')
    expect(text).toContain('tool-redundant-update')
    expect(text).toContain('runtime_truth_resume_report_satisfied')
  })

  it('replays checkpoint disposition changes in the runtime truth resume snapshot', () => {
    const replacementTurns = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'runtime-owned checkpoint disposition goal' }],
      timestamp: 2,
    }]
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 4096,
      turns: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'stale transcript text' }],
        timestamp: 1,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:03.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            context_replacement: {
              input_history_digest: 'sha256:disposition-digest',
              reason: 'checkpoint disposition replay',
              replacement_history: replacementTurns,
            },
          },
          inspectCommands: [],
        }, {
          id: 'verification_repair_checkpoint-1',
          kind: 'verification_repair_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:02.000Z',
          conversationId: testId,
          disposition: 'acknowledged' as const,
          dispositionUpdatedAt: '2026-06-18T00:00:03.000Z',
          dispositionReason: 'Model produced the required text-only verification repair report.',
          payload: {
            verification_repair: {
              task_id: 'task-1',
              step_id: 'prove-verify',
              status: 'failed_verification',
            },
          },
          inspectCommands: [
            'TaskGet taskId=task-1',
            'TaskVerify taskId=task-1 stepId=prove-verify',
          ],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:03.000Z',
        nextSeq: 3,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed' as const,
          at: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'checkpoint_disposition_changed' as any,
          at: '2026-06-18T00:00:03.000Z',
          conversationId: testId,
          checkpointId: 'verification_repair_checkpoint-1',
          checkpointKind: 'verification_repair_checkpoint' as const,
          payload: {
            checkpoint_id: 'verification_repair_checkpoint-1',
            checkpoint_kind: 'verification_repair_checkpoint',
            previous_disposition: 'active',
            disposition: 'acknowledged',
            reason: 'Model produced the required text-only verification repair report.',
          },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).toContain('"runtime_checkpoint_dispositions"')
    expect(text).toContain('verification_repair_checkpoint-1')
    expect(text).toContain('acknowledged')
    expect(text).toContain('Model produced the required text-only verification repair report')
  })

  it('replays accepted runtime truth report events in the runtime truth resume snapshot', () => {
    const replacementTurns = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'runtime-owned report event goal' }],
      timestamp: 2,
    }]
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 4096,
      turns: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'stale transcript text' }],
        timestamp: 1,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:03.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            context_replacement: {
              input_history_digest: 'sha256:report-event-digest',
              reason: 'runtime truth report event replay',
              replacement_history: replacementTurns,
            },
          },
          inspectCommands: [],
        }, {
          id: 'long_task_checkpoint-1',
          kind: 'long_task_checkpoint' as const,
          generatedAt: '2026-06-18T00:00:02.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: { long_tasks: [] },
          inspectCommands: ['LongTaskGet longTaskId=task:report-event'],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-18T00:00:04.000Z',
        nextSeq: 3,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed' as const,
          at: '2026-06-18T00:00:01.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_truth_report_recorded' as const,
          at: '2026-06-18T00:00:04.000Z',
          conversationId: testId,
          turnId: 'turn-report',
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: {
            report_kind: 'runtime_truth_resume_report',
            report_source: 'assistant_text',
            report: {
              kind: 'runtime_truth_resume_report',
              source: 'runtime_event_log',
              checkpoint_id: 'context_replacement_checkpoint-1',
              input_history_digest: 'sha256:report-event-digest',
              unresolved_checkpoints: [{
                checkpoint_id: 'long_task_checkpoint-1',
                inspect_command: 'LongTaskGet longTaskId=task:report-event',
              }],
            },
          },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).toContain('"runtime_truth_reports"')
    expect(text).toContain('runtime_truth_resume_report')
    expect(text).toContain('assistant_text')
    expect(text).toContain('sha256:report-event-digest')
    expect(text).toContain('long_task_checkpoint-1')
    expect(text).toContain('LongTaskGet longTaskId=task:report-event')
  })

  it('replays accepted runtime recovery report events in the runtime truth resume snapshot', () => {
    const replacementTurns = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'runtime-owned recovery report event goal' }],
      timestamp: 2,
    }]
    const session = {
      version: 1 as const,
      id: testId,
      model: 'm',
      system: 'test',
      maxTokens: 4096,
      turns: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'stale transcript text' }],
        timestamp: 1,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-19T00:00:04.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint' as const,
          generatedAt: '2026-06-19T00:00:01.000Z',
          conversationId: testId,
          disposition: 'active' as const,
          payload: {
            context_replacement: {
              input_history_digest: 'sha256:recovery-report-digest',
              reason: 'runtime recovery report event replay',
              replacement_history: replacementTurns,
            },
          },
          inspectCommands: [],
        }, {
          id: 'child_run_synthesis_checkpoint-1',
          kind: 'child_run_synthesis_checkpoint' as const,
          generatedAt: '2026-06-19T00:00:02.000Z',
          conversationId: testId,
          disposition: 'acknowledged' as const,
          dispositionUpdatedAt: '2026-06-19T00:00:03.000Z',
          dispositionReason: 'Model produced the required child-run synthesis report.',
          payload: {
            child_run: {
              agent_id: 'agent-D1',
              status: 'timeout_incomplete',
              recovery_command: 'AgentRunGet agentId=agent-D1',
            },
          },
          inspectCommands: ['AgentRunGet agentId=agent-D1'],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-19T00:00:04.000Z',
        nextSeq: 3,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed' as const,
          at: '2026-06-19T00:00:01.000Z',
          conversationId: testId,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint' as const,
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_recovery_report_recorded' as const,
          at: '2026-06-19T00:00:04.000Z',
          conversationId: testId,
          turnId: 'turn-child-run-report',
          checkpointId: 'child_run_synthesis_checkpoint-1',
          checkpointKind: 'child_run_synthesis_checkpoint' as const,
          payload: {
            report_kind: 'child_run_synthesis_report',
            report_source: 'assistant_text',
            report: {
              kind: 'child_run_synthesis_report',
              agent_id: 'agent-D1',
              checkpoint_id: 'child_run_synthesis_checkpoint-1',
              status: 'timeout_incomplete',
              recovery_command: 'AgentRunGet agentId=agent-D1',
            },
          },
        }],
      },
    }

    const restored = restoreConversation(session, [])
    const text = restored.turns
      .flatMap((turn) => turn.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text).toContain('"runtime_recovery_reports"')
    expect(text).toContain('runtime_recovery_report_recorded')
    expect(text).toContain('"normalized_report"')
    expect(text).toContain('normalized_runtime_recovery_report')
    expect(text).toContain('child_run_synthesis_report')
    expect(text).toContain('assistant_text')
    expect(text).toContain('child_run_synthesis_checkpoint-1')
    expect(text).toContain('AgentRunGet agentId=agent-D1')
  })

  it('derives title from first user message', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'What is the meaning of life?')
    saveSession(conv)

    const loaded = loadSession(testId)!
    expect(loaded.title).toBe('What is the meaning of life?')
  })

  it('truncates long titles', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    const longMsg = 'A'.repeat(100)
    addUserMessage(conv, longMsg)
    saveSession(conv)

    const loaded = loadSession(testId)!
    expect(loaded.title!.length).toBeLessThanOrEqual(81) // 80 chars + ellipsis
    expect(loaded.title).toContain('…')
  })

  it('listSessions returns saved sessions', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hi')
    saveSession(conv)

    const sessions = listSessions()
    const found = sessions.find((s) => s.id === testId)
    expect(found).toBeDefined()
    expect(found!.model).toBe('m')
  })

  it('deleteSession removes the file', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    saveSession(conv)
    expect(loadSession(testId)).not.toBeNull()

    const deleted = deleteSession(testId)
    expect(deleted).toBe(true)
    expect(loadSession(testId)).toBeNull()
  })

  it('deleteSession returns false for non-existent', () => {
    expect(deleteSession('doesnt-exist-123')).toBe(false)
  })

  it('restoreConversation rebuilds a Conversation object', () => {
    const conv = createConversation({ system: 'test', model: 'qwen', maxTokens: 8192 })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hello')
    saveSession(conv)

    const session = loadSession(testId)!
    const tools = [{ name: 'bash', description: 'Run cmd', input_schema: { type: 'object' } }]
    const restored = restoreConversation(session, tools)

    expect(restored.id).toBe(testId)
    expect(restored.model).toBe('qwen')
    expect(restored.maxTokens).toBe(8192)
    expect(restored.turns).toHaveLength(1)
    expect(restored.tools).toHaveLength(1)
    expect(restored.tools[0]!.name).toBe('bash')
  })

  it('persists and restores pending retry state (attempt count only)', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code', maxTokens: 8192 })
    ;(conv as any).id = testId
    addUserMessage(conv, '继续')
    conv.options = {
      pendingRetry: { attemptCount: 1 },
    }
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.pendingRetry?.attemptCount).toBe(1)

    const restored = restoreConversation(session, [])
    expect(restored.options?.pendingRetry?.attemptCount).toBe(1)
  })

  it('omits pendingRetry when conversation has no retry state', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'hi')
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.pendingRetry).toBeUndefined()

    const restored = restoreConversation(session, [])
    expect(restored.options?.pendingRetry).toBeUndefined()
  })

  it('persists and restores task execution state', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'Only touch `src/native/conversation.ts`.')
    conv.options = {
      taskState: ensureTaskExecutionState(conv, process.cwd()),
    }
    conv.options.taskState!.run.status = 'drifted'
    conv.options.taskState!.run.lastGuardReason = 'blocked example'
    saveSession(conv)

    const session = loadSession(testId)!
    expect(session.taskState?.contract.objective).toContain('Only touch')
    expect(session.taskState?.run.status).toBe('drifted')

    const restored = restoreConversation(session, [])
    expect(restored.options?.taskState?.contract.scopeMode).toBe('explicit_paths')
    expect(restored.options?.taskState?.run.lastGuardReason).toBe('blocked example')
  })

  it('persists and restores task store records so recovery tools can continue a blocked step', async () => {
    resetTaskStore()
    const artifactPath = path.join(os.tmpdir(), `owlcoda-session-task-store-${Date.now()}.txt`)
    const task = createTask({
      subject: 'Resume blocked task',
      description: 'Task recovery target must survive process resume',
      conversationId: testId,
      steps: [{
        id: 'prove-resume',
        title: 'Prove resume',
        description: 'verify artifact after resume',
        verification: [{ id: 'artifact', kind: 'file_exists', path: artifactPath }],
      }],
    })
    updateTaskStep(task.id, 'prove-resume', {
      status: 'blocked',
      failureReason: 'waiting for externally produced artifact',
    })

    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'continue blocked task')
    saveSession(conv, 'task store session')

    const loaded = loadSession(testId) as any
    expect((loaded.taskStore?.tasks ?? []).map((t: { id: string }) => t.id)).toContain(task.id)

    resetTaskStore()
    expect(getTask(task.id)).toBeUndefined()

    restoreConversation(loaded, [])

    fs.writeFileSync(artifactPath, 'ready\n')
    try {
      const verify = await createTaskVerifyTool().execute({ taskId: task.id, stepId: 'prove-resume' })
      expect(verify.isError).toBe(false)
      expect(verify.metadata?.passed).toBe(true)

      const complete = await createTaskUpdateTool().execute({
        taskId: task.id,
        stepId: 'prove-resume',
        stepStatus: 'completed',
      })
      expect(complete.isError).toBe(false)
      expect(getTask(task.id)?.steps?.[0]?.status).toBe('completed')
    } finally {
      fs.rmSync(artifactPath, { force: true })
    }
  })

  it('persists and restores Agent run records so recovery inspect commands survive resume', async () => {
    __resetAgentRunHistoryForTesting()
    restoreAgentRunHistory({
      schemaVersion: 1,
      records: [{
        agentId: 'agent-resume-1',
        description: 'Slow child audit',
        agentType: 'general-purpose',
        model: 'mimo-v2.5-pro',
        status: 'failed',
        startedAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:10:00.000Z',
        finishedAt: '2026-06-17T00:10:00.000Z',
        conversationId: testId,
        failureCategory: 'agent:watchdog_timeout',
        timeoutKind: 'idle',
        parentTaskId: 'task-1',
        parentStepId: 'step-2',
        expectedArtifacts: [{ path: '/tmp/child.md', kind: 'file', origin: 'user-external' }],
        touchedPaths: ['/tmp/partial.md'],
        outputSnippet: 'Agent incomplete: watchdog timeout while running Slow child audit.',
        longTaskSnapshot: {
          longTaskId: 'agent:agent-resume-1',
          source: 'agent',
          status: 'timeout',
          objective: 'Slow child audit',
          startedAt: '2026-06-17T00:00:00.000Z',
          updatedAt: '2026-06-17T00:10:00.000Z',
          finishedAt: '2026-06-17T00:10:00.000Z',
          conversationId: testId,
          agentId: 'agent-resume-1',
          agentType: 'general-purpose',
          model: 'mimo-v2.5-pro',
          inspectCommand: 'AgentRunGet agentId=agent-resume-1',
          parentTaskId: 'task-1',
          parentStepId: 'step-2',
          timeoutKind: 'idle',
          outputSnippet: 'Agent incomplete: watchdog timeout while running Slow child audit.',
        },
      }],
    })

    const conv = createConversation({ system: 'test', model: 'mimo-v2.5-pro' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'resume child audit')
    saveSession(conv, 'agent run session')

    const loaded = loadSession(testId) as any
    expect(loaded.agentRunStore?.records.map((record: { agentId: string }) => record.agentId)).toContain('agent-resume-1')

    __resetAgentRunHistoryForTesting()
    expect((await createAgentRunGetTool().execute({ agentId: 'agent-resume-1' })).isError).toBe(true)

    restoreConversation(loaded, [])

    const restored = await createAgentRunGetTool().execute({ agentId: 'agent-resume-1' })
    expect(restored.isError).toBe(false)
    expect(restored.output).toContain('status=failed')
    expect(restored.output).toContain('failureCategory=agent:watchdog_timeout')
    expect(restored.output).toContain('timeoutKind=idle')
    expect(restored.output).toContain('parent=task-1/step-2')
    expect(restored.metadata?.['record']).toMatchObject({
      agentId: 'agent-resume-1',
      conversationId: testId,
      status: 'failed',
      failureCategory: 'agent:watchdog_timeout',
      timeoutKind: 'idle',
    })
  })

  it('persists and restores platform job supervisor records for resume inspection', async () => {
    resetJobSupervisor()
    createJob({
      jobId: 'job:agent:agent-session-job',
      type: 'agent',
      stage: 'queued',
      tool: 'Agent',
      provider: 'mimo-v2.5-pro',
      command: 'Slow child audit',
      recoveryHint: 'AgentRunGet agentId=agent-session-job',
      source: { kind: 'agent', id: 'agent-session-job' },
    })
    startJob('job:agent:agent-session-job', {
      stage: 'running',
      externalHandle: 'agent:agent-session-job',
    })
    finishJob('job:agent:agent-session-job', 'timeout', {
      stage: 'timeout',
      terminationReason: 'agent:watchdog_timeout',
      error: 'watchdog timeout while running Slow child audit',
    })

    const conv = createConversation({ system: 'test', model: 'mimo-v2.5-pro' })
    ;(conv as any).id = testId
    addUserMessage(conv, 'resume platform job')
    saveSession(conv, 'job registry session')

    const loaded = loadSession(testId) as any
    expect(loaded.jobRegistry?.jobs.map((job: { jobId: string }) => job.jobId)).toContain('job:agent:agent-session-job')

    resetJobSupervisor()
    expect(getJob('job:agent:agent-session-job')).toBeUndefined()

    restoreConversation(loaded, [])

    const restored = await createJobGetTool().execute({ jobId: 'job:agent:agent-session-job' })
    expect(restored.isError).toBe(false)
    expect(restored.output).toContain('ID: job:agent:agent-session-job')
    expect(restored.output).toContain('Type: agent')
    expect(restored.output).toContain('Status: timeout')
    expect(restored.output).toContain('TerminationReason: agent:watchdog_timeout')
    expect((restored.metadata as any).job).toMatchObject({
      jobId: 'job:agent:agent-session-job',
      type: 'agent',
      status: 'timeout',
      source: { kind: 'agent', id: 'agent-session-job' },
      recoveryHint: 'AgentRunGet agentId=agent-session-job',
    })
  })

  it('reconstructs Agent run records from child-run checkpoints when no saved Agent store exists', async () => {
    __resetAgentRunHistoryForTesting()
    const session = {
      version: 1 as const,
      id: testId,
      model: 'mimo-v2.5-pro',
      system: 'test',
      maxTokens: 2048,
      turns: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeRecoveryLedger: {
        schemaVersion: 1 as const,
        updatedAt: '2026-06-17T00:10:00.000Z',
        checkpoints: [{
          id: 'child-run-synthesis-checkpoint-1',
          kind: 'child_run_synthesis_checkpoint' as const,
          generatedAt: '2026-06-17T00:10:00.000Z',
          conversationId: testId,
          inspectCommands: ['AgentRunGet agentId=agent-ledger-1'],
          payload: {
            schema_version: 1,
            kind: 'child_run_synthesis_checkpoint',
            generated_at: '2026-06-17T00:10:00.000Z',
            child_count: 1,
            children: [{
              agent_id: 'agent-ledger-1',
              status: 'timeout',
              description: 'Ledger-only child audit',
              failure_category: 'agent:watchdog_timeout',
              timeout_kind: 'max_runtime',
              inspect_command: 'AgentRunGet agentId=agent-ledger-1',
              parent_task_id: 'task-7',
              parent_step_id: 'step-8',
              output_snippet: 'timeout output from ledger',
            }],
          },
        }],
      },
    }

    restoreConversation(session, [])

    const restored = await createAgentRunGetTool().execute({ agentId: 'agent-ledger-1' })
    expect(restored.isError).toBe(false)
    expect(restored.output).toContain('status=failed')
    expect(restored.output).toContain('failureCategory=agent:watchdog_timeout')
    expect(restored.output).toContain('timeoutKind=max_runtime')
    expect(restored.output).toContain('parent=task-7/step-8')
    expect(restored.output).toContain('timeout output from ledger')
    expect(restored.metadata?.['record']).toMatchObject({
      agentId: 'agent-ledger-1',
      conversationId: testId,
      status: 'failed',
      failureCategory: 'agent:watchdog_timeout',
      timeoutKind: 'max_runtime',
      parentTaskId: 'task-7',
      parentStepId: 'step-8',
    })
  })

  it('sanitizes dangling assistant tool_use turns on save and restore', () => {
    const conv = createConversation({ system: 'test', model: 'qwen' })
    ;(conv as any).id = testId
    conv.turns.push(
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'edit:38', name: 'edit', input: { path: 'foo.ts' } } as any],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        timestamp: 3,
      },
    )

    saveSession(conv)
    expect(conv.turns).toHaveLength(2)
    expect(conv.turns[1]!.role).toBe('user')

    const session = loadSession(testId)!
    const restored = restoreConversation(session, [])
    expect(restored.turns).toHaveLength(2)
    expect(restored.turns.map(t => t.role)).toEqual(['user', 'user'])
  })

  it('sanitizes session ID in file path', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    ;(conv as any).id = 'bad/path/../../../etc/passwd'
    const filePath = saveSession(conv)
    // The filename portion should not contain slashes
    const filename = path.basename(filePath)
    expect(filename).not.toContain('/')
    expect(filename).toContain('bad_path')
    // Cleanup
    deleteSession('bad/path/../../../etc/passwd')
  })
})
