import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToolDispatcher } from '../../src/native/dispatch.js'
import {
  addUserMessage,
  createConversation,
  runConversationLoop,
} from '../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'

function toolUseResponse(name: string, id: string, input: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function queueResponses(responses: Response[]): void {
  let i = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const response = responses[i]
    i += 1
    if (!response) throw new Error('fetch called more times than queued responses')
    return response
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('conversation — phase event shadow recording', () => {
  it('records execute evidence followed by verification evidence', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit src/foo.ts, then audit the delivery')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub edit',
      async execute() {
        return { output: 'edited', isError: false, metadata: { path: 'src/foo.ts' } }
      },
    })
    dispatcher.register({
      name: 'DeliveryAudit',
      description: 'stub audit',
      async execute() {
        return { output: 'DeliveryAudit: clean', isError: false }
      },
    })

    queueResponses([
      toolUseResponse('edit', 'tu_edit', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }),
      toolUseResponse('DeliveryAudit', 'tu_audit', { claims: ['edited src/foo.ts'] }),
      textResponse('已完成：DeliveryAudit clean'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      maxIterations: 8,
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    expect(taskState.phaseEvents.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'tool_proposed',
      'permission_granted',
      'tool_started',
      'tool_completed',
      'post_grant_evidence',
      'verification_evidence',
      'completion_claim',
    ]))
    expect(taskState.phaseEvents).toContainEqual(expect.objectContaining({
      kind: 'post_grant_evidence',
      evidenceKind: 'touched_path',
      detail: 'src/foo.ts',
      phaseHint: 'execute',
    }))
    expect(taskState.phaseEvents).toContainEqual(expect.objectContaining({
      kind: 'verification_evidence',
      tool: 'DeliveryAudit',
      phaseHint: 'verify',
    }))
  })

  it('records a read-only review path without mutating evidence', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'read src/foo.ts and tell me if it has AI flavor; do not edit')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'stub read',
      async execute() {
        return { output: 'file contents', isError: false }
      },
    })

    queueResponses([
      toolUseResponse('read', 'tu_read', { file_path: 'src/foo.ts' }),
      textResponse('It reads naturally. No edit needed.'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      maxIterations: 6,
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    expect(taskState.phaseEvents).toContainEqual(expect.objectContaining({
      kind: 'tool_proposed',
      tool: 'read',
      phaseHint: 'explore',
    }))
    expect(taskState.phaseEvents).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      phaseHint: 'report',
    }))
    expect(taskState.phaseEvents.some((event) => event.kind === 'post_grant_evidence')).toBe(false)
    expect(taskState.proposedToolCalls.every((call) => call.riskClass === 'safe')).toBe(true)
  })
})
