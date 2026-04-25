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
})
