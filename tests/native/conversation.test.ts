import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createConversation,
  addUserMessage,
  isRetryableError,
  autoCompact,
  getAutoCompactDecision,
  runConversationLoop,
  classifyConversationRuntimeFailure,
  shouldShowNoResponseFallback,
} from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { ProviderRequestError } from '../../src/provider-error.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'
import { recordVerificationEvidencePhaseEvent } from '../../src/native/phase-event-state.js'
import {
  __getAdaptiveConcurrencySnapshotForTesting,
  __resetAdaptiveConcurrencyForTesting,
} from '../../src/native/adaptive-concurrency.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY']
  delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']
  delete process.env['OWLCODA_AGENT_RETRY_BUDGET_PER_WINDOW']
  delete process.env['OWLCODA_AGENT_RETRY_BUDGET_WINDOW_MS']
  __resetAdaptiveConcurrencyForTesting()
})

function gateV2EnabledForTest(): boolean {
  const value = process.env['OWLCODA_GATE_V2']
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

describe('Native Conversation', () => {
  it('creates a conversation with expected defaults', () => {
    const conv = createConversation({
      system: 'You are helpful.',
      model: 'test-model',
    })
    expect(conv.id).toMatch(/^conv-/)
    expect(conv.system).toBe('You are helpful.')
    expect(conv.model).toBe('test-model')
    // 0.13.65: bumped default from 4096 → 32_768 (matches external coding-assistant,
    // Aider, opencode mainstream). 4096 was outlier on the low end.
    expect(conv.maxTokens).toBe(32_768)
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

  it('does not attach the REPL wall-clock timeout to an active streaming body', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Reply with exactly done.')

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error(`test timeout after ${ms}ms`)), 10)
      return controller.signal
    })

    const encoder = new TextEncoder()
    const event = (name: string, data: Record<string, unknown>): string =>
      `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const requestSignal = init?.signal as AbortSignal | undefined
      let closed = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener('abort', () => {
            if (!closed) controller.error(new Error('client timeout aborted active stream'))
          }, { once: true })
          controller.enqueue(encoder.encode(event('message_start', {
            type: 'message_start',
            message: { usage: { input_tokens: 3, output_tokens: 0 } },
          })))
          controller.enqueue(encoder.encode(event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })))
          setTimeout(() => {
            controller.enqueue(encoder.encode(event('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'done' },
            })))
          }, 20)
          setTimeout(() => {
            closed = true
            controller.enqueue(encoder.encode(event('content_block_stop', { type: 'content_block_stop', index: 0 })))
            controller.enqueue(encoder.encode(event('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            })))
            controller.enqueue(encoder.encode(event('message_stop', { type: 'message_stop' })))
            controller.close()
          }, 40)
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req-active-stream',
        },
      })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).not.toHaveBeenCalled()
    expect(result.runtimeFailure).toBeNull()
    expect(result.finalText).toBe('done')
  })

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

  it('stops when a successful curl tool result contains a terminal business auth failure', async () => {
    // This test validates that runConversationLoop honours terminalToolFailure metadata
    // from the dispatcher layer. In production, dispatch.ts applies applyToolFailurePolicy
    // (from tools/semantic-failure.ts) which detects auth errors and injects this metadata.
    // That detection lives in dispatch.ts and is not yet committed alongside this test, so
    // we inject the metadata directly here to keep the test self-contained and to pin the
    // conversation.ts invariant: one API call, stopReason='terminal_tool_failure'.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Explore MES data and build the test report.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'fake bash',
      async execute() {
        return {
          output: '[Runtime failure-policy guard] Remote query returned an authentication/permission failure ({"detail":"无效的客户端 Key"}).',
          isError: true,
          metadata: {
            exitCode: 0,
            terminalToolFailure: true,
            terminalFailureReason: 'Remote query returned an authentication/permission failure ({"detail":"无效的客户端 Key"}).',
          },
        }
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'bash',
          input: {
            command: 'curl -sS "http://8.130.50.168:3000/mes/customer/page?current=1&size=5&key=x"',
          },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const errors: string[] = []

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError: (message) => { errors.push(message) } },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('terminal_tool_failure')
    expect(errors.join('\n')).toContain('authentication/permission failure')
    const toolResult = result.conversation.turns
      .flatMap((turn) => turn.content)
      .find((block: any) => block.type === 'tool_result') as any
    expect(toolResult.is_error).toBe(true)
    expect(toolResult.content).toContain('[Runtime failure-policy guard]')
  })

  it('2026-05-28: auto-retries on 400 + rate-limit detail (mimo cluster rate-limit shape) and reaches end_turn', async () => {
    // End-to-end pin for a66383e (provider-error rate-limit detection).
    // Chain: messages endpoint detects 400 + "Cluster rate limit exceeded"
    // detail → marks diagnostic retryable=true → returns anthropic-shape
    // error body → runConversationLoop's parseProviderDiagnosticFromPayload
    // recovers the diagnostic → requestAutoRetryLimitForDiagnostic returns
    // 1 → onRetry fires → 2nd fetch succeeds → stopReason='end_turn'.
    // This test stubs the anthropic-shape body directly because the messages
    // endpoint conversion is covered by provider-error.test.ts ("treats 400
    // + cluster rate-limit detail as retryable").
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run a small task that initially hits a cluster rate limit.')

    const dispatcher = new ToolDispatcher()
    const retryEvents: Array<{ attempt: number; delayMs: number }> = []
    const errors: string[] = []

    // Anthropic-shape error body the messages endpoint would produce for a
    // 400 + rate-limit detail (matches diagnosticToAnthropicError output
    // exactly so parseProviderDiagnosticFromPayload recovers it).
    const rateLimitDiagnostic = {
      provider: 'openai-compat',
      model: 'test-model',
      kind: 'http_4xx',
      message: 'test-model request failed: upstream 400 from provider',
      status: 400,
      requestId: 'req-rl-attempt-1',
      retryable: true,
      detail: 'Cluster rate limit exceeded, request queued but not admitted',
    }
    const rateLimitErrorBody = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: rateLimitDiagnostic.message,
        diagnostic: rateLimitDiagnostic,
      },
    })

    let callCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(rateLimitErrorBody, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Recovered after rate-limit backoff.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: {
        onError: (m) => { errors.push(m) },
        onRetry: (info) => { retryEvents.push({ attempt: info.attempt, delayMs: info.delayMs }) },
      },
    })

    // Invariants:
    //   - Two upstream calls (first rate-limited, second succeeded).
    //   - onRetry fired exactly once with attempt=1.
    //   - Final stopReason is end_turn, NOT terminal_tool_failure.
    //   - No onError because the retry recovered.
    //   - retryDelay uses 5s base + ±25% jitter for rate-limit (range 3750..6250ms).
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]!.attempt).toBe(1)
    expect(retryEvents[0]!.delayMs).toBeGreaterThanOrEqual(3750)
    expect(retryEvents[0]!.delayMs).toBeLessThanOrEqual(6250)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Recovered')
    expect(errors).toEqual([])
  }, 15_000)

  it('adaptive concurrency mode raises request auto-retry budget from 1 to 3', async () => {
    process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Recover after two upstream 503s.')

    const dispatcher = new ToolDispatcher()
    const retryEvents: Array<{ attempt: number; delayMs: number }> = []

    let callCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount <= 2) {
        return new Response('temporary overload', { status: 503 })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Recovered after two retries.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: {
        onRetry: (info) => { retryEvents.push({ attempt: info.attempt, delayMs: info.delayMs }) },
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(retryEvents.map((e) => e.attempt)).toEqual([1, 2])
    expect(retryEvents.map((e) => e.delayMs)).toEqual([1000, 2000])
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Recovered after two retries')
  }, 10_000)

  it('adaptive controller observes upstream rate-limit and success signals from request loop', async () => {
    process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'] = '1'
    process.env['OWLCODA_AGENT_MAX_CONCURRENCY'] = '4'
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Recover after one cluster rate limit.')

    const dispatcher = new ToolDispatcher()
    const rateLimitDiagnostic = {
      provider: 'openai-compat',
      model: 'test-model',
      kind: 'http_4xx',
      message: 'test-model request failed: upstream 400 from provider',
      status: 400,
      requestId: 'req-rl-attempt-1',
      retryable: true,
      detail: 'Cluster rate limit exceeded, request queued but not admitted',
    }
    const rateLimitErrorBody = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: rateLimitDiagnostic.message,
        diagnostic: rateLimitDiagnostic,
      },
    })
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(rateLimitErrorBody, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Recovered after rate-limit.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    expect(result.stopReason).toBe('end_turn')
    const snapshot = __getAdaptiveConcurrencySnapshotForTesting('http://localhost:0', 4)
    expect(snapshot.effectiveLimit).toBe(1)
    expect(snapshot.consecutiveSuccesses).toBe(0)
    expect(snapshot.cooldownUntil).toBeGreaterThan(Date.now())
  }, 10_000)

  it('does NOT stop when a sub-agent reports an isolated failure (subAgentIsolatedFailure metadata, no terminalToolFailure)', async () => {
    // 2026-05-27 sub-agent failure isolation hotfix invariant:
    // pre-hotfix, Agent tool set metadata.terminalToolFailure=true on
    // task_no_progress / max_iterations / artifact_contract failures, which
    // dispatch.ts upgraded to a parent terminal_tool_failure — killing all
    // sibling sub-agents in a fan-out. Post-hotfix, sub-agent failures carry
    // metadata.subAgentIsolatedFailure=true WITHOUT terminalToolFailure, so
    // the parent loop receives isError=true tool_result and the parent LLM
    // decides what to do next (retry / skip / abort) on the next turn.
    // This test pins that invariant by injecting the post-hotfix metadata
    // shape and verifying the parent loop does NOT stop with
    // terminal_tool_failure.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Launch sub-agent A.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Agent',
      description: 'fake sub-agent',
      async execute() {
        return {
          output: 'Agent incomplete: the sub-agent task required file output, but it returned without touching any durable path.',
          isError: true,
          metadata: {
            agentId: 'agent-aaaa1111',
            agentType: 'general-purpose',
            iterations: 9,
            agentIncomplete: true,
            agentNoDeliverable: true,
            subAgentIsolatedFailure: true,
            completion_status: 'failed',
            failureCategory: 'agent:no_deliverable',
            failureMessage: 'Sub-agent task required file output but completed without touching any durable path.',
          },
        }
      },
    })

    let callCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // Parent calls Agent tool
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Agent',
            input: { description: 'sub task', prompt: 'do something' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // After receiving isolated failure result, parent decides to end gracefully
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Sub-agent A failed in isolation; will report and move on.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onError: (message) => { errors.push(message) } },
    })

    // Invariant: parent loop should NOT terminate with terminal_tool_failure
    expect(result.stopReason).not.toBe('terminal_tool_failure')
    // Parent reached its natural end_turn after seeing the isolated failure
    expect(result.stopReason).toBe('end_turn')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // onError should NOT be invoked because no terminalToolFailure was raised
    expect(errors).toEqual([])
    // The isolated failure tool_result is still delivered to the model with isError=true
    const toolResult = result.conversation.turns
      .flatMap((turn) => turn.content)
      .find((block: any) => block.type === 'tool_result') as any
    expect(toolResult.is_error).toBe(true)
    expect(toolResult.content).toContain('without touching any durable path')
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
    // Slice 0 (Deliverable Contract v1): "Only touch X while fixing Y" classifies
    // as code_change (durable-artifact required). The model said "Done." with 0
    // touched paths → markTaskGuardBlocked fires (status = 'drifted'). Pre-Slice-0
    // the classifier mis-mapped this prompt to `mixed`, letting chat-final shortcut
    // mark completed; that was the false-positive-completion bug Slice 0 closes.
    expect(taskState.run.status).toBe('drifted')
  })

  it('nudges a write-like interim text update toward structured task execution', async () => {
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

    if (gateV2EnabledForTest()) {
      expect(requestBodies).toHaveLength(1)
      expect(JSON.stringify(result.conversation.turns)).not.toContain('[Runtime task-step]')
      expect(result.finalText).toContain('I found the remaining seam')
      return
    }
    expect(requestBodies).toHaveLength(3)
    const secondMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    const thirdMessages = requestBodies[2]?.['messages'] as Array<Record<string, unknown>>
    expect(JSON.stringify(secondMessages)).toContain('[Runtime task-step]')
    expect(JSON.stringify(secondMessages)).toContain('Call TaskCreate')
    expect(JSON.stringify(thirdMessages)).toContain('[Runtime task-step]')
    expect(result.finalText).toBe('Done.')
    expect(result.conversation.options?.taskState?.run.status).toBe('drifted')
  })

  it('does not continue after the real minimax dogfood final addendum shape', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      'Continue the dogfood for another 5-6 minutes to better match the requested long-task duration.',
      'Stay read-only in /Users/publicuser/AI/gitrep/owlcoda, use multiple tools, create any temporary artifacts only under /tmp/owlcoda-dogfood-minimax, clean them before finishing, and produce a short addendum with any new checks, cleanup status, and whether terminal rendering corruption appeared.',
      'Do not modify the repository.',
    ].join(' '))
    const requestBodies: Array<Record<string, unknown>> = []

    const minimaxAddendum = [
      '---',
      '',
      '## Dogfood Task Addendum',
      '',
      '**Duration Extension:** ~5-6 minutes',
      '**Total Time:** ~15-16 minutes',
      '',
      '### New Checks Performed',
      '',
      '| Category | Details |',
      '|----------|---------|',
      '| **Middleware** | Circuit breaker (81 lines), fallback (135), retry with jitter (121), rate limiting (120) |',
      '| **Protocol Translation** | Anthropic<->OpenAI request/response, SSE streaming (800+ lines), tool definitions |',
      '| **Health Monitoring** | Background probing, model availability caching, cloud endpoint passthrough |',
      '| **Data Pipeline** | Quality scoring (328 lines), PII sanitization, training store, JSON/markdown export |',
      '| **Plugin System** | 6 hooks: onRequest, onResponse, onToolCall, onError, onLoad, onUnload |',
      '| **Error Handling** | 572 lines, 12 failure kinds, 100-request error budget with 95% SLO |',
      '| **Native Tools** | 5,752 lines across 48 tools (largest: glob 398, grep 384, bash 321, agent 337) |',
      '| **Model Catalog** | Platform catalog priority, alias resolution, channel classification |',
      '| **OpenAPI Spec** | 780 lines documenting all endpoints including SSE metrics |',
      '| **Cost Estimation** | Hardware amortization model, kWh-based by model size |',
      '',
      '### Resilience Architecture Discovered',
      '',
      '1. **Circuit Breaker** - Closed/Open/Half-open states, 5 failure threshold, 60s cooldown',
      '2. **Retry** - Exponential backoff with +/-25% jitter, retries 5xx only (never 4xx)',
      '3. **Error Budget** - Rolling 100-request window, advisory warnings at <95% success rate',
      '4. **Multi-model Fallback** - Configurable fallback chain per model',
      '',
      '### Terminal Rendering Corruption',
      '',
      '**None detected.** Deep analysis confirmed:',
      '- Proper CSI sequence generation',
      '- Incremental rendering via `log-update.ts`',
      '- Platform-specific escape sequences verified',
      '- No double-output or artifact patterns',
      '',
      '### Cleanup Status',
      '',
      '- **Temp directory:** `/tmp/owlcoda-dogfood-minimax/`',
      '- **Artifacts created:** `addendum.md`, `deep-analysis.json`',
      '- **Artifacts removed:** All files deleted successfully',
      '',
      '### Repository Modification',
      '',
      '**None.** All analysis was read-only. No changes made to `/Users/publicuser/AI/gitrep/owlcoda`.',
    ].join('\n')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: minimaxAddendum }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 160 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    expect(requestBodies).toHaveLength(1)
    expect(JSON.stringify(result.conversation.turns)).not.toContain('[Runtime continue-while-open]')
    expect(result.finalText).toContain('Dogfood Task Addendum')
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toBeNull()
  })

  it('does not leave the real kimi dogfood addendum shape drifted', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      'Continue this Kimi official-route dogfood for another 5-6 minutes to better match the requested long-task comparison.',
      'Stay read-only in the repository, preserve the current dirty working tree exactly as-is, use multiple tools, create temporary artifacts only under /tmp/owlcoda-dogfood-kimi, remove them before finishing, and produce a concise addendum.',
      'Do not modify the repository.',
    ].join(' '))
    const requestBodies: Array<Record<string, unknown>> = []

    const kimiAddendum = [
      '## OwlCoda Dogfood Addendum - Extended Exploration',
      '',
      '**Tools used in this phase:** `read` (7 files), `grep` (2 searches), `bash` (git diff, stash list, temp I/O) - all read-only.',
      '',
      '**Repository state preserved:** 11 dirty files untouched; no edits, stages, or stashes.',
      '',
      '**Kimi route coverage verified:**',
      '- **Probe layer:** Template `id: \'kimi\'`, endpoint `https://api.kimi.com/coding/v1`, testPath `/chat/completions`. URL normalization (`src/provider-probe.ts:894-911`) upgrades legacy `/coding` to `/coding/v1/chat/completions`.',
      '- **Admin UI layer:** `TestConnectionPanel` displays `provider`, `backendModel`, `endpoint` from `ProviderProbeResult`. `mutations.test.tsx` exercises `kimi-k2` across set-default, edit, key-replace, test-connection, delete, and add-model flows. `StartPage.test.tsx` uses `kimi-code` as the default model fixture.',
      '- **Type contracts:** `ProviderProbeResult.provider` docstring cites `kimi` as the canonical example.',
      '',
      '**Uncommitted changes audited (read-only):**',
      '- `src/provider-probe.ts` diff adds `usesModelListProbe`, `extractModelIdsFromModelsResponse`, and `collectModelIds` for strict `/models` validation; moves body read before status check to ensure error snippets are always captured.',
      '',
      '**Cleanup status:** `/tmp/owlcoda-dogfood-kimi` removed.',
      '',
      '**Terminal rendering:** No corruption observed.',
    ].join('\n')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: kimiAddendum }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 120 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    expect(requestBodies).toHaveLength(1)
    expect(JSON.stringify(result.conversation.turns)).not.toContain('[Runtime continue-while-open]')
    expect(result.finalText).toContain('OwlCoda Dogfood Addendum')
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toBeNull()
  })

  it('does not continue after a complete sustained-work final report', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      'Run a sustained OwlCoda official-route reliability task for at least 10 minutes.',
      'Final answer must include elapsed time, checkpoint list, tests run, cleanup status, and fallback status.',
    ].join(' '))
    const requestBodies: Array<Record<string, unknown>> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: [
          '## Sustained Reliability Task Complete',
          '',
          'Elapsed time: 10.6 minutes (637 seconds) - meets the 10-minute requirement.',
          'Checkpoint list: 7/7 completed across package/scripts, model routing, provider probe, translation, fallback safety, tests, and cleanup.',
          'Tests run: 5 focused test files, 70/70 passed, 0 failed.',
          'Cleanup status: temporary directory /tmp/owlcoda-kimi-official-10min removed and verified absent.',
          'Fallback status: fallbackUsed=false; no fallback takeover was used.',
          'Repository modifications: no repo files were modified.',
          'Remaining risk: sustained runtime parity has not yet been proven with a live backend.',
        ].join('\n') }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 80 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    expect(requestBodies).toHaveLength(1)
    expect(result.finalText).toContain('Sustained Reliability Task Complete')
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toBeNull()
  })

  it('accepts final-answer handoff phrasing plus remaining-risk caveats as complete', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, [
      'Run a sustained official-route rerun for at least 10 minutes.',
      'Final answer must include elapsed time, checkpoint list/count, tests run, cleanup status, fallback status, repository modification status, and remaining risk.',
    ].join(' '))
    const requestBodies: Array<Record<string, unknown>> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: [
          'The task is complete. I will now provide the final answer as required.',
          '',
          '## Final Answer - OwlCoda Official-Route Completion-Guard Rerun',
          '',
          '**Elapsed time:** 753 seconds (12 minutes 33 seconds) - exceeded the 600-second minimum.',
          '**Checkpoint list/count:** 7 checkpoints completed.',
          '**Tests run:** 73 passed, 0 failed.',
          '**Cleanup status:** Complete. /tmp/owlcoda-kimi-official-10min-rerun was removed.',
          '**Fallback status:** fallbackUsed=false; no fallback takeover was visible.',
          '**Repository modification status:** No modifications made during this rerun.',
          '**Remaining risk:** product signoff has not yet been updated in docs.',
        ].join('\n') }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 80 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 4,
    })

    expect(requestBodies).toHaveLength(1)
    expect(result.finalText).toContain('Final Answer')
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toBeNull()
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

    if (gateV2EnabledForTest()) {
      expect(requestBodies).toHaveLength(1)
      expect(JSON.stringify(result.conversation.turns)).not.toContain('[Runtime task-step]')
      expect(result.finalText).toContain('我已读完所有参考文件')
      return
    }
    expect(requestBodies).toHaveLength(3)
    const secondMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    expect(JSON.stringify(secondMessages)).toContain('[Runtime task-step]')
    expect(JSON.stringify(secondMessages)).toContain('Call TaskCreate')
    expect(result.finalText).toBe('Done.')
    expect(result.conversation.options?.taskState?.contract.touchedPaths).toContain(`${process.cwd()}/docs/contract.md`)
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
  })

  it('continues a vague done response for a write-intended task with no writes yet', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the final findings to `docs/final-report.md`.')
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
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (requestBodies.length === 2) {
        return new Response(JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{
            type: 'tool_use',
            id: 'tool-write-final',
            name: 'write',
            input: { path: 'docs/final-report.md', file_text: '# Final Report' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 6 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Completed after writing docs/final-report.md.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6, output_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      maxIterations: 5,
    })

    if (gateV2EnabledForTest()) {
      expect(requestBodies).toHaveLength(1)
      expect(JSON.stringify(result.conversation.turns)).not.toContain('[Runtime task-step]')
      expect(result.finalText).toBe('Done.')
      return
    }
    expect(requestBodies).toHaveLength(3)
    const secondMessages = requestBodies[1]?.['messages'] as Array<Record<string, unknown>>
    expect(JSON.stringify(secondMessages)).toContain('[Runtime task-step]')
    expect(JSON.stringify(secondMessages)).toContain('Call TaskCreate')
    expect(result.conversation.options?.taskState?.contract.touchedPaths).toContain(`${process.cwd()}/docs/final-report.md`)
    expect(result.conversation.options?.taskState?.run.status).toBe('completed')
  })

  it('phase runtime blocks durable completion claims without artifact evidence', async () => {
    const previousPhaseRuntime = process.env['OWLCODA_PHASE_RUNTIME']
    process.env['OWLCODA_PHASE_RUNTIME'] = '1'
    try {
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, 'Write the final findings to `docs/phase-runtime-report.md` and verify them.')
      const taskState = ensureTaskExecutionState(conv, process.cwd())

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: [
          'Final report: task complete.',
          'Elapsed time: 10 minutes.',
          'Checkpoint list: 3/3 completed.',
          'Tests run: 12/12 passed.',
          'Cleanup status: complete.',
        ].join('\n') }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

      const result = await runConversationLoop(conv, new ToolDispatcher(), {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        maxIterations: 1,
      })

      expect(result.finalText).toContain('task complete')
      expect(taskState.run.status).toBe('drifted')
      expect(taskState.run.lastGuardReason).toContain('no artifact evidence')
    } finally {
      if (previousPhaseRuntime === undefined) delete process.env['OWLCODA_PHASE_RUNTIME']
      else process.env['OWLCODA_PHASE_RUNTIME'] = previousPhaseRuntime
    }
  })

  it('phase runtime accepts durable completion claims with artifact and verification evidence', async () => {
    const previousPhaseRuntime = process.env['OWLCODA_PHASE_RUNTIME']
    process.env['OWLCODA_PHASE_RUNTIME'] = '1'
    try {
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, 'Write the final findings to `docs/phase-runtime-report.md` and verify them.')
      const taskState = ensureTaskExecutionState(conv, process.cwd())
      taskState.contract.touchedPaths.push(`${process.cwd()}/docs/phase-runtime-report.md`)
      recordVerificationEvidencePhaseEvent(taskState, 0, 'TaskVerify', 'TaskVerify passed for docs/phase-runtime-report.md')

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Final report: task complete. docs/phase-runtime-report.md was written and all tests passed.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 12 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

      const result = await runConversationLoop(conv, new ToolDispatcher(), {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        maxIterations: 2,
      })

      expect(result.finalText).toContain('phase-runtime-report.md')
      expect(taskState.run.status).toBe('completed')
      expect(taskState.run.lastGuardReason).toBeNull()
    } finally {
      if (previousPhaseRuntime === undefined) delete process.env['OWLCODA_PHASE_RUNTIME']
      else process.env['OWLCODA_PHASE_RUNTIME'] = previousPhaseRuntime
    }
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

  it('does not auto-retry long provider timeout diagnostic events', async () => {
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
      .mockResolvedValue(new Response(timeoutStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req-timeout-stream',
        },
      }))

    const onRetry = vi.fn()
    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      callbacks: { onRetry, onError },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(result.runtimeFailure).toMatchObject({
      kind: 'timeout',
      retryable: true,
    })
    expect(result.finalText).toBe('')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timeout after 120s'))
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

  it('0.13.97: stream_first_token_timeout maps to pre_first_token_stream_close', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'hi')

    const failure = classifyConversationRuntimeFailure(new ProviderRequestError({
      provider: 'kimi',
      model: 'kimi-code',
      kind: 'stream_first_token_timeout',
      message: 'kimi-code request failed: first-token watchdog fired after 90000ms with no visible chunk',
      status: 504,
      retryable: true,
      detail: 'first-token watchdog fired after 90000ms with no visible chunk',
      partialOutputSeen: false,
    }), conv, 1)

    expect(failure?.kind).toBe('pre_first_token_stream_close')
    expect(failure?.diagnostic?.partialOutputSeen).toBe(false)
  })

  it('0.13.97: stream_idle_timeout maps to its own kind, carries partialOutputSeen=true', () => {
    const conv = createConversation({ system: 'test', model: 'kimi-code' })
    addUserMessage(conv, 'hi')

    const failure = classifyConversationRuntimeFailure(new ProviderRequestError({
      provider: 'kimi',
      model: 'kimi-code',
      kind: 'stream_idle_timeout',
      message: 'kimi-code request failed: idle watchdog fired after 90000ms with partial output already streamed',
      status: 504,
      retryable: true,
      detail: 'idle watchdog fired after 90000ms with partial output already streamed',
      partialOutputSeen: true,
    }), conv, 1)

    expect(failure?.kind).toBe('stream_idle_timeout')
    expect(failure?.diagnostic?.partialOutputSeen).toBe(true)
  })

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

  it('closes orphaned tool_use blocks when loop-guard hard-terminates mid-batch', async () => {
    // Scenario: model emits two tool_use blocks. First executes ok. Second
    // triggers the loop-guard hard-terminate (same signature as an earlier
    // attempt). Without the fix, conversation.turns ends with an orphaned
    // assistant turn (2 tool_use blocks) and only 1 tool_result, which
    // sanitizeConversationTurns strips entirely.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Read two files')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [
          {
            type: 'tool_use',
            id: 'read:01',
            name: 'read',
            input: { path: '/foo.ts' },
          },
          {
            type: 'tool_use',
            id: 'read:02',
            name: 'read',
            input: { path: '/foo.ts' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 2 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const dispatcher = new ToolDispatcher()
    vi.spyOn(dispatcher, 'executeTool').mockImplementation(async (block) => ({
      toolUseId: block.id,
      toolName: block.name,
      result: { output: 'file content', isError: false },
      durationMs: 1,
    }))

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    // The critical assertion: if the assistant turn has tool_use blocks,
    // there must be a corresponding user turn with matching tool_results.
    const assistantTurn = result.conversation.turns.find(t => t.role === 'assistant')
    if (assistantTurn) {
      const toolUseIds = assistantTurn.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id)
      if (toolUseIds.length > 0) {
        const followingUserTurn = result.conversation.turns[
          result.conversation.turns.indexOf(assistantTurn) + 1
        ]
        expect(followingUserTurn).toBeDefined()
        expect(followingUserTurn!.role).toBe('user')
        const resultIds = followingUserTurn!.content
          .filter((b: any) => b.type === 'tool_result')
          .map((b: any) => b.tool_use_id)
        for (const id of toolUseIds) {
          expect(resultIds).toContain(id)
        }
      }
    }
  })

  it('synthesizes tool_result for blocked tool_use when loop-guard hard-terminates', async () => {
    // Set up: 3 iterations all run the same failing Skill call.
    // The loop guard fires on the 3rd call (sameFailures >= 2).
    // hard mode (OWLCODA_LOOP_INTERCEPT=hard) terminates immediately.
    // Without the fix, the assistant turn on iteration 3 has a tool_use
    // block with no matching tool_result, orphaning it.
    // 0.14.10: switched offending tool from bash → Skill. bash is now
    // exempt from signature-based detection; this test still needs to
    // verify the orphan-closure logic which is tool-category agnostic.
    process.env['OWLCODA_LOOP_GUARD'] = 'on'
    process.env['OWLCODA_LOOP_INTERCEPT'] = 'hard'

    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run failing command until you fix it')

    const skillResponse = (id: string) => new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{
        type: 'tool_use',
        id,
        name: 'Skill',
        input: { action: 'run', name: 'nonexistent' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(skillResponse('skill:01'))
      .mockResolvedValueOnce(skillResponse('skill:02'))
      .mockResolvedValueOnce(skillResponse('skill:03'))

    const dispatcher2 = new ToolDispatcher()
    vi.spyOn(dispatcher2, 'executeTool').mockImplementation(async (block) => ({
      toolUseId: block.id,
      toolName: block.name,
      result: { output: 'FAILED: tests/test_x.py::test_foo FAILED', isError: true },
      durationMs: 1,
    }))

    const result = await runConversationLoop(conv, dispatcher2, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    // Loop should stop with tool_loop reason
    expect(result.stopReason).toBe('tool_loop')

    // Every assistant turn with tool_use blocks must be followed by a
    // user turn with matching tool_results.
    const turns = result.conversation.turns
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!
      if (turn.role !== 'assistant') continue
      const toolUseIds = turn.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id as string)
      if (toolUseIds.length === 0) continue

      const nextTurn = turns[i + 1]
      expect(nextTurn, `assistant turn at index ${i} has no following user turn`).toBeDefined()
      expect(nextTurn!.role).toBe('user')
      const resultIds = nextTurn!.content
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id as string)
      for (const id of toolUseIds) {
        expect(resultIds, `tool_use id ${id} has no matching tool_result`).toContain(id)
      }
    }

    process.env['OWLCODA_LOOP_GUARD'] = undefined
    process.env['OWLCODA_LOOP_INTERCEPT'] = undefined
  })

  it('closes orphaned assistant turn with tool_use when sendRequest throws after the turn was pushed', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Do something')

    const toolUseSSE = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg1', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bash:42', name: 'bash' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n')

    const { ReadableStream: NodeReadableStream } = await import('node:stream/web')
    function makeSSEStream(body: string) {
      const encoder = new TextEncoder()
      return new NodeReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body))
          controller.close()
        },
      })
    }

    function makeBrokenStream() {
      return new NodeReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {}\n\n'))
          controller.error(new Error('network reset'))
        },
      })
    }

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(makeSSEStream(toolUseSSE) as any, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(makeBrokenStream() as any, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))

    const dispatcher3 = new ToolDispatcher()
    vi.spyOn(dispatcher3, 'executeTool').mockResolvedValue({
      toolUseId: 'bash:42',
      toolName: 'bash',
      result: { output: 'hi', isError: false },
      durationMs: 1,
    })

    const result = await runConversationLoop(conv, dispatcher3, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    // Regardless of which iteration fails, every assistant turn with
    // tool_use blocks must be followed by a user turn with tool_results.
    const turns = result.conversation.turns
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!
      if (turn.role !== 'assistant') continue
      const toolUseIds = turn.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id as string)
      if (toolUseIds.length === 0) continue
      const nextTurn = turns[i + 1]
      expect(nextTurn, `assistant turn at index ${i} has no following user turn`).toBeDefined()
      expect(nextTurn!.role).toBe('user')
      const resultIds = nextTurn!.content
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id as string)
      for (const id of toolUseIds) {
        expect(resultIds, `tool_use id ${id} has no matching tool_result`).toContain(id)
      }
    }
  })

  it('does not increment lifetime iteration count for API-error non-producing turns', async () => {
    // Scenario: model fails on the FIRST turn (fetch throws).
    // lifetimeIterations should be 0 after the loop exits (no model
    // output produced), not 1. markTaskIteration fires at the TOP of
    // the while loop before sendRequest; we undo it on failure.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Do something ambitious')

    // Using ProviderRequestError so runtimeFailure is non-null is a bonus;
    // the primary assertion is the lifetimeIterations decrement.
    const nonRetryableProviderError = new ProviderRequestError({
      provider: 'anthropic',
      model: 'test-model',
      kind: 'http_4xx',
      message: 'Upstream validation failed',
      status: 400,
      retryable: false,
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(nonRetryableProviderError)

    const dispatcher4 = new ToolDispatcher()
    const result = await runConversationLoop(conv, dispatcher4, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
    })

    // The loop should have exited (stopReason not null or loop ended)
    expect(result.iterations).toBe(1)

    // lifetimeIterations must not have been bumped by the failing attempt
    const taskState = result.conversation.options?.taskState
    expect(taskState?.run?.lifetimeIterations ?? 0).toBe(0)
  })
})

describe('query recovery closure invariant', () => {
  const assertWellFormed = (turns: ReturnType<typeof createConversation>['turns']) => {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!
      if (turn.role !== 'assistant') continue
      const toolUseIds = turn.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id as string)
      if (toolUseIds.length === 0) continue
      const nextTurn = turns[i + 1]
      expect(nextTurn, `assistant turn at [${i}] missing user follow-up`).toBeDefined()
      expect(nextTurn!.role).toBe('user')
      const resultIds = nextTurn!.content
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id as string)
      for (const id of toolUseIds) {
        expect(resultIds, `tool_use ${id} has no tool_result`).toContain(id)
      }
    }
  }

  it('abort during tool execution leaves well-formed conversation', async () => {
    // Existing behavior verified by prior tests — this is a smoke check
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run tool')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'tool_use', id: 'bash:smoke', name: 'bash', input: { command: 'sleep 1' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const controller = new AbortController()
    const disp = new ToolDispatcher()
    vi.spyOn(disp, 'executeTool').mockImplementation(async (block) => {
      controller.abort()
      return { toolUseId: block.id, toolName: block.name, result: { output: 'aborted', isError: true }, durationMs: 0 }
    })
    const result = await runConversationLoop(conv, disp, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', signal: controller.signal,
    })
    assertWellFormed(result.conversation.turns)
  })

  it('stream-close before first token (pre-first-token) leaves well-formed conversation', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Do it')
    const { ReadableStream: NodeReadableStream } = await import('node:stream/web')
    const emptyStream = new NodeReadableStream({ start(c) { c.close() } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(emptyStream as any, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
    const disp = new ToolDispatcher()
    const result = await runConversationLoop(conv, disp, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key',
    })
    assertWellFormed(result.conversation.turns)
    expect(result.runtimeFailure?.kind).toBe('pre_first_token_stream_close')
  })

  it('provider thrown error leaves well-formed conversation', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Do it')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const disp = new ToolDispatcher()
    const result = await runConversationLoop(conv, disp, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key',
    })
    assertWellFormed(result.conversation.turns)
  })
})

describe('autoCompact', () => {
  it('reports threshold decisions without mutating conversation', () => {
    const conv = createConversation({ system: '', model: 'm' })
    for (let i = 0; i < 20; i++) {
      addUserMessage(conv, 'X'.repeat(400))
    }
    const decision = getAutoCompactDecision(conv, 2200)
    expect(decision.shouldCompact).toBe(true)
    expect(decision.reason).toBe('threshold')
    expect(decision.thresholdTokens).toBe(1760)
    expect(decision.keepCount).toBe(10)
    expect(conv.turns.length).toBe(20)
  })

  it('reports a below-threshold decision for 1M context windows', () => {
    const conv = createConversation({ system: '', model: 'gpt-4.1' })
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, 'X'.repeat(40_000))
    }
    const decision = getAutoCompactDecision(conv, 1_000_000)
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('below_threshold')
    expect(decision.thresholdTokens).toBe(800_000)
  })

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

  it('does not compact a 100K-token conversation under a 1M context window', () => {
    const conv = createConversation({ system: '', model: 'gpt-4.1' })
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, 'X'.repeat(40_000))
    }
    expect(autoCompact(conv, 1_000_000)).toBe(false)
    expect(conv.turns.length).toBe(10)
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
