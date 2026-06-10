// tests/native/conversation-shadow-record.test.ts
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
    const r = responses[i++]
    if (!r) throw new Error('fetch called more times than queued responses')
    return r
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('conversation — shadow recording (Slice 1)', () => {
  it('records a proposed edit with permissionState=granted when callback approves', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit /tmp/x.md to add a line')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute(_input) {
        return { output: 'edited /tmp/x.md', isError: false, metadata: { path: '/tmp/x.md' } }
      },
    })

    queueResponses([
      toolUseResponse('edit', 'tu_1', {
        file_path: '/tmp/x.md',
        old_string: 'a',
        new_string: 'b',
      }),
      textResponse('done'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: {
        onToolApproval: vi.fn().mockResolvedValue(true),
      },
    })

    // Read the live state captured during the loop. ensureTaskExecutionState()
    // re-derives a fresh state when the conversation's source-turn hash has
    // changed (e.g. runtime task-step nudges appended). The live reference on
    // conversation.options.taskState is the same object the dispatch loop
    // wrote to.
    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    expect(taskState.proposedToolCalls).toHaveLength(1)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.tool).toBe('edit')
    expect(tc.permissionState).toBe('granted')
    expect(tc.grantEvent?.mode).toBe('user_prompt')
    expect(tc.toolUseId).toBe('tu_1')
    expect(tc.riskClass).toBe('external_effect') // /tmp is outside cwd
  })

  it('records permissionState=denied when callback rejects', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit /tmp/x.md')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'should not run', isError: false }
      },
    })
    queueResponses([
      toolUseResponse('edit', 'tu_1', { file_path: '/tmp/x.md', old_string: 'a', new_string: 'b' }),
      textResponse('giving up'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(false) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.permissionState).toBe('denied')
    expect(tc.grantEvent).toBeUndefined()
  })

  it('records permissionState=not_needed for safe tools; callback not consulted', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'read /tmp/x.md')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'stub',
      async execute() {
        return { output: 'file contents', isError: false }
      },
    })
    const approveSpy = vi.fn().mockResolvedValue(true)
    queueResponses([
      toolUseResponse('read', 'tu_1', { file_path: '/tmp/x.md' }),
      textResponse('done reading'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: approveSpy },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.permissionState).toBe('not_needed')
    expect(approveSpy).not.toHaveBeenCalled()
  })

  it('records auto_approve grant mode when no onToolApproval callback is registered', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit /tmp/x.md')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'edited', isError: false, metadata: { path: '/tmp/x.md' } }
      },
    })
    queueResponses([
      toolUseResponse('edit', 'tu_1', { file_path: '/tmp/x.md', old_string: 'a', new_string: 'b' }),
      textResponse('done'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: {}, // no onToolApproval
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.permissionState).toBe('granted')
    expect(tc.grantEvent?.mode).toBe('auto_approve')
  })
})

describe('conversation — shadow record execution lifecycle (Slice 1)', () => {
  it('records startedAtIter and completedAtIter for a granted edit', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit /tmp/x.md')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'edited', isError: false, metadata: { path: '/tmp/x.md' } }
      },
    })
    queueResponses([
      toolUseResponse('edit', 'tu_1', { file_path: '/tmp/x.md', old_string: 'a', new_string: 'b' }),
      textResponse('done'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.startedAtIter).toBeTypeOf('number')
    expect(tc.completedAtIter).toBeTypeOf('number')
  })

  it('records touched_path evidence when edit writes a file within the cwd write scope', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit src/foo.ts')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'edited', isError: false, metadata: { path: 'src/foo.ts' } }
      },
    })
    queueResponses([
      toolUseResponse('edit', 'tu_1', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }),
      textResponse('done'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.postGrantEvidence).toContainEqual(
      expect.objectContaining({ kind: 'touched_path', detail: 'src/foo.ts' }),
    )
  })

  it('records tool_completion evidence for WebFetch (external_effect, no fs write)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'fetch https://example.com')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'WebFetch',
      description: 'stub',
      async execute() {
        return { output: 'fetched', isError: false }
      },
    })
    queueResponses([
      toolUseResponse('WebFetch', 'tu_1', { url: 'https://example.com', prompt: 'summarize' }),
      textResponse('summary'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.postGrantEvidence).toContainEqual(
      expect.objectContaining({ kind: 'tool_completion' }),
    )
  })

  it('does NOT record evidence when tool returns isError=true', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit src/missing.ts')
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'file not found', isError: true }
      },
    })
    queueResponses([
      toolUseResponse('edit', 'tu_1', { file_path: 'src/missing.ts', old_string: 'a', new_string: 'b' }),
      textResponse('failed'),
    ])

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = conv.options?.taskState ?? ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls[0]!
    expect(tc.startedAtIter).toBeTypeOf('number')
    expect(tc.completedAtIter).toBeTypeOf('number')
    expect(tc.postGrantEvidence).toEqual([])
  })
})
