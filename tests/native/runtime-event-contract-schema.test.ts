import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RUNTIME_EVENT_KINDS = [
  'turn_started',
  'assistant_stream_recorded',
  'assistant_response_recorded',
  'assistant_response_disposition_recorded',
  'item_started',
  'item_completed',
  'checkpoint_installed',
  'checkpoint_disposition_changed',
  'checkpoint_resolved',
  'runtime_intervention',
  'runtime_truth_report_recorded',
  'runtime_recovery_report_recorded',
  'turn_completed',
]

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('runtime event contract JSON schema', () => {
  it('publishes a schema artifact for external runtime event validation', () => {
    const schema = readJson(join(process.cwd(), 'schemas/runtime-event-contract.v1.schema.json'))
    const packageJson = readJson(join(process.cwd(), 'package.json'))

    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://owlcoda.dev/schemas/runtime-event-contract.v1.schema.json',
      title: 'OwlCoda Runtime Event Contract v1',
      type: 'object',
    })
    expect(schema.required).toEqual(expect.arrayContaining([
      'id',
      'seq',
      'kind',
      'at',
      'conversationId',
      'contract',
    ]))
    expect(schema.properties.kind.enum).toEqual(RUNTIME_EVENT_KINDS)
    expect(schema.properties.contract.properties.event_kind.enum).toEqual(RUNTIME_EVENT_KINDS)
    expect(schema.properties.contract.properties.payload_schema.enum).toEqual(
      RUNTIME_EVENT_KINDS.map((kind) => `${kind}.v1`),
    )
    expect(schema.$defs.normalized_runtime_recovery_report.required).toEqual(expect.arrayContaining([
      'kind',
      'checkpoint_id',
      'checkpoint_kind',
      'report_kind',
      'report_source',
      'confidence',
      'covered_ids',
    ]))
    expect(schema.$defs.context_replacement_event_metadata.required).toEqual(expect.arrayContaining([
      'input_history_digest',
      'reason',
      'window_id',
      'source_turn_id',
      'ledger_status',
      'replacement_history_turns',
    ]))
    expect(schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: { properties: { kind: { const: 'assistant_stream_recorded' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'payload']),
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining([
                'response_index',
                'source',
                'text_delta_count',
                'text_chars',
                'thinking_start_count',
                'thinking_delta_count',
                'thinking_chars',
                'thinking_end_count',
                'usage_update_count',
                'input_tokens',
                'output_tokens',
              ]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'assistant_response_recorded' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'payload']),
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining([
                'response_index',
                'phase',
                'stop_reason',
                'text_chars',
                'text_digest',
                'tool_use_count',
                'has_tool_use',
                'thinking_block_count',
                'input_tokens',
                'output_tokens',
                'is_empty_response',
              ]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'assistant_response_disposition_recorded' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'payload']),
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining([
                'response_index',
                'phase',
                'action',
                'stop_reason',
                'text_chars',
                'original_tool_use_count',
                'executed_tool_count',
                'deferred_tool_count',
                'runtime_tool_count',
              ]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'item_started' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'itemId', 'payload']),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'item_completed' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'itemId', 'payload']),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'turn_completed' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['turnId', 'payload']),
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining([
                'iterations',
                'request_count',
                'input_tokens',
                'output_tokens',
                'assistant_response_count',
                'assistant_text_chars',
                'final_text_chars',
                'tool_use_count',
                'executed_tool_count',
                'empty_response_count',
              ]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'runtime_recovery_report_recorded' } } },
        then: expect.objectContaining({
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining(['normalized_report']),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'runtime_intervention' } } },
        then: expect.objectContaining({
          required: expect.arrayContaining(['payload']),
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining(['intervention_kind']),
              allOf: expect.arrayContaining([
                expect.objectContaining({
                  if: {
                    properties: {
                      intervention_kind: { const: 'recovery_guard_hard_stop' },
                    },
                  },
                  then: expect.objectContaining({
                    required: expect.arrayContaining([
                      'action',
                      'guard_kind',
                      'stop_reason',
                      'ignored_tool_count',
                      'response_index',
                      'reason',
                    ]),
                  }),
                }),
                expect.objectContaining({
                  if: {
                    properties: {
                      intervention_kind: { const: 'long_task_wait_policy' },
                    },
                  },
                  then: expect.objectContaining({
                    required: expect.arrayContaining([
                      'action',
                      'tool_use_id',
                      'tool_name',
                      'long_task_id',
                      'wait_strategy',
                      'stop_polling',
                      'next_check_command',
                      'reason',
                    ]),
                  }),
                }),
                expect.objectContaining({
                  if: {
                    properties: {
                      intervention_kind: { const: 'post_recovery_overrun_guard' },
                    },
                  },
                  then: expect.objectContaining({
                    required: expect.arrayContaining([
                      'action',
                      'tool_use_id',
                      'tool_name',
                      'task_id',
                      'checkpoint_id',
                      'requested_status_field',
                      'requested_status',
                      'ledger_status',
                      'recovery_resolved_this_run',
                      'scope',
                      'reason',
                    ]),
                  }),
                }),
                expect.objectContaining({
                  if: {
                    properties: {
                      intervention_kind: { const: 'runtime_truth_resume_report_gate' },
                    },
                  },
                  then: expect.objectContaining({
                    required: expect.arrayContaining([
                      'action',
                      'report_source',
                      'checkpoint_id',
                    ]),
                  }),
                }),
              ]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: { properties: { kind: { const: 'checkpoint_resolved' } } },
        then: expect.objectContaining({
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining(['checkpoint_id', 'checkpoint_kind', 'disposition']),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        if: {
          properties: {
            kind: { const: 'checkpoint_installed' },
            checkpointKind: { const: 'context_replacement_checkpoint' },
          },
        },
        then: expect.objectContaining({
          properties: expect.objectContaining({
            payload: expect.objectContaining({
              required: expect.arrayContaining(['context_replacement']),
              properties: expect.objectContaining({
                context_replacement: expect.objectContaining({
                  $ref: '#/$defs/context_replacement_event_metadata',
                }),
              }),
            }),
          }),
        }),
      }),
    ]))
    expect(packageJson.files).toContain('schemas/')
  })
})
