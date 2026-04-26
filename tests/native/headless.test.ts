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

  // ─── Issue #1: headless approval gate ────────────────────────────────────

  it('installs onToolApproval in non-json mode (so unsafe tools cannot bypass approval)', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onToolApproval).toBeTypeOf('function')
  })

  it('installs onToolApproval in json mode (regression for issue #1 — was missing)', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })
    const loopCall = vi.mocked(runConversationLoop).mock.calls[0]!
    const opts = loopCall[2]
    expect(opts.callbacks?.onToolApproval).toBeTypeOf('function')
  })

  it('installed approval callback denies unsafe tools without autoApprove', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    expect(await cb('write', { path: '/tmp/x' })).toBe(false)
    expect(await cb('edit', { path: '/tmp/x' })).toBe(false)
    expect(await cb('NotebookEdit', { notebook_path: '/tmp/x.ipynb' })).toBe(false)
    expect(await cb('bash', { command: 'rm -rf /' })).toBe(false)
    // Read-only tools must remain low-friction.
    expect(await cb('read', { path: '/tmp/x' })).toBe(true)
    expect(await cb('grep', { pattern: 'foo' })).toBe(true)
  })

  it('installed approval callback allows unsafe tools when autoApprove=true', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      autoApprove: true,
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    expect(await cb('write', { path: '/tmp/x' })).toBe(true)
    expect(await cb('bash', { command: 'echo hi' })).toBe(true)
  })

  it('result and JSON output expose the approval policy', async () => {
    const result = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
    })
    expect(result.approvalPolicy).toBe('deny-unsafe-without-approval')
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"approval_policy":"deny-unsafe-without-approval"'),
    )

    const result2 = await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
      json: true,
      autoApprove: true,
    })
    expect(result2.approvalPolicy).toBe('auto-approve-all')
  })

  it('records denials and surfaces them in the result', async () => {
    await runHeadless({
      apiBaseUrl: 'http://localhost:8019',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Hello',
    })
    const cb = vi.mocked(runConversationLoop).mock.calls[0]![2].callbacks!.onToolApproval!
    await cb('write', { path: '/tmp/x' })
    await cb('read', { path: '/tmp/x' })
    await cb('bash', { command: 'pwd' })          // safe-readonly — allowed under P1 classifier
    await cb('bash', { command: 'rm -rf /tmp/y' }) // dangerous — denied
    // We can't easily re-read the headless result here (it's closed over the
    // call we already returned from), but the stderr-write side effect for
    // each denial is observable.
    const stderrCalls = stderrWrite.mock.calls.map(c => String(c[0]))
    const denialMessages = stderrCalls.filter(s => s.includes('denied by headless approval policy'))
    expect(denialMessages.length).toBeGreaterThanOrEqual(2)
    expect(denialMessages.some(m => m.includes('write'))).toBe(true)
    expect(denialMessages.some(m => m.includes('bash'))).toBe(true)
    // P1 issue #2: the structured bash-risk detail is covered by
    // tests/native/headless-approval.test.ts and serializeDenials in
    // the JSON output. Stderr-side rendering of risk=<level> is a UX
    // nicety subject to banner-box wrapping; not asserted here to avoid
    // brittleness.
  })
})
