import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createConversationMock,
  addUserMessageMock,
  runConversationLoopMock,
} = vi.hoisted(() => ({
  createConversationMock: vi.fn(),
  addUserMessageMock: vi.fn(),
  runConversationLoopMock: vi.fn(),
}))

vi.mock('../../../src/native/conversation.js', () => ({
  createConversation: createConversationMock,
  addUserMessage: addUserMessageMock,
  runConversationLoop: runConversationLoopMock,
}))

import { createAgentTool } from '../../../src/native/tools/agent.js'

describe('Agent Tool', () => {
  beforeEach(() => {
    createConversationMock.mockReset()
    addUserMessageMock.mockReset()
    runConversationLoopMock.mockReset()

    createConversationMock.mockImplementation((options) => ({
      id: 'sub-conversation',
      system: options.system,
      model: options.model,
      maxTokens: options.maxTokens,
      turns: [],
      tools: options.tools,
    }))

    runConversationLoopMock.mockResolvedValue({
      finalText: 'done',
      iterations: 1,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('uses the latest active model when getModel is provided', async () => {
    let activeModel = 'initial-model'

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'initial-model',
      getModel: () => activeModel,
      maxTokens: 2048,
    })

    activeModel = 'switched-model'
    await tool.execute({
      description: 'Check a file',
      prompt: 'Inspect the config',
    })

    expect(createConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'switched-model',
    }))
  })

  it('preserves structured provider diagnostics from the shared conversation loop', async () => {
    const onError = vi.fn()
    runConversationLoopMock.mockImplementation(async (_conversation, _dispatcher, opts) => {
      opts.callbacks?.onError?.('kimi-code request failed: upstream 502 from provider (request id: req-upstream)')
      throw new Error('kimi-code request failed: upstream 502 from provider (request id: req-upstream)')
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'kimi-code',
      maxTokens: 2048,
      callbacks: { onError },
    })

    const result = await tool.execute({
      description: 'Investigate provider failure',
      prompt: 'Try the request and report the error',
    })

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('kimi-code request failed: upstream 502 from provider'))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('req-upstream'))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('upstream 502 from provider')
  })

  it('treats runtime continuation failures as agent errors instead of silent completion', async () => {
    runConversationLoopMock.mockResolvedValue({
      finalText: '',
      iterations: 2,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      runtimeFailure: {
        kind: 'pre_first_token_stream_close',
        phase: 'tool_continuation',
        message: 'Tool completed, but model continuation failed before first token. Use /retry to resume or /model to switch.',
        retryable: true,
      },
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'kimi-code',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Continue after tool work',
      prompt: 'Finish the summary',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('continuation failed before first token')
  })

  it('treats silent max_iterations as incomplete instead of successful fallback work', async () => {
    runConversationLoopMock.mockResolvedValue({
      finalText: '',
      iterations: 200,
      stopReason: 'max_iterations',
      usage: { inputTokens: 10, outputTokens: 20 },
      runtimeFailure: null,
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'minimax-m27',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Long audit',
      prompt: 'Run a long audit and report final findings.',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Agent incomplete')
    expect(result.output).toContain('stop_reason=max_iterations')
    expect(result.metadata?.['agentIncomplete']).toBe(true)
    expect(result.metadata?.['terminalToolFailure']).toBe(true)
  })

  it('uses a larger default sub-agent iteration budget for long-task work', async () => {
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'minimax-m27',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Long audit',
      prompt: 'Run a long audit and report final findings.',
    })

    expect(runConversationLoopMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxIterations: 200 }),
    )
  })

  it('uses 80 iterations as the default Explore sub-agent budget', async () => {
    // Explore agents are read-only and used for fast scoped lookups —
    // their natural budget is smaller than the general-purpose 200,
    // matching the upstream Claude Code Explore preset and the cmux
    // 0.13.20 evidence (live run reported "80 iterations,
    // stop_reason=max_iterations" for an Explore call).
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'minimax-m27',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Quick lookup',
      prompt: 'Find the relevant file references.',
      subagent_type: 'Explore',
    })

    expect(runConversationLoopMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxIterations: 80 }),
    )
  })

  it('honours an explicit max_iterations input above the default for long Explore runs', async () => {
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'minimax-m27',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Deep audit',
      prompt: 'Audit the entire pipeline carefully.',
      subagent_type: 'Explore',
      max_iterations: 150,
    })

    expect(runConversationLoopMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxIterations: 150 }),
    )
  })

  it('honours an explicit max_iterations override below the general-purpose default', async () => {
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'minimax-m27',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Quick task',
      prompt: 'Sketch a single-file change.',
      max_iterations: 25,
    })

    expect(runConversationLoopMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxIterations: 25 }),
    )
  })

  it('reads OWLCODA_AGENT_MAX_ITERATIONS as the general-purpose default override', async () => {
    const original = process.env['OWLCODA_AGENT_MAX_ITERATIONS']
    process.env['OWLCODA_AGENT_MAX_ITERATIONS'] = '120'
    try {
      const tool = createAgentTool({
        apiBaseUrl: 'http://127.0.0.1:9999',
        apiKey: 'test-key',
        model: 'minimax-m27',
        maxTokens: 2048,
      })

      await tool.execute({
        description: 'Long audit',
        prompt: 'Run the long audit.',
      })

      expect(runConversationLoopMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ maxIterations: 120 }),
      )
    } finally {
      if (original === undefined) {
        delete process.env['OWLCODA_AGENT_MAX_ITERATIONS']
      } else {
        process.env['OWLCODA_AGENT_MAX_ITERATIONS'] = original
      }
    }
  })

  it('reads OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS as the Explore default override', async () => {
    const original = process.env['OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS']
    process.env['OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS'] = '40'
    try {
      const tool = createAgentTool({
        apiBaseUrl: 'http://127.0.0.1:9999',
        apiKey: 'test-key',
        model: 'minimax-m27',
        maxTokens: 2048,
      })

      await tool.execute({
        description: 'Tight Explore',
        prompt: 'Lookup a single symbol.',
        subagent_type: 'Explore',
      })

      expect(runConversationLoopMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ maxIterations: 40 }),
      )
    } finally {
      if (original === undefined) {
        delete process.env['OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS']
      } else {
        process.env['OWLCODA_EXPLORE_AGENT_MAX_ITERATIONS'] = original
      }
    }
  })
})
