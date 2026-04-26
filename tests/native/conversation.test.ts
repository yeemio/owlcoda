import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createConversation,
  addUserMessage,
  isRetryableError,
  autoCompact,
  runConversationLoop,
  classifyConversationRuntimeFailure,
  shouldShowNoResponseFallback,
} from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { ProviderRequestError } from '../../src/provider-error.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Native Conversation', () => {
  it('creates a conversation with expected defaults', () => {
    const conv = createConversation({
      system: 'You are helpful.',
      model: 'test-model',
    })
    expect(conv.id).toMatch(/^conv-/)
    expect(conv.system).toBe('You are helpful.')
    expect(conv.model).toBe('test-model')
    expect(conv.maxTokens).toBe(4096)
    expect(conv.turns).toHaveLength(0)
    expect(conv.tools).toEqual([])
  })

  it('creates a conversation with custom maxTokens', () => {
    const conv = createConversation({
      system: 'Test',
      model: 'test-model',
      maxTokens: 8192,
    })
    expect(conv.maxTokens).toBe(8192)
  })

  it('adds a user message to conversation', () => {
    const conv = createConversation({
      system: 'Test',
      model: 'test-model',
    })
    addUserMessage(conv, 'Hello world')
    expect(conv.turns).toHaveLength(1)
    expect(conv.turns[0]!.role).toBe('user')
    expect(conv.turns[0]!.content).toEqual([
      { type: 'text', text: 'Hello world' },
    ])
    expect(conv.turns[0]!.timestamp).toBeGreaterThan(0)
  })

  it('generates unique conversation IDs', () => {
    const ids = new Set(
      Array.from({ length: 10 }, () =>
        createConversation({ system: '', model: 'm' }).id,
      ),
    )
    expect(ids.size).toBe(10)
  })

  it('preserves tools in conversation', () => {
    const tools = [
      {
        name: 'bash',
        description: 'Run command',
        input_schema: { type: 'object', properties: {} },
      },
    ]
    const conv = createConversation({
      system: '',
      model: 'm',
      tools,
    })
    expect(conv.tools).toHaveLength(1)
    expect(conv.tools[0]!.name).toBe('bash')
  })

  it('adds multiple turns', () => {
    const conv = createConversation({ system: '', model: 'm' })
    addUserMessage(conv, 'First')
    addUserMessage(conv, 'Second')
    addUserMessage(conv, 'Third')
    expect(conv.turns).toHaveLength(3)
    expect((conv.turns[2]!.content[0] as any).text).toBe('Third')
  })
})

describe('isRetryableError', () => {
  it('identifies ECONNREFUSED as retryable', () => {
    expect(isRetryableError('connect ECONNREFUSED 127.0.0.1:8019')).toBe(true)
  })

  it('identifies ECONNRESET as retryable', () => {
    expect(isRetryableError('socket hang up ECONNRESET')).toBe(true)
  })

  it('identifies ETIMEDOUT as retryable', () => {
    expect(isRetryableError('connect ETIMEDOUT')).toBe(true)
  })

  it('identifies fetch failed as retryable', () => {
    expect(isRetryableError('TypeError: fetch failed')).toBe(true)
  })

  it('identifies network errors as retryable', () => {
    expect(isRetryableError('NetworkError when attempting to fetch')).toBe(true)
  })

  it('does not retry 4xx errors', () => {
    expect(isRetryableError('API error 400: Bad Request')).toBe(false)
  })

  it('does not retry auth errors', () => {
    expect(isRetryableError('API error 401: Unauthorized')).toBe(false)
  })

  it('does not retry generic errors', () => {
    expect(isRetryableError('Something went wrong')).toBe(false)
  })

  it('uses provider diagnostics retryability when available', () => {
    expect(isRetryableError('API error 504: {"type":"error","error":{"message":"kimi-code request failed: timeout after 60s","diagnostic":{"provider":"kimi","model":"kimi-code","kind":"timeout","message":"kimi-code request failed: timeout after 60s","status":504,"requestId":"req-timeout","retryable":true,"detail":"timeout after 60s"}}}')).toBe(true)
  })
})

describe('cross-model fallback policy', () => {
  it('does not switch models merely because fallbackModels are present', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'hello')
    const errors: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream overloaded', { status: 503 }),
    )

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:1',
      apiKey: 'test',
      fallbackModels: ['minimax-m27'],
      callbacks: {
        onError: (message) => { errors.push(message) },
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(conv.model).toBe('kimi-code')
    expect(result.runtimeFailure).not.toBeNull()
    expect(errors.join('\n')).not.toContain('falling back')
  })
})

describe('runConversationLoop', () => {
  function makePrematureCloseStream(options: { withText?: boolean } = {}) {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        ))
        if (options.withText) {
          controller.enqueue(encoder.encode(
            'event: content_block_delta\n' +
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
          ))
        }
        controller.close()
      },
    })
  }

  it('surfaces assistant text when a requested stream is downgraded to JSON', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Hello')

    const onText = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onText },
    })

    expect(onText).toHaveBeenCalledWith('OK')
    expect(result.finalText).toBe('OK')
  })

  it('injects a task realign request and continues after a corrected text-only turn', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Only touch `src/native/conversation.ts` while fixing the scheduler.')
    const taskState = ensureTaskExecutionState(conv, process.cwd())
    taskState.run.status = 'drifted'
    taskState.run.lastGuardReason = 'Task contract blocked write to /tmp/out-of-scope.ts.'

    const requestBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'I will stay within src/native/conversation.ts and re-center on the scheduler seam.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    const firstMessages = requestBodies[0]?.['messages'] as Array<Record<string, unknown>>
    const realignText = JSON.stringify(firstMessages)
    expect(realignText).toContain('[Runtime task contract]')
    expect(realignText).toContain('Only touch')
    expect(result.finalText).toBe('Done.')
    expect(taskState.run.status).toBe('completed')
  })

  it('continues an open task after an interim text-only progress update', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Implement the remaining native scheduler changes.')
    const requestBodies: Array<Record<string, unknown>> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'I found the remaining seam. Next I will patch the scheduler and add tests.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    expect(requestBodies).toHaveLength(2)
    const secondMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    expect(JSON.stringify(secondMessages)).toContain('[Runtime continue-while-open]')
    expect(result.finalText).toBe('Done.')
  })

  it('continues a write-intended task after a partial progress summary with no writes yet', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '请把结果写到 `docs/contract.md` 和 `docs/runbook.md`。')
    const requestBodies: Array<Record<string, unknown>> = []

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'write',
      description: 'test write',
      async execute(input) {
        return {
          output: `wrote ${String(input['path'] ?? '')}`,
          isError: false,
          metadata: { path: String(input['path'] ?? '') },
        }
      },
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: '我已读完所有参考文件。当前 preflight 通过本地 mock 验证了 profile/env/transport 合约，但没有任何真实 endpoint ' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 18 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (requestBodies.length === 2) {
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{
            type: 'tool_use',
            id: 'tool-write-1',
            name: 'write',
            input: { path: 'docs/contract.md', file_text: '# Contract' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 4, output_tokens: 6 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 5,
    })

    expect(requestBodies).toHaveLength(3)
    const secondMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    expect(JSON.stringify(secondMessages)).toContain('[Runtime continue-while-open]')
    expect(result.finalText).toBe('Done.')
    expect(result.conversation.options?.taskState?.contract.touchedPaths).toContain(`${process.cwd()}/docs/contract.md`)
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
  })

  it('marks the task drifted when the loop stops after tool results without a final assistant step', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the findings into `docs/report.md`.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{
        type: 'tool_use',
        id: 'tool-read-1',
        name: 'read',
        input: { path: '/tmp/source.md' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 1,
    })

    expect(result.finalText).toBe('')
    expect(result.stopReason).toBe('max_iterations')
    expect(result.conversation.turns.at(-1)?.role).toBe('user')
    expect(result.conversation.options?.taskState?.run.status).toBe('drifted')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toContain('iteration cap')
  })

  it('surfaces empty pre-token streams without hidden non-streaming retry', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Hello')

    const onText = vi.fn()
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n'))
        controller.enqueue(new TextEncoder().encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n'))
        controller.close()
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(streamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onText },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onText).not.toHaveBeenCalled()
    expect(result.finalText).toBe('')
    expect(result.runtimeFailure).toMatchObject({
      kind: 'pre_first_token_stream_close',
      retryable: true,
    })
  })

  it('surfaces structured provider diagnostics from API error bodies', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'Hello')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'kimi-code request failed: upstream 502 from provider',
        diagnostic: {
          provider: 'kimi',
          model: 'kimi-code',
          kind: 'http_5xx',
          message: 'kimi-code request failed: upstream 502 from provider',
          status: 502,
          requestId: 'req-upstream',
          retryable: true,
          detail: 'bad gateway',
        },
      },
    }), {
      status: 502,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-upstream',
      },
    }))

    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError },
    })

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('upstream 502 from provider'))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('req-upstream'))
    expect(result.finalText).toBe('')
  }, 10000)

  it('classifies empty end_turn responses as empty_provider_response failures with HTTP-200 wording', async () => {
    // Real cmux 0.13.20 evidence: kimi-code returned HTTP 200 with empty
    // content blocks and stop_reason=end_turn. The runtime now classifies
    // this distinct from generic transport failures so the auto-retry
    // path can suppress it (otherwise it loops 8× and burns provider
    // quota for no useful content). retryable stays true so /retry and
    // "继续" continue working as user-driven retries.
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'Continue the long task')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'kimi-code',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 0 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError },
    })

    expect(result.finalText).toBe('')
    expect(result.stopReason).toBe('stalled')
    expect(result.runtimeFailure).toMatchObject({
      kind: 'empty_provider_response',
      phase: 'continuation',
      retryable: true,
    })
    expect(result.runtimeFailure?.message).toContain('HTTP 200 but no content')
    expect(result.runtimeFailure?.message).not.toMatch(/rate.?limit/i)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('HTTP 200 but no content'))
    expect(shouldShowNoResponseFallback({
      finalText: result.finalText,
      stopReason: result.stopReason,
      runtimeFailure: result.runtimeFailure,
      aborted: false,
    })).toBe(false)
  })

  it('retries generic AbortError transport failures instead of reporting user cancellation', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'Continue the long task')

    const abortError = new Error('This operation was aborted')
    abortError.name = 'AbortError'
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'kimi-code',
        content: [{ type: 'text', text: 'Recovered after abort-like transport failure' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError },
    })

    expect(result.runtimeFailure).toBeNull()
    expect(result.finalText).toContain('Recovered after abort-like transport failure')
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Request cancelled by user'))
  })

  it('retries streaming timeout diagnostic events instead of stopping the task', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'Continue the long task')

    const encoder = new TextEncoder()
    const timeoutDiagnostic = {
      type: 'error',
      error: {
        type: 'timeout_error',
        message: 'kimi-code request failed: timeout after 120s',
        diagnostic: {
          provider: 'kimi',
          model: 'kimi-code',
          kind: 'timeout',
          message: 'kimi-code request failed: timeout after 120s',
          status: 504,
          requestId: 'req-timeout-stream',
          retryable: true,
          detail: 'timeout after 120s',
        },
      },
    }
    const timeoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(timeoutDiagnostic)}\n\n`))
        controller.close()
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(timeoutStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req-timeout-stream',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'kimi-code',
        content: [{ type: 'text', text: 'Recovered after timeout retry' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 5 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const onRetry = vi.fn()
    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onRetry, onError },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('timeout after 120s'),
    }))
    expect(result.runtimeFailure).toBeNull()
    expect(result.finalText).toContain('Recovered after timeout retry')
    expect(onError).not.toHaveBeenCalled()
  })

  it('classifies pre-first-token stream closes as continuation failures for continue prompts', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, '继续')

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      makePrematureCloseStream(),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req-stream-close',
        },
      },
    ))

    const onError = vi.fn()
    const onRetry = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError, onRetry },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(result.finalText).toBe('')
    expect(result.runtimeFailure).toMatchObject({
      kind: 'pre_first_token_stream_close',
      phase: 'continuation',
      retryable: true,
    })
    expect(result.runtimeFailure?.message).toContain('continuation failed')
    expect(result.runtimeFailure?.message).toContain('Context is intact')
    expect(result.runtimeFailure?.message).toContain('req-stream-close')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('continuation failed'))
    expect(shouldShowNoResponseFallback({
      finalText: result.finalText,
      stopReason: result.stopReason,
      runtimeFailure: result.runtimeFailure,
      aborted: false,
    })).toBe(false)
  }, 10000)

  it('preserves successful tool results when continuation fails before first token', async () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'Run the tool and then continue')

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'kimi-code',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'bash',
          input: { command: 'echo done' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementation(async () => new Response(
        makePrematureCloseStream(),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'req-tool-cont',
          },
        },
      ))

    const dispatcher = new ToolDispatcher()
    vi.spyOn(dispatcher, 'executeTool').mockResolvedValue({
      toolUseId: 'tool-1',
      toolName: 'bash',
      result: { output: 'done', isError: false },
      durationMs: 5,
    })

    const onError = vi.fn()
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError },
    })

    expect(result.finalText).toBe('')
    expect(result.runtimeFailure).toMatchObject({
      kind: 'pre_first_token_stream_close',
      phase: 'tool_continuation',
    })
    expect(result.runtimeFailure?.message).toContain('Tool completed, but model continuation failed before first token')
    expect(result.conversation.turns).toHaveLength(3)
    expect(result.conversation.turns[1]!.content[0]).toMatchObject({ type: 'tool_use', id: 'tool-1' })
    expect(result.conversation.turns[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-1', is_error: false })
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Tool completed, but model continuation failed before first token'))
  }, 10000)

  it('does not classify post-token stream interruption as pre-first-token', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, '继续')

    const failure = classifyConversationRuntimeFailure(new ProviderRequestError({
      provider: 'kimi',
      model: 'kimi-code',
      kind: 'stream_interrupted',
      message: 'kimi-code request failed: stream closed before completion',
      status: 502,
      requestId: 'req-post-token',
      retryable: true,
      detail: 'stream closed before completion',
    }), conv, 1)

    expect(failure?.kind).toBe('post_token_stream_close')
    expect(failure?.message).toContain('stream closed before completion')
  })

  it('does not mislabel generic AbortError as user cancellation', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, '继续')

    const err = new Error('This operation was aborted')
    err.name = 'AbortError'
    const failure = classifyConversationRuntimeFailure(err, conv, 1)
    expect(failure).toMatchObject({ kind: 'provider_error', retryable: true })
    expect(failure?.message).toContain('request aborted before completion')
  })

  it('preserves assistant tool_use in raw turns when aborted during tool execution', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Edit the file')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [
          {
            type: 'tool_use',
            id: 'edit:38',
            name: 'edit',
            input: { path: 'foo.ts', old_string: 'a', new_string: 'b' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const controller = new AbortController()
    const dispatcher = new ToolDispatcher()
    vi.spyOn(dispatcher, 'executeTool').mockImplementation(async (block) => {
      controller.abort()
      return {
        toolUseId: block.id,
        toolName: block.name,
        result: { output: 'aborted', isError: true },
        durationMs: 0,
      }
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      signal: controller.signal,
    })

    // Raw history preserves the assistant turn so the user can see what was attempted.
    // Additionally the abort path now synthesizes a tool_result user turn so the
    // tool_use pair is well-formed — preventing validateAndRepairConversation from
    // stripping the whole turn on the next run (and the model re-executing the
    // cancelled tool against the untouched original user prompt).
    expect(result.conversation.turns).toHaveLength(3)
    expect(result.conversation.turns[1]!.role).toBe('assistant')
    expect(result.conversation.turns[1]!.content[0]).toMatchObject({ type: 'tool_use', name: 'edit' })
    expect(result.conversation.turns[2]!.role).toBe('user')
    expect(result.conversation.turns[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'edit:38' })
  })

  it('synthesizes aborted tool_result for incomplete tool_use blocks on abort', async () => {
    // Scenario: user Ctrl+Cs mid-tool before the tool returns. Without
    // this synthesis, conversation.turns ends with an orphaned
    // assistant tool_use — the next turn strips it via repair, and the
    // model re-runs the same bash command against the user's original
    // (untouched) prompt. Real-machine QA reproduced this exact bug.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run the long command')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [
          {
            type: 'tool_use',
            id: 'bash:99',
            name: 'bash',
            input: { command: 'sleep 60' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const controller = new AbortController()
    const dispatcher = new ToolDispatcher()
    // Tool hangs forever; only the outer abort deadline + synthesis
    // path rescues the conversation loop.
    vi.spyOn(dispatcher, 'executeTool').mockImplementation(() =>
      new Promise(() => { /* never resolves */ }),
    )

    setTimeout(() => controller.abort(), 100)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      signal: controller.signal,
    })

    // [user: original prompt, assistant: tool_use, user: synthesized tool_result]
    expect(result.conversation.turns).toHaveLength(3)
    const lastTurn = result.conversation.turns[2]!
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'bash:99',
      is_error: true,
    })
    // The synthesized marker tells the model this specific call was
    // user-cancelled, not that the request vanished — so it won't retry.
    const toolResult = lastTurn.content[0] as { content: string }
    expect(toolResult.content).toContain('aborted')
  }, 8000)

  it('caps large tool outputs before callback display and conversation retention', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Read the SQL file')

    const hugeOutput = 'A'.repeat(50_000)
    const onToolEnd = vi.fn()
    const dispatcher = new ToolDispatcher()

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'read:1',
              name: 'read',
              input: { path: 'server/sql/mysql/16-apds-tables.sql' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 5 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    vi.spyOn(dispatcher, 'executeTool').mockResolvedValue({
      toolUseId: 'read:1',
      toolName: 'read',
      result: { output: hugeOutput, isError: false },
      durationMs: 12,
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onToolEnd },
    })

    expect(result.finalText).toBe('Done')
    expect(onToolEnd).toHaveBeenCalledTimes(1)

    const callbackOutput = onToolEnd.mock.calls[0]![1] as string
    expect(callbackOutput).toContain('read output truncated')
    expect(callbackOutput.length).toBeLessThanOrEqual(8_300)

    const toolResultTurn = result.conversation.turns.findLast(
      turn => turn.role === 'user' && turn.content.some(block => block.type === 'tool_result'),
    )
    const toolResultBlock = toolResultTurn?.content.find(
      block => block.type === 'tool_result',
    ) as { type: 'tool_result'; content: string } | undefined

    expect(toolResultBlock?.content).toContain('read output truncated')
    expect(toolResultBlock?.content.length ?? 0).toBeLessThanOrEqual(15_300)
    expect((toolResultBlock?.content.length ?? 0)).toBeGreaterThan(callbackOutput.length)
  })

  // ── P0 cancel-chain regression guard ──
  //
  // If a tool doesn't respect its AbortSignal (rogue MCP/LSP wrapper,
  // external process that ignores SIGTERM, etc.), the conversation loop
  // must still unwind within a bounded window after the user presses
  // Ctrl+C. The outer executeToolWithAbortDeadline is the last line of
  // defense — 3s after abort, it synthesizes an aborted result so the
  // caller breaks out of the loop instead of hanging on the dead tool.
  it('unwinds within ~3s of abort even when a tool never resolves (defense-in-depth)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run the rogue tool')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [
          {
            type: 'tool_use',
            id: 'rogue:1',
            name: 'bash',
            input: { command: 'simulated hang' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const controller = new AbortController()
    const dispatcher = new ToolDispatcher()

    // Simulate a tool that completely ignores its signal — never resolves,
    // never reads the signal. Without the outer deadline race, this would
    // hang the conversation loop indefinitely.
    vi.spyOn(dispatcher, 'executeTool').mockImplementation(() => {
      return new Promise(() => { /* never resolves */ })
    })

    // Fire abort shortly after the loop starts the tool.
    const abortAt = Date.now()
    setTimeout(() => controller.abort(), 200)

    const start = Date.now()
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      signal: controller.signal,
    })
    const elapsed = Date.now() - start
    void abortAt

    // Total elapsed must be bounded: 200ms wait + 3000ms deadline + slack.
    expect(elapsed).toBeLessThan(4500)
    // Loop broke cleanly — we have a conversation result (even if no final text).
    expect(result.conversation.turns.length).toBeGreaterThan(0)
  }, 8000)

  // ── P0 cancel→recovery closure regression ──
  //
  // End-to-end composition of the real-machine QA flow:
  //   1. Turn 1: model requests a tool → user Ctrl+Cs mid-tool
  //   2. Synthesized tool_result written; task ends cleanly
  //   3. Turn 2: user submits a follow-up → loop runs → NO onNotice
  //      fires "Conversation repair: ..." because history is well-formed
  //
  // Locks down the "cancel becomes fully trustable" contract: no
  // repair warning on recovery, no orphan stripping, no tool
  // re-execution by the model on the next turn.
  it('cancel then follow-up: no repair warning, history stays well-formed across turns', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'run the slow bash')

    const notices: string[] = []
    const onNotice = (msg: string): void => { notices.push(msg) }

    // Turn 1: tool_use response. Turn 2: plain text response.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'bash:cancel',
              name: 'bash',
              input: { command: 'sleep 60' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'Acknowledged. Trying a lighter alternative.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 5 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    const dispatcher = new ToolDispatcher()
    // Hanging tool — only the outer deadline unwinds it.
    vi.spyOn(dispatcher, 'executeTool').mockImplementation(() =>
      new Promise(() => { /* never resolves */ }),
    )

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const turn1 = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      signal: controller.signal,
      callbacks: { onNotice },
    })

    // Well-formed turn pair written: [user, assistant:tool_use, user:tool_result]
    expect(turn1.conversation.turns).toHaveLength(3)
    expect(turn1.conversation.turns[2]!.role).toBe('user')
    expect(turn1.conversation.turns[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'bash:cancel',
      is_error: true,
    })

    // Turn 2: follow-up message, fresh dispatcher (no tools this turn).
    addUserMessage(conv, 'try a different approach')
    const freshDispatcher = new ToolDispatcher()
    const turn2 = await runConversationLoop(conv, freshDispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onNotice },
    })
    expect(turn2.finalText).toBe('Acknowledged. Trying a lighter alternative.')

    // CRITICAL: no "Conversation repair" warning fired across either
    // turn. Without the synthesis fix, turn 2's initial
    // validateAndRepairConversation pass would strip the orphaned
    // tool_use and emit this warning — the exact symptom real-
    // machine QA reported ("outputs ⚠ Conversation repair: cleaned
    // orphaned tool calls; then re-runs the cancelled bash").
    const repairNotices = notices.filter((n) => /Conversation repair/i.test(n))
    expect(repairNotices).toHaveLength(0)

    fetchSpy.mockRestore()
  }, 8000)
})

describe('autoCompact', () => {
  it('does nothing when no contextWindow is set', () => {
    const conv = createConversation({ system: '', model: 'm' })
    for (let i = 0; i < 20; i++) addUserMessage(conv, 'A'.repeat(1000))
    expect(autoCompact(conv)).toBe(false)
    expect(conv.turns.length).toBe(20)
  })

  it('does nothing when usage is below threshold', () => {
    const conv = createConversation({ system: '', model: 'm' })
    addUserMessage(conv, 'short message')
    // 100K context window — way more than needed
    expect(autoCompact(conv, 100000)).toBe(false)
    expect(conv.turns.length).toBe(1)
  })

  it('compacts when usage exceeds 80% of context window', () => {
    const conv = createConversation({ system: '', model: 'm' })
    // Each message is 400 chars = ~100 tokens
    for (let i = 0; i < 20; i++) {
      addUserMessage(conv, 'X'.repeat(400))
    }
    // 20 turns * ~100 tokens = ~2000 tokens. Context window of 2200 → 91% usage
    const compacted = autoCompact(conv, 2200)
    expect(compacted).toBe(true)
    expect(conv.turns.length).toBeLessThan(20)
    expect(conv.turns.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps at least 2 turns', () => {
    const conv = createConversation({ system: '', model: 'm' })
    addUserMessage(conv, 'X'.repeat(4000))
    addUserMessage(conv, 'Y'.repeat(4000))
    addUserMessage(conv, 'Z'.repeat(4000))
    // Very small context window forces aggressive compaction
    autoCompact(conv, 100)
    expect(conv.turns.length).toBeGreaterThanOrEqual(2)
  })

  it('sanitizes after slicing — no dangling tool_use from mid-pair cut', () => {
    const conv = createConversation({ system: '', model: 'm' })
    // Build 6 turns including a complete tool_use/tool_result pair
    conv.turns = [
      { role: 'user', content: [{ type: 'text', text: 'u1' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'a:1', name: 'read', input: {} }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a:1', content: 'r1', is_error: false }],
        timestamp: 3,
      },
      { role: 'user', content: [{ type: 'text', text: 'u2' }], timestamp: 4 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'a:2', name: 'edit', input: {} }],
        timestamp: 5,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a:2', content: 'r2', is_error: false }],
        timestamp: 6,
      },
    ] as any

    // Force compact with contextWindow=1 so any token count exceeds 80% threshold
    const didCompact = autoCompact(conv, 1)
    expect(didCompact).toBe(true)

    // After compact, no assistant turn should have a dangling tool_use
    for (let i = 0; i < conv.turns.length; i++) {
      const turn = conv.turns[i]!
      if (turn.role !== 'assistant') continue
      const toolUseBlocks = turn.content.filter((b: any) => b.type === 'tool_use')
      if (toolUseBlocks.length === 0) continue
      const next = conv.turns[i + 1]
      expect(next?.role).toBe('user')
      const resultIds = (next?.content ?? [])
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id)
      for (const tb of toolUseBlocks) {
        expect(resultIds).toContain((tb as any).id)
      }
    }
  })
})
