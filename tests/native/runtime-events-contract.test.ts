import { describe, expect, it } from 'vitest'

import { createConversation } from '../../src/native/conversation.js'
import {
  appendRuntimeEvent,
  buildRuntimeTruthResumeFallbackReport,
  buildRuntimeTruthResumePrompt,
  recordRuntimeAutoRetrySuppressionEvent,
  recordRuntimeTruthResumeReportEvent,
  recordRuntimeRecoveryTextFallbackReportEvent,
  reconstructRuntimeTruthFromEvents,
  serializeRuntimeInterventionsFromEvents,
} from '../../src/native/runtime-events.js'

describe('runtime event contract', () => {
  it('attaches a versioned contract to newly appended runtime events', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    const event = appendRuntimeEvent(conv, {
      kind: 'checkpoint_disposition_changed',
      checkpointId: 'long_task_checkpoint-1',
      checkpointKind: 'long_task_checkpoint',
      payload: {
        checkpoint_id: 'long_task_checkpoint-1',
        checkpoint_kind: 'long_task_checkpoint',
        previous_disposition: 'active',
        disposition: 'acknowledged',
        reason: 'Model reported the checkpoint state.',
      },
    })

    expect((event as any).contract).toMatchObject({
      schema_version: 1,
      kind: 'runtime_event_contract',
      event_kind: 'checkpoint_disposition_changed',
      payload_schema: 'checkpoint_disposition_changed.v1',
      validation_status: 'valid',
    })
    expect((conv.options?.runtimeEventLog?.events[0] as any)?.contract).toEqual((event as any).contract)
  })

  it('rejects new recovery report events that lack the normalized report contract payload', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    expect(() => appendRuntimeEvent(conv, {
      kind: 'runtime_recovery_report_recorded',
      checkpointId: 'long_task_checkpoint-1',
      checkpointKind: 'long_task_checkpoint',
      payload: {
        report_kind: 'long_task_checkpoint_report',
        report_source: 'assistant_text',
        report: {
          kind: 'long_task_checkpoint_report',
          checkpoint_id: 'long_task_checkpoint-1',
        },
      },
    })).toThrow(/normalized_report/)
    expect(conv.options?.runtimeEventLog?.events ?? []).toHaveLength(0)
  })

  it('rejects new item lifecycle events that lack the owning turn id', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    expect(() => appendRuntimeEvent(conv, {
      kind: 'item_started',
      itemId: 'toolu-1',
      payload: { tool_name: 'ProbeTool' },
    })).toThrow(/turnId/)
    expect(() => appendRuntimeEvent(conv, {
      kind: 'item_completed',
      itemId: 'toolu-1',
      payload: { tool_name: 'ProbeTool', is_error: false },
    })).toThrow(/turnId/)
    expect(conv.options?.runtimeEventLog?.events ?? []).toHaveLength(0)
  })

  it('rejects new turn completion events that lack response summary fields', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    expect(() => appendRuntimeEvent(conv, {
      kind: 'turn_completed',
      turnId: 'turn-1',
      payload: { iterations: 1 },
    })).toThrow(/response/)
    expect(conv.options?.runtimeEventLog?.events ?? []).toHaveLength(0)
  })

  it('rejects new context replacement checkpoint install events without replay metadata', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    expect(() => appendRuntimeEvent(conv, {
      kind: 'checkpoint_installed',
      checkpointId: 'context_replacement_checkpoint-1',
      checkpointKind: 'context_replacement_checkpoint',
      payload: {
        checkpoint_id: 'context_replacement_checkpoint-1',
        checkpoint_kind: 'context_replacement_checkpoint',
        disposition: 'active',
      },
    })).toThrow(/context_replacement/)
    expect(conv.options?.runtimeEventLog?.events ?? []).toHaveLength(0)
  })

  it('accepts recorder-generated fallback recovery report events as contract-valid', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    const event = recordRuntimeRecoveryTextFallbackReportEvent(conv, {
      checkpointId: 'long_task_checkpoint-1',
      checkpointKind: 'long_task_checkpoint',
      reportKind: 'long_task_checkpoint_text_fallback',
      text: 'task:task-1 is still running; inspect with TaskOutput task_id=task-1 block=false',
      coveredIds: ['task:task-1'],
      inspectCommands: ['TaskOutput task_id=task-1 block=false'],
    })

    expect((event as any).contract).toMatchObject({
      schema_version: 1,
      kind: 'runtime_event_contract',
      event_kind: 'runtime_recovery_report_recorded',
      payload_schema: 'runtime_recovery_report_recorded.v1',
      validation_status: 'valid',
    })
    expect((event.payload?.['normalized_report'] as any)?.kind).toBe('normalized_runtime_recovery_report')
  })

  it('surfaces replay-time event contract diagnostics in runtime truth resume snapshots', () => {
    const runtimeRecoveryLedger = {
      schemaVersion: 1 as const,
      updatedAt: '2026-06-19T09:00:05.000Z',
      checkpoints: [{
        id: 'context_replacement_checkpoint-1',
        kind: 'context_replacement_checkpoint' as const,
        generatedAt: '2026-06-19T09:00:00.000Z',
        conversationId: 'conv-event-contract-diagnostics',
        disposition: 'active' as const,
        payload: {
          context_replacement: {
            input_history_digest: 'sha256:event-contract-diagnostics',
            reason: 'event contract diagnostics test',
            replacement_history: [{
              role: 'user' as const,
              content: [{ type: 'text' as const, text: 'resume from runtime truth' }],
              timestamp: 1,
            }],
          },
        },
        inspectCommands: [],
      }],
    }
    const reconstruction = reconstructRuntimeTruthFromEvents({
      runtimeRecoveryLedger,
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T09:00:05.000Z',
        nextSeq: 5,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed',
          at: '2026-06-19T09:00:00.000Z',
          conversationId: 'conv-event-contract-diagnostics',
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint',
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_intervention',
          at: '2026-06-19T09:00:01.000Z',
          conversationId: 'conv-event-contract-diagnostics',
          payload: { intervention_kind: 'long_task_wait_policy' },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'runtime_intervention.v1',
            validation_status: 'valid',
          },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'runtime_recovery_report_recorded',
          at: '2026-06-19T09:00:02.000Z',
          conversationId: 'conv-event-contract-diagnostics',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            report_kind: 'long_task_checkpoint_report',
            report_source: 'assistant_text',
            report: {
              kind: 'long_task_checkpoint_report',
              checkpoint_id: 'long_task_checkpoint-1',
              checkpoint_kind: 'long_task_checkpoint',
              long_task_id: 'task:legacy-report',
              inspect_command: 'LongTaskGet longTaskId=task:legacy-report',
            },
          },
        }, {
          id: 'runtime_event-4',
          seq: 4,
          kind: 'checkpoint_resolved',
          at: '2026-06-19T09:00:03.000Z',
          conversationId: 'conv-event-contract-diagnostics',
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            checkpoint_id: 'long_task_checkpoint-1',
            checkpoint_kind: 'long_task_checkpoint',
          },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'checkpoint_resolved.v1',
            validation_status: 'valid',
          },
        }],
      },
    })

    const prompt = buildRuntimeTruthResumePrompt(reconstruction, runtimeRecoveryLedger)
    const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt ?? '')?.[1] ?? '{}')

    expect(payload.event_contract_diagnostics).toMatchObject({
      schema_version: 1,
      kind: 'runtime_event_contract_diagnostics',
      valid_event_count: 1,
      legacy_event_count: 1,
      malformed_event_count: 1,
    })
    expect(payload.event_contract_diagnostics.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        seq: 2,
        event_kind: 'runtime_intervention',
        status: 'contract_valid',
        payload_schema: 'runtime_intervention.v1',
      }),
      expect.objectContaining({
        seq: 3,
        event_kind: 'runtime_recovery_report_recorded',
        status: 'legacy_replay_compatible',
        payload_schema: 'runtime_recovery_report_recorded.legacy-normalized.v1',
      }),
      expect.objectContaining({
        seq: 4,
        event_kind: 'checkpoint_resolved',
        status: 'malformed_saved_event',
        validation_errors: expect.arrayContaining([
          'contract.event_kind:mismatch',
          'payload.disposition',
        ]),
      }),
    ]))
  })

  it('preserves event contract diagnostics in runtime synthetic resume fallback reports', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    ;(conv as any).options = {
      runtimeTruthResume: {
        checkpointId: 'context_replacement_checkpoint-1',
        promptInjectedAt: '2026-06-19T09:10:00.000Z',
        reportGate: 'pending',
      },
      runtimeRecoveryLedger: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T09:10:05.000Z',
        checkpoints: [{
          id: 'context_replacement_checkpoint-1',
          kind: 'context_replacement_checkpoint',
          generatedAt: '2026-06-19T09:10:00.000Z',
          conversationId: conv.id,
          disposition: 'active',
          payload: {
            context_replacement: {
              input_history_digest: 'sha256:fallback-event-contract-diagnostics',
              reason: 'fallback diagnostics test',
              replacement_history: [{
                role: 'user',
                content: [{ type: 'text', text: 'resume from runtime truth' }],
                timestamp: 1,
              }],
            },
          },
          inspectCommands: [],
        }],
      },
      runtimeEventLog: {
        schemaVersion: 1,
        updatedAt: '2026-06-19T09:10:05.000Z',
        nextSeq: 4,
        events: [{
          id: 'runtime_event-1',
          seq: 1,
          kind: 'checkpoint_installed',
          at: '2026-06-19T09:10:00.000Z',
          conversationId: conv.id,
          checkpointId: 'context_replacement_checkpoint-1',
          checkpointKind: 'context_replacement_checkpoint',
          payload: { checkpoint_id: 'context_replacement_checkpoint-1' },
        }, {
          id: 'runtime_event-2',
          seq: 2,
          kind: 'runtime_intervention',
          at: '2026-06-19T09:10:01.000Z',
          conversationId: conv.id,
          payload: { intervention_kind: 'long_task_wait_policy' },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'runtime_intervention.v1',
            validation_status: 'valid',
          },
        }, {
          id: 'runtime_event-3',
          seq: 3,
          kind: 'checkpoint_resolved',
          at: '2026-06-19T09:10:02.000Z',
          conversationId: conv.id,
          checkpointId: 'long_task_checkpoint-1',
          checkpointKind: 'long_task_checkpoint',
          payload: {
            checkpoint_id: 'long_task_checkpoint-1',
            checkpoint_kind: 'long_task_checkpoint',
          },
          contract: {
            schema_version: 1,
            kind: 'runtime_event_contract',
            event_kind: 'runtime_intervention',
            payload_schema: 'checkpoint_resolved.v1',
            validation_status: 'valid',
          },
        }],
      },
    }

    const fallback = buildRuntimeTruthResumeFallbackReport(conv)
    const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(fallback ?? '')?.[1] ?? '{}')

    expect(payload.event_contract_diagnostics).toMatchObject({
      kind: 'runtime_event_contract_diagnostics',
      valid_event_count: 1,
      malformed_event_count: 1,
    })
    expect(payload.event_contract_diagnostics.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        seq: 3,
        status: 'malformed_saved_event',
        validation_errors: expect.arrayContaining(['contract.event_kind:mismatch']),
      }),
    ]))
  })

  it('keeps event contract diagnostics when recording runtime truth reports', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    const text = JSON.stringify({
      schema_version: 1,
      kind: 'runtime_truth_resume_report',
      source: 'runtime_event_log',
      checkpoint_id: 'context_replacement_checkpoint-1',
      checkpoint_kind: 'context_replacement_checkpoint',
      input_history_digest: 'sha256:recorded-diagnostics',
      ignored_stale_transcript: true,
      stale_transcript_trusted: false,
      suffix_event_kinds: ['runtime_intervention'],
      runtime_interventions: [],
      runtime_closures: [],
      runtime_truth_reports: [],
      runtime_recovery_reports: [],
      checkpoint_dispositions: [],
      unresolved_checkpoints: [],
      next_action: 'continue from runtime truth',
      event_contract_diagnostics: {
        schema_version: 1,
        kind: 'runtime_event_contract_diagnostics',
        source: 'runtime_event_log',
        valid_event_count: 1,
        legacy_event_count: 1,
        malformed_event_count: 1,
        events: [{
          seq: 4,
          event_id: 'runtime_event-4',
          event_kind: 'checkpoint_resolved',
          status: 'malformed_saved_event',
          validation_errors: ['contract.event_kind:mismatch'],
        }],
      },
    })

    const event = recordRuntimeTruthResumeReportEvent(conv, {
      checkpointId: 'context_replacement_checkpoint-1',
      reportSource: 'runtime_synthetic',
      text,
    })

    expect((event?.payload?.['report'] as any)?.event_contract_diagnostics).toMatchObject({
      kind: 'runtime_event_contract_diagnostics',
      malformed_event_count: 1,
    })
  })

  it('serializes tool execution plan deferral fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:00:00.000Z',
      conversationId: 'conv-tool-plan',
      payload: {
        intervention_kind: 'tool_execution_plan_deferral',
        action: 'deferred_tool_calls',
        plan_kind: 'summary_gate',
        original_tool_count: 6,
        executed_tool_count: 4,
        deferred_tool_count: 2,
        requires_next_response_summary: true,
        reason: 'Summary gate: batched 4 exploratory tools and deferred 2 more until the assistant summarizes',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'tool_execution_plan_deferral',
      source: 'runtime_event_log',
      event_id: 'runtime_event-1',
      plan_kind: 'summary_gate',
      original_tool_count: 6,
      executed_tool_count: 4,
      deferred_tool_count: 2,
      requires_next_response_summary: true,
    })])
  })

  it('serializes task no-progress decision fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:05:00.000Z',
      conversationId: 'conv-no-progress',
      payload: {
        intervention_kind: 'task_no_progress_decision',
        action: 'continued_with_advisory',
        decision: 'suppressed_advisory',
        iteration: 9,
        touched_path_count: 0,
        hard_stop_enabled: false,
        would_have_hard_stopped: true,
        reason: 'default advisory mode at 9 iterations',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'task_no_progress_decision',
      action: 'continued_with_advisory',
      decision: 'suppressed_advisory',
      iteration: 9,
      touched_path_count: 0,
      hard_stop_enabled: false,
      would_have_hard_stopped: true,
    })])
  })

  it('serializes production gate nudge fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:10:00.000Z',
      conversationId: 'conv-production-gate',
      payload: {
        intervention_kind: 'production_gate_nudge',
        action: 'injected_runtime_prompt',
        gate_kind: 'production_gate',
        prompt_marker: '[Runtime production gate]',
        iteration: 5,
        distinct_files_read: 3,
        touched_path_count: 0,
        task_write_scope_present: false,
        deliverable_mode: 'file_artifact_delivery',
        deliverable_confidence: 'high',
        requires_durable_artifact: true,
        reason: '3 distinct files read across 5 iterations under a durable-artifact task with 0 touched paths.',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'production_gate_nudge',
      action: 'injected_runtime_prompt',
      gate_kind: 'production_gate',
      prompt_marker: '[Runtime production gate]',
      iteration: 5,
      distinct_files_read: 3,
      touched_path_count: 0,
      task_write_scope_present: false,
      deliverable_mode: 'file_artifact_delivery',
      deliverable_confidence: 'high',
      requires_durable_artifact: true,
    })])
  })

  it('serializes context-pressure nudge fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:12:00.000Z',
      conversationId: 'conv-context-pressure',
      payload: {
        intervention_kind: 'context_pressure_nudge',
        action: 'injected_runtime_prompt',
        prompt_marker: '[Runtime context-pressure check]',
        context_pressure_mode: 'soft',
        context_pressure_threshold: 0.6,
        threshold_percent: 60,
        usage_ratio: 0.62,
        usage_percent: 62,
        total_tokens: 6200,
        context_window: 10000,
        reason: 'Context usage crossed 60%.',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'context_pressure_nudge',
      action: 'injected_runtime_prompt',
      prompt_marker: '[Runtime context-pressure check]',
      context_pressure_mode: 'soft',
      context_pressure_threshold: 0.6,
      threshold_percent: 60,
      usage_ratio: 0.62,
      usage_percent: 62,
      total_tokens: 6200,
      context_window: 10000,
    })])
  })

  it('serializes schema-fail short-circuit fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:13:00.000Z',
      conversationId: 'conv-schema-fail',
      itemId: 'tool-2',
      payload: {
        intervention_kind: 'schema_fail_short_circuit',
        action: 'stopped',
        stop_reason: 'tool_loop',
        tool_name: 'write',
        tool_use_id: 'tool-2',
        schema_failure_key: 'write:content,path',
        missing_fields: ['content', 'path'],
        prior_failure_count: 1,
        current_failure_count: 2,
        reason: 'task stuck on repeated schema failures',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'schema_fail_short_circuit',
      action: 'stopped',
      stop_reason: 'tool_loop',
      tool_name: 'write',
      tool_use_id: 'tool-2',
      schema_failure_key: 'write:content,path',
      missing_fields: ['content', 'path'],
      prior_failure_count: 1,
      current_failure_count: 2,
    })])
  })

  it('serializes runtime auto-retry suppression fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:14:00.000Z',
      conversationId: 'conv-runtime-retry',
      payload: {
        intervention_kind: 'runtime_auto_retry_suppression',
        action: 'suppressed_auto_resume',
        auto_retry_surface: 'headless_runtime_resume',
        suppression_reason: 'failure_kind_suppressed',
        failure_kind: 'timeout',
        failure_phase: 'request',
        retryable: true,
        runtime_retries: 0,
        retry_limit: '8',
        reason: 'Automatic runtime resume suppressed for timeout.',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'runtime_auto_retry_suppression',
      action: 'suppressed_auto_resume',
      auto_retry_surface: 'headless_runtime_resume',
      suppression_reason: 'failure_kind_suppressed',
      failure_kind: 'timeout',
      failure_phase: 'request',
      retryable: true,
      runtime_retries: 0,
      retry_limit: '8',
    })])
  })

  it('serializes context compaction result fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-21T10:00:00.000Z',
      conversationId: 'conv-context-compaction-result',
      checkpointId: 'context_replacement_checkpoint-1',
      checkpointKind: 'context_replacement_checkpoint',
      payload: {
        intervention_kind: 'context_compaction_result',
        action: 'context_compaction_fallback',
        compaction_reason: 'threshold',
        compaction_method: 'truncation',
        fallback_reason: 'llm_compact_failed',
        before_turns: 10,
        after_turns: 4,
        before_tokens: 1000,
        after_tokens: 400,
        llm_attempted: true,
        llm_ms: 12,
        llm_compact_failure_count: 1,
        context_replacement_checkpoint_id: 'context_replacement_checkpoint-1',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'context_compaction_result',
      source: 'runtime_event_log',
      event_id: 'runtime_event-1',
      checkpoint_id: 'context_replacement_checkpoint-1',
      checkpoint_kind: 'context_replacement_checkpoint',
      action: 'context_compaction_fallback',
      compaction_reason: 'threshold',
      compaction_method: 'truncation',
      fallback_reason: 'llm_compact_failed',
      before_turns: 10,
      after_turns: 4,
      before_tokens: 1000,
      after_tokens: 400,
      llm_attempted: true,
      llm_ms: 12,
      llm_compact_failure_count: 1,
      context_replacement_checkpoint_id: 'context_replacement_checkpoint-1',
    })])
  })

  it('records runtime auto-retry suppression events with a reusable recorder', () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })

    const event = recordRuntimeAutoRetrySuppressionEvent(conv, {
      surface: 'interactive_repl_auto_retry',
      runtimeFailure: {
        kind: 'empty_provider_response',
        phase: 'request',
        retryable: true,
      },
      suppressionReason: 'failure_kind_suppressed',
      runtimeRetries: 0,
      retryLimit: 8,
      suppressedAutoResumeKind: 'empty_provider_response',
    })

    expect(event).toMatchObject({
      kind: 'runtime_intervention',
      payload: expect.objectContaining({
        intervention_kind: 'runtime_auto_retry_suppression',
        action: 'suppressed_auto_resume',
        auto_retry_surface: 'interactive_repl_auto_retry',
        suppression_reason: 'failure_kind_suppressed',
        failure_kind: 'empty_provider_response',
        failure_phase: 'request',
        retryable: true,
        runtime_retries: 0,
        retry_limit: '8',
        suppressed_auto_resume_kind: 'empty_provider_response',
      }),
    })

    expect(serializeRuntimeInterventionsFromEvents(conv.options?.runtimeEventLog?.events)).toEqual([
      expect.objectContaining({
        kind: 'runtime_auto_retry_suppression',
        auto_retry_surface: 'interactive_repl_auto_retry',
        suppression_reason: 'failure_kind_suppressed',
        failure_kind: 'empty_provider_response',
      }),
    ])
  })

  it('serializes max-tokens continuation nudge fields from runtime intervention events', () => {
    const summaries = serializeRuntimeInterventionsFromEvents([{
      id: 'runtime_event-1',
      seq: 1,
      kind: 'runtime_intervention',
      at: '2026-06-19T11:15:00.000Z',
      conversationId: 'conv-max-tokens',
      payload: {
        intervention_kind: 'max_tokens_continuation_nudge',
        action: 'injected_runtime_prompt',
        prompt_marker: '[Runtime max-tokens continuation]',
        stop_reason: 'max_tokens',
        consecutive_truncations: 2,
        inject_count: 2,
        inject_limit: 2,
        response_text_chars: 4096,
        reason: 'Assistant response hit stop_reason=max_tokens; injected continuation prompt 2/2.',
      },
    }])

    expect(summaries).toEqual([expect.objectContaining({
      kind: 'max_tokens_continuation_nudge',
      action: 'injected_runtime_prompt',
      prompt_marker: '[Runtime max-tokens continuation]',
      stop_reason: 'max_tokens',
      consecutive_truncations: 2,
      inject_count: 2,
      inject_limit: 2,
      response_text_chars: 4096,
    })])
  })
})
