import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the conversation module
vi.mock('../../src/native/conversation.js', () => ({
  createConversation: vi.fn(({ system, model, maxTokens, tools }) => ({
    id: 'test-conv',
    system,
    model,
    maxTokens,
    tools: tools ?? [],
    turns: [],
  })),
  addUserMessage: vi.fn((conv, text) => {
    conv.turns.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
  }),
  runConversationLoop: vi.fn(async () => ({
    conversation: { turns: [] },
    finalText: 'Hello from headless!',
    iterations: 1,
  })),
}))

// Mock the tool-defs module
vi.mock('../../src/native/tool-defs.js', () => ({
  buildNativeToolDefs: () => [
    { name: 'bash', description: 'Native bash tool', input_schema: {} },
    { name: 'read', description: 'Native read tool', input_schema: {} },
  ],
}))

import { runHeadless } from '../../src/native/headless.js'
import { runConversationLoop, addUserMessage } from '../../src/native/conversation.js'

describe('runHeadless', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runConversationLoop).mockReset()
    vi.mocked(runConversationLoop).mockResolvedValue({
      conversation: { turns: [] } as any,
      finalText: 'Hello from headless!',
      iterations: 1,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
      runtimeFailure: null,
    })
    process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS'] = '0'
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS']
    delete process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  it('sends prompt to conversation loop and returns result', async () => {
    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello world',
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Hello from headless!')
    expect(result.iterations).toBe(1)

    expect(addUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model' }),
      'Hello world',
    )

    expect(runConversationLoop).toHaveBeenCalled()
  })

  it('streams text to stdout in non-json mode', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })

    // Callbacks are set up for stdout/stderr — verify they're function-typed
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onText).toBeTypeOf('function')
    expect(opts.callbacks?.onError).toBeTypeOf('function')
  })

  it('suppresses streaming in json mode', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })

    // JSON result is written to stdout
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"text":"Hello from headless!"'),
    )

    // In JSON mode, callbacks should be empty (no streaming)
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onText).toBeUndefined()
  })

  it('handles errors gracefully', async () => {
    vi.mocked(runConversationLoop).mockRejectedValueOnce(new Error('connection refused'))

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })

    expect(result.exitCode).toBe(1)
    expect(result.text).toBe('')
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    )
  })

  it('automatically continues the same conversation after a retryable runtime failure', async () => {
    vi.mocked(runConversationLoop)
      .mockResolvedValueOnce({
        conversation: { turns: [] } as any,
        finalText: '',
        iterations: 2,
        stopReason: null,
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: {
          kind: 'provider_error',
          phase: 'tool_continuation',
          message: 'Server shutting down',
          retryable: true,
        },
      })
      .mockResolvedValueOnce({
        conversation: { turns: [] } as any,
        finalText: 'Recovered and finished',
        iterations: 3,
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
        runtimeFailure: null,
      })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Do a long task',
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Recovered and finished')
    expect(result.iterations).toBe(5)
    expect(result.runtimeRetries).toBe(1)
    expect(runConversationLoop).toHaveBeenCalledTimes(2)
    expect(runConversationLoop.mock.calls[1]![0]).toBe(runConversationLoop.mock.calls[0]![0])
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Continuing automatically'))
  })

  it('exits with preserved session details after runtime resume retries are exhausted', async () => {
    process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES'] = '1'
    vi.mocked(runConversationLoop).mockResolvedValue({
      conversation: { turns: [] } as any,
      finalText: '',
      iterations: 1,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, requestCount: 1 },
      runtimeFailure: {
        kind: 'timeout',
        phase: 'continuation',
        message: 'request timed out',
        retryable: true,
      },
    })

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Do a long task',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.runtimeRetries).toBe(1)
    expect(runConversationLoop).toHaveBeenCalledTimes(2)
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('"runtime_failure"'))
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Runtime resume retries exhausted'))
  })

  it('outputs JSON error in json mode', async () => {
    vi.mocked(runConversationLoop).mockRejectedValueOnce(new Error('timeout'))

    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })

    expect(result.exitCode).toBe(1)
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"error":"timeout"'),
    )
  })

  it('uses custom system prompt', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      systemPrompt: 'You are a cat.',
    })

    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const conversation = loopCall[0]
    expect(conversation.system).toBe('You are a cat.')
  })

  it('respects maxTokens option', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      maxTokens: 8192,
    })

    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const conversation = loopCall[0]
    expect(conversation.maxTokens).toBe(8192)
  })
})
