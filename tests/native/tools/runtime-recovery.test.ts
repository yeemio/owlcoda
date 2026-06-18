import { describe, expect, it } from 'vitest'

import {
  createRuntimeRecoveryGetTool,
  createRuntimeRecoveryListTool,
} from '../../../src/native/tools/runtime-recovery.js'
import type { RuntimeRecoveryLedger } from '../../../src/native/protocol/types.js'

const ledger: RuntimeRecoveryLedger = {
  schemaVersion: 1,
  updatedAt: '2026-06-17T00:00:01.000Z',
  lastPromptedAt: '2026-06-17T00:00:01.000Z',
  checkpoints: [{
    id: 'blocked_task_checkpoint-1',
    kind: 'blocked_task_checkpoint',
    generatedAt: '2026-06-17T00:00:01.000Z',
    conversationId: 'conv-test',
    inspectCommands: ['TaskGet taskId=task-1'],
    payload: {
      schema_version: 1,
      kind: 'blocked_task_checkpoint',
      blocked_task: {
        task_id: 'task-1',
        step_id: 'prove-ledger',
        status: 'blocked',
        inspect_command: 'TaskGet taskId=task-1',
      },
    },
  }],
}

describe('RuntimeRecoveryList tool', () => {
  it('returns an empty read-only list when no ledger is available', async () => {
    const result = await createRuntimeRecoveryListTool().execute({})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('No unresolved runtime recovery checkpoints')
    expect(result.metadata?.['checkpoints']).toEqual([])
  })

  it('lists durable runtime recovery checkpoints from the current conversation context', async () => {
    const result = await createRuntimeRecoveryListTool().execute({}, { runtimeRecoveryLedger: ledger })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('blocked_task_checkpoint-1')
    expect(result.output).toContain('blocked_task_checkpoint')
    expect(result.output).toContain('TaskGet taskId=task-1')
    expect(result.metadata?.['checkpoints']).toEqual(ledger.checkpoints)
  })

  it('lists unresolved checkpoints by default and includes resolved history only on request', async () => {
    const historicalLedger: RuntimeRecoveryLedger = {
      ...ledger,
      checkpoints: [
        {
          ...ledger.checkpoints[0]!,
          disposition: 'resolved',
          dispositionUpdatedAt: '2026-06-17T00:00:02.000Z',
          dispositionReason: 'Task step completed.',
          payload: {
            ...ledger.checkpoints[0]!.payload,
            blocked_task: {
              task_id: 'task-1',
              step_id: 'resolved-step',
              status: 'blocked',
              inspect_command: 'TaskGet taskId=task-1',
            },
          },
        },
        {
          ...ledger.checkpoints[0]!,
          id: 'blocked_task_checkpoint-2',
          disposition: 'active',
          payload: {
            ...ledger.checkpoints[0]!.payload,
            blocked_task: {
              task_id: 'task-2',
              step_id: 'active-step',
              status: 'blocked',
              inspect_command: 'TaskGet taskId=task-2',
            },
          },
        },
      ],
    }

    const unresolved = await createRuntimeRecoveryListTool().execute({}, { runtimeRecoveryLedger: historicalLedger })
    const all = await createRuntimeRecoveryListTool().execute({ includeResolved: true }, { runtimeRecoveryLedger: historicalLedger })

    expect(unresolved.output).toContain('active-step')
    expect(unresolved.output).not.toContain('resolved-step')
    expect(unresolved.metadata?.['checkpoints']).toEqual([historicalLedger.checkpoints[1]])
    expect(all.output).toContain('active-step')
    expect(all.output).toContain('resolved-step')
    expect(all.output).toContain('disposition=resolved')
  })

  it('labels long-task replacement checkpoints with original and replacement targets', async () => {
    const replacementLedger: RuntimeRecoveryLedger = {
      schemaVersion: 1,
      updatedAt: '2026-06-18T00:00:01.000Z',
      checkpoints: [{
        id: 'long_task_replacement_checkpoint-1',
        kind: 'long_task_replacement_checkpoint',
        generatedAt: '2026-06-18T00:00:01.000Z',
        conversationId: 'conv-test',
        disposition: 'active',
        inspectCommands: [
          'LongTaskGet longTaskId=task:task-2',
          'TaskOutput task_id=task-2 block=false',
        ],
        payload: {
          schema_version: 1,
          kind: 'long_task_replacement_checkpoint',
          replacement: {
            original_long_task_id: 'task:task-1',
            replacement_long_task_id: 'task:task-2',
            replacement_task_id: 'task-2',
            status: 'started',
            inspect_command: 'LongTaskGet longTaskId=task:task-2',
            output_command: 'TaskOutput task_id=task-2 block=false',
          },
        },
      }],
    }

    const result = await createRuntimeRecoveryListTool().execute({}, { runtimeRecoveryLedger: replacementLedger })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('long_task_replacement_checkpoint-1')
    expect(result.output).toContain('kind=long_task_replacement_checkpoint')
    expect(result.output).toContain('target=task:task-1->task:task-2')
    expect(result.output).toContain('TaskOutput task_id=task-2 block=false')
  })
})

describe('RuntimeRecoveryGet tool', () => {
  it('returns one durable runtime recovery checkpoint by id', async () => {
    const result = await createRuntimeRecoveryGetTool().execute(
      { checkpointId: 'blocked_task_checkpoint-1' },
      { runtimeRecoveryLedger: ledger },
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('ID: blocked_task_checkpoint-1')
    expect(result.output).toContain('Kind: blocked_task_checkpoint')
    expect(result.output).toContain('Inspect commands:')
    expect(result.output).toContain('TaskGet taskId=task-1')
    expect(result.output).toContain('"task_id": "task-1"')
    expect(result.metadata?.['checkpoint']).toEqual(ledger.checkpoints[0])
  })

  it('validates checkpoint id input and reports not found without mutation', async () => {
    const missingId = await createRuntimeRecoveryGetTool().execute(
      { checkpointId: '' },
      { runtimeRecoveryLedger: ledger },
    )
    const notFound = await createRuntimeRecoveryGetTool().execute(
      { checkpointId: 'missing' },
      { runtimeRecoveryLedger: ledger },
    )

    expect(missingId.isError).toBe(true)
    expect(missingId.output).toContain('checkpointId is required')
    expect(notFound.isError).toBe(true)
    expect(notFound.output).toContain('not found')
  })
})
