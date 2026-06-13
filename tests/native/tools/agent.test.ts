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

import { createAgentTool, __getAgentSemaphoreStateForTesting } from '../../../src/native/tools/agent.js'
import {
  __resetAdaptiveConcurrencyForTesting,
} from '../../../src/native/adaptive-concurrency.js'

describe('Agent Tool', () => {
  beforeEach(() => {
    delete process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY']
    delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']
    delete process.env['OWLCODA_SUBAGENT_MODEL']
    __resetAdaptiveConcurrencyForTesting()

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

  // 2026-06-13 dogfood (P0-8): a parent on a local model (mimo, backed by one
  // proxy) fanned out 4 sub-agents; the proxy died and all 4 sub-agents +
  // parent failed together because sub-agents had no way to run on a different
  // model. Allow the parent LLM (input.model) and the operator
  // (OWLCODA_SUBAGENT_MODEL) to give orchestration sub-agents their own model.
  it('uses input.model to override the parent conversation model when provided', async () => {
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'parent-model',
      getModel: () => 'parent-model',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Orchestrate work',
      prompt: 'coordinate the batch',
      model: 'orchestration-model',
    })

    expect(createConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'orchestration-model',
    }))
  })

  it('falls back to OWLCODA_SUBAGENT_MODEL when input.model is absent', async () => {
    process.env['OWLCODA_SUBAGENT_MODEL'] = 'env-default-model'

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'parent-model',
      getModel: () => 'parent-model',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Orchestrate work',
      prompt: 'coordinate the batch',
    })

    expect(createConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'env-default-model',
    }))
  })

  it('prefers input.model over OWLCODA_SUBAGENT_MODEL', async () => {
    process.env['OWLCODA_SUBAGENT_MODEL'] = 'env-default-model'

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'parent-model',
      getModel: () => 'parent-model',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Orchestrate work',
      prompt: 'coordinate the batch',
      model: 'explicit-model',
    })

    expect(createConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'explicit-model',
    }))
  })

  it('ignores a blank input.model and falls back to the parent model', async () => {
    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'parent-model',
      getModel: () => 'parent-model',
      maxTokens: 2048,
    })

    await tool.execute({
      description: 'Orchestrate work',
      prompt: 'coordinate the batch',
      model: '   ',
    })

    expect(createConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'parent-model',
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
    // 2026-05-28 Patch 8: the runConversationLoop normal-return path with
    // runtimeFailure ≠ null previously emitted a raw "Agent error: ..." string
    // without the isolation wrapper, metadata trio, or telemetry event.
    // R7-1 (3383e18) covered four catch branches but missed this ninth path.
    expect(result.output).toContain('[Sub-agent failed in isolation')
    expect(result.output).toContain('How the parent should handle this failure')
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('failed')
    expect(result.metadata?.['failureCategory']).toBe('agent:provider_error')
    expect(result.metadata?.['terminalToolFailure']).toBeUndefined()
  })

  it('classifies runtimeFailure timeout kinds as watchdog_timeout reason', async () => {
    runConversationLoopMock.mockResolvedValue({
      finalText: '',
      iterations: 1,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      runtimeFailure: {
        kind: 'stream_idle_timeout',
        phase: 'request',
        message: 'Stream went idle past 600s without producing further tokens.',
        retryable: false,
      },
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'mimo-v25-pro',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Slow research',
      prompt: 'Do a long-running research task',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('[Sub-agent failed in isolation')
    expect(result.output).toContain('reason: watchdog_timeout')
    expect(result.metadata?.['failureCategory']).toBe('agent:watchdog_timeout')
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
  })

  it('classifies cooperative watchdog-abort normal return as watchdog_timeout before no_deliverable', async () => {
    const prevIdle = process.env['OWLCODA_AGENT_IDLE_TIMEOUT_MS']
    const prevMax = process.env['OWLCODA_AGENT_MAX_RUNTIME_MS']
    process.env['OWLCODA_AGENT_IDLE_TIMEOUT_MS'] = '1'
    process.env['OWLCODA_AGENT_MAX_RUNTIME_MS'] = '0'
    try {
      runConversationLoopMock.mockImplementation(async (conversation, _dispatcher, opts) => {
        conversation.options = {
          taskState: makeTaskState({
            objective: 'Write /tmp/watchdog-result.md',
            sourceText: 'Write /tmp/watchdog-result.md',
            touchedPaths: [],
            allowedWritePaths: [{ path: '/tmp/watchdog-result.md', kind: 'file', origin: 'user-external' }],
          }),
        }
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve()
            return
          }
          opts.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          finalText: '',
          iterations: 3,
          stopReason: 'tool_use',
          usage: { inputTokens: 4, outputTokens: 2 },
          runtimeFailure: null,
        }
      })

      const tool = createAgentTool({
        apiBaseUrl: 'http://127.0.0.1:9999',
        apiKey: 'test-key',
        model: 'mimo-v25-pro',
        maxTokens: 2048,
      })

      const result = await tool.execute({
        description: 'Slow writer',
        prompt: 'Write /tmp/watchdog-result.md',
      })

      expect(result.isError).toBe(true)
      expect(result.output).toContain('reason: watchdog_timeout')
      expect(result.output).toContain('idle timeout')
      expect(result.output).not.toContain('required file output')
      expect(result.metadata?.['failureCategory']).toBe('agent:watchdog_timeout')
      expect(result.metadata?.['timeoutKind']).toBe('idle')
      expect(result.metadata?.['stopReason']).toBe('tool_use')
      expect(result.metadata?.['iterations']).toBe(3)
      expect(result.metadata?.['agentNoDeliverable']).toBeUndefined()
      expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    } finally {
      if (prevIdle === undefined) delete process.env['OWLCODA_AGENT_IDLE_TIMEOUT_MS']
      else process.env['OWLCODA_AGENT_IDLE_TIMEOUT_MS'] = prevIdle
      if (prevMax === undefined) delete process.env['OWLCODA_AGENT_MAX_RUNTIME_MS']
      else process.env['OWLCODA_AGENT_MAX_RUNTIME_MS'] = prevMax
    }
  })

  it('treats runtimeFailure abort kind as cancellation without routing wrap', async () => {
    runConversationLoopMock.mockResolvedValue({
      finalText: '',
      iterations: 0,
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      runtimeFailure: {
        kind: 'abort',
        phase: 'request',
        message: 'Aborted by user',
        retryable: false,
      },
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'kimi-code',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Quick task',
      prompt: 'Cancelled before start',
    })

    expect(result.isError).toBe(true)
    // Abort path mirrors the catch-branch convention: plain "Agent cancelled"
    // with NO routing wrap (parent already initiated the cancel — routing
    // guidance is noise for a user-driven stop).
    expect(result.output).toBe('Agent cancelled')
    expect(result.output).not.toContain('[Sub-agent failed in isolation')
    expect(result.metadata?.['cancelled']).toBe(true)
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(result.metadata?.['failureCategory']).toBe('agent:aborted')
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
    // 2026-05-27 sub-agent failure isolation hotfix: sub-agent failures
    // are isolated (parent decides retry/skip/abort), not terminal.
    expect(result.metadata?.['terminalToolFailure']).toBeUndefined()
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('failed')
    expect(result.metadata?.['failureCategory']).toBe('agent:max_iterations')
  })

  it('treats write-required sub-agent completion with no touched paths as incomplete', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Write the deck to /tmp/owlcoda-agent-output.html',
          sourceText: 'Write the deck to /tmp/owlcoda-agent-output.html',
          touchedPaths: [],
          scratchArtifactPaths: ['/tmp/gen_deck.py'],
          allowedWritePaths: [
            { path: '/tmp/owlcoda-agent-output.html', kind: 'file', origin: 'user-external' },
          ],
        }),
      }
      return {
        finalText: 'I have gathered everything and will now create the deck.',
        iterations: 18,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        runtimeFailure: null,
      }
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'mimo-v25-pro',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Build deck',
      prompt: 'Write the deck to /tmp/owlcoda-agent-output.html',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('required file output')
    expect(result.output).toContain('without touching any durable path')
    expect(result.metadata?.['agentNoDeliverable']).toBe(true)
    expect(result.metadata?.['failureCategory']).toBe('agent:no_deliverable')
    // Isolation hotfix: this failure shape pre-2026-05-27 set
    // terminalToolFailure=true, which dispatch.ts upgraded to a parent
    // terminal_tool_failure — killing sibling sub-agents in a fan-out.
    expect(result.metadata?.['terminalToolFailure']).toBeUndefined()
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('failed')
  })

  it('allows write-required sub-agent completion when a durable path was touched', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Write the deck to /tmp/owlcoda-agent-output.html',
          sourceText: 'Write the deck to /tmp/owlcoda-agent-output.html',
          touchedPaths: ['/tmp/owlcoda-agent-output.html'],
          allowedWritePaths: [
            { path: '/tmp/owlcoda-agent-output.html', kind: 'file', origin: 'user-external' },
          ],
        }),
      }
      return {
        finalText: 'Deck written to /tmp/owlcoda-agent-output.html.',
        iterations: 6,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        runtimeFailure: null,
      }
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'mimo-v25-pro',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Build deck',
      prompt: 'Write the deck to /tmp/owlcoda-agent-output.html',
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Deck written')
  })

  it('does not require touched paths for text-deliverable sub-agent work', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Audit the deck plan and provide a summary',
          sourceText: 'Audit the deck plan and provide a summary',
          touchedPaths: [],
        }),
      }
      return {
        finalText: 'Summary: the structure is coherent.',
        iterations: 4,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        runtimeFailure: null,
      }
    })

    const tool = createAgentTool({
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'test-key',
      model: 'mimo-v25-pro',
      maxTokens: 2048,
    })

    const result = await tool.execute({
      description: 'Audit deck',
      prompt: 'Audit the deck plan and provide a summary',
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Summary')
  })

  // ─── Slice 5: expectedArtifacts contract ────────────────────────────

  it('expectedArtifacts: file touched exactly → success', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Generate deck to /tmp/deck.html',
          sourceText: 'Generate deck to /tmp/deck.html',
          touchedPaths: ['/tmp/deck.html'],
        }),
      }
      return { finalText: 'Done.', iterations: 3, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate deck',
      expectedArtifacts: [{ path: '/tmp/deck.html', kind: 'file', origin: 'explicit' }],
      parentTaskId: 'task-1',
      parentStepId: 'step-2',
    })
    expect(result.isError).toBe(false)
    expect(result.metadata?.['artifactMatched']).toBe(true)
    expect(result.metadata?.['parentTaskId']).toBe('task-1')
    expect(result.metadata?.['parentStepId']).toBe('step-2')
    expect(result.metadata?.['touchedPaths']).toEqual(['/tmp/deck.html'])
  })

  it('expectedArtifacts: directory child touched → success (basename match)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: ['/tmp/out/deck.html'],
        }),
      }
      return { finalText: 'Done.', iterations: 2, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate',
      expectedArtifacts: [{ path: '/tmp/deck.html', kind: 'file', origin: 'explicit' }],
    })
    // basename match: deck.html appears in touched path
    expect(result.isError).toBe(false)
  })

  it('expectedArtifacts: no touched paths → error', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: [],
        }),
      }
      // Final text intentionally does NOT claim completion — keeps this
      // path on the partial-classification branch. The inferred (claim-
      // completion-but-no-artifact) branch is covered separately in the
      // "artifact_contract inferred vs partial detection" describe block.
      return { finalText: '(no completion claim)', iterations: 2, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate',
      expectedArtifacts: [{ path: '/tmp/deck.html', kind: 'file', origin: 'explicit' }],
    })
    expect(result.isError).toBe(true)
    expect(result.metadata?.['failureCategory']).toBe('agent:artifact_contract')
    expect(result.metadata?.['artifactMatched']).toBe(false)
    expect(result.output).toContain('artifact contract failed')
    expect(result.output).toContain('/tmp/deck.html')
    // Isolation hotfix: artifact contract failure is partial (some touched
    // paths may exist), so parent gets isolated signal not terminal.
    expect(result.metadata?.['terminalToolFailure']).toBeUndefined()
    expect(result.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('partial')
  })

  it('expectedArtifacts: sibling file touched → error (different basename)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: ['/tmp/slides.html'],
        }),
      }
      return { finalText: 'Done.', iterations: 2, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate',
      expectedArtifacts: [{ path: '/tmp/deck.html', kind: 'file', origin: 'explicit' }],
    })
    // slides.html ≠ deck.html — should fail
    expect(result.isError).toBe(true)
    expect(result.metadata?.['failureCategory']).toBe('agent:artifact_contract')
  })

  it('no expectedArtifacts on text-deliverable → success (contract not enforced)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Research topic X',
          sourceText: 'Research topic X',
          touchedPaths: [],
        }),
      }
      return { finalText: 'Here is my research.', iterations: 5, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'research',
      prompt: 'Research topic X',
      // no expectedArtifacts
      parentTaskId: 'task-7',
      parentStepId: 'step-3',
    })
    expect(result.isError).toBe(false)
    expect(result.metadata?.['parentTaskId']).toBe('task-7')
    expect(result.metadata?.['parentStepId']).toBe('step-3')
    expect(result.metadata?.['artifactMatched']).toBeNull() // null when no contract
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
    // matching the upstream external coding-assistant Explore preset and the cmux
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

// ---------------------------------------------------------------------------
// 2026-05-28 Patch 4: isolated-failure output structured header + routing
// guidance (R7 review follow-up).
//
// Pre-fix, the isolation contract carried routing signals in metadata
// (subAgentIsolatedFailure / completion_status / failureCategory). But the
// parent LLM never sees metadata — only the tool_result content (`output`
// string). So a parent LLM looking at a failed Agent call had no structured
// way to route ("retry once / skip / abort") and could fall back to
// re-dispatching the same prompt.
//
// Post-fix, every isolated-failure path wraps its detail text with a
// greppable header and explicit routing options, so the parent LLM has the
// same routing guidance the metadata gave to programmatic consumers.
// ---------------------------------------------------------------------------

describe('isolated-failure output structured header + routing guidance', () => {
  it('no_deliverable failure output carries structured header + standard routing', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Write the deck to /tmp/owlcoda-pkg4-out.html',
          sourceText: 'Write the deck to /tmp/owlcoda-pkg4-out.html',
          touchedPaths: [],
          allowedWritePaths: [{ path: '/tmp/owlcoda-pkg4-out.html', kind: 'file', origin: 'user-external' }],
        }),
      }
      return { finalText: 'gathered notes', iterations: 9, stopReason: 'task_no_progress', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({ description: 'Build deck', prompt: 'Write the deck to /tmp/owlcoda-pkg4-out.html' })

    expect(result.isError).toBe(true)
    // Structured header — parser-friendly and explicit about status/reason.
    expect(result.output).toContain('[Sub-agent failed in isolation — status: failed, reason: no_deliverable]')
    // Routing block: the LLM-readable form of completion_status routing.
    expect(result.output).toContain('Choose ONE of:')
    expect(result.output).toContain('Retry once with a narrower prompt')
    expect(result.output).toContain('Skip this deliverable and flag it in your final summary')
    expect(result.output).toContain('Abort the whole parent task ONLY if this deliverable is a hard')
    expect(result.output).toContain('Do NOT re-dispatch the same prompt unchanged')
    // Detail text is still present (unchanged from pre-Patch-4 behaviour).
    expect(result.output).toContain('required file output')
  })

  it('artifact_contract failure uses status: partial (not failed)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: ['/tmp/half-done.md'],
        }),
      }
      return { finalText: 'Wrote half.', iterations: 3, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate',
      expectedArtifacts: [{ path: '/tmp/final.md', kind: 'file', origin: 'explicit' }],
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('[Sub-agent failed in isolation — status: partial, reason: artifact_contract]')
    // Some routing still applies — partial deliverable is still a routing decision.
    expect(result.output).toContain('Choose ONE of:')
  })

  it('max_iterations failure carries max_iterations reason in header', async () => {
    runConversationLoopMock.mockResolvedValue({
      finalText: '',
      iterations: 200,
      stopReason: 'max_iterations',
      usage: { inputTokens: 1, outputTokens: 1 },
      runtimeFailure: null,
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({ description: 'Long', prompt: 'Loop forever' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('[Sub-agent failed in isolation — status: failed, reason: max_iterations]')
    expect(result.output).toContain('Do NOT re-dispatch the same prompt unchanged')
    // Detail text from summarizeSilentAgent still present.
    expect(result.output).toContain('stop_reason=max_iterations')
  })
})

// ---------------------------------------------------------------------------
// 2026-05-28 Patch 6: completion_status: 'inferred' narrow detector.
//
// When the sub-agent's final text claims completion BUT expectedArtifacts
// are not fully satisfied, the result is HIGH RISK ("inferred"). The
// parent must NOT silently skip — that would propagate a false completion
// claim into the user-facing summary. Routing block must be the strict
// INFERRED variant (verify directly or abort), not the standard one.
// ---------------------------------------------------------------------------

describe('artifact_contract inferred vs partial detection', () => {
  it('artifact_contract + finalText claims completion → status: inferred (HIGH RISK)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: [],
        }),
      }
      // Critical: finalText claims completion despite producing nothing.
      return {
        finalText: 'Done. Generated /tmp/deck.html with all 12 sections.',
        iterations: 5,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        runtimeFailure: null,
      }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate deck',
      expectedArtifacts: [{ path: '/tmp/deck.html', kind: 'file', origin: 'explicit' }],
    })

    expect(result.isError).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('inferred')
    expect(result.metadata?.['inferredCompletionClaim']).toBe(true)
    // Output header reflects inferred status.
    expect(result.output).toContain('[Sub-agent failed in isolation — status: inferred, reason: artifact_contract]')
    // INFERRED routing block — strict guidance, no "skip" option.
    expect(result.output).toContain('HIGH-RISK failure')
    expect(result.output).toContain('Verify directly')
    expect(result.output).toContain('Do NOT silently skip this failure')
    expect(result.output).toContain('false completion claim')
    // Critical: standard "skip and flag" option must NOT appear in inferred routing.
    expect(result.output).not.toContain('Skip this deliverable and flag it in your final summary')
  })

  it('artifact_contract + finalText does NOT claim completion → status: partial (standard routing)', async () => {
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'gen',
          sourceText: 'gen',
          touchedPaths: ['/tmp/half.md'],
        }),
      }
      // finalText is descriptive but does NOT claim completion.
      return {
        finalText: 'I gathered the data but ran into a parser error before writing.',
        iterations: 3,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        runtimeFailure: null,
      }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'gen',
      prompt: 'generate final',
      expectedArtifacts: [{ path: '/tmp/final.md', kind: 'file', origin: 'explicit' }],
    })

    expect(result.isError).toBe(true)
    expect(result.metadata?.['completion_status']).toBe('partial')
    expect(result.metadata?.['inferredCompletionClaim']).toBe(false)
    // Standard routing — skip+flag IS a legitimate option for partial.
    expect(result.output).toContain('[Sub-agent failed in isolation — status: partial, reason: artifact_contract]')
    expect(result.output).toContain('Skip this deliverable and flag it in your final summary')
    // INFERRED-specific phrasing must NOT appear.
    expect(result.output).not.toContain('HIGH-RISK failure')
    expect(result.output).not.toContain('false completion claim')
  })

  it('read-only / text-deliverable agent (empty expectedArtifacts) is never marked inferred', async () => {
    // The narrowness guarantee: inferred is gated on expectedArtifacts non-empty,
    // so research / text-deliverable agents that legitimately touch 0 paths
    // are unaffected — they take the success branch, not the inferred branch.
    runConversationLoopMock.mockImplementation(async (conversation) => {
      conversation.options = {
        taskState: makeTaskState({
          objective: 'Research X',
          sourceText: 'Research X',
          touchedPaths: [],
        }),
      }
      return {
        finalText: 'Done. Here is the research summary: ...',
        iterations: 6,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        runtimeFailure: null,
      }
    })
    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const result = await tool.execute({
      description: 'research',
      prompt: 'Research topic X',
      // No expectedArtifacts — text-deliverable agent.
    })

    // Should succeed (no isError, no inferred).
    expect(result.isError).toBe(false)
    expect(result.metadata?.['completion_status']).toBeUndefined()
    expect(result.metadata?.['inferredCompletionClaim']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2026-05-28 Patch 5: agent_invocation telemetry event.
//
// One gate-event per Agent tool call, written to
// ~/.owlcoda/telemetry/gate-events-YYYY-MM-DD.jsonl. Attribute keys stay
// stable (`gen_ai.agent.*` / `gen_ai.operation.*`) so downstream exporters
// do not need runtime re-instrumentation.
// ---------------------------------------------------------------------------

describe('agent_invocation telemetry event', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')

  function readTodaysEvents(homeDir: string): Array<Record<string, unknown>> {
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(homeDir, 'telemetry', `gate-events-${date}.jsonl`)
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
  }

  it('emits agent_invocation event with status=success on a clean run', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-agent-invok-success-'))
    const prevHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = tmpHome
    try {
      runConversationLoopMock.mockImplementation(async (conversation) => {
        conversation.options = {
          taskState: makeTaskState({
            objective: 'Run X',
            sourceText: 'Run X',
            touchedPaths: ['/tmp/x.md'],
          }),
        }
        return { finalText: 'OK done.', iterations: 4, stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8 }, runtimeFailure: null }
      })
      const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
      const result = await tool.execute({ description: 'simple', prompt: 'do x' })
      expect(result.isError).toBe(false)

      const events = readTodaysEvents(tmpHome).filter((e) => e['kind'] === 'agent_invocation')
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev['agentStatus']).toBe('success')
      expect(ev['agentType']).toBe('general-purpose')
      expect(ev['agentIterations']).toBe(4)
      expect(ev['agentStopReason']).toBe('end_turn')
      expect(ev['agentInputTokens']).toBe(12)
      expect(ev['agentOutputTokens']).toBe(8)
      expect(ev['agentTouchedPathCount']).toBe(1)
      expect(ev['agentTouchedPaths']).toEqual(['/tmp/x.md'])
      expect(ev['agentExpectedArtifactPaths']).toEqual([])
    } finally {
      if (prevHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = prevHome
      try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* swallow */ }
    }
  })

  it('emits agent_invocation event with status=failed on no_deliverable', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-agent-invok-failed-'))
    const prevHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = tmpHome
    try {
      runConversationLoopMock.mockImplementation(async (conversation) => {
        conversation.options = {
          taskState: makeTaskState({
            objective: 'Write the deck to /tmp/required.html',
            sourceText: 'Write the deck to /tmp/required.html',
            touchedPaths: [],
            allowedWritePaths: [{ path: '/tmp/required.html', kind: 'file', origin: 'user-external' }],
          }),
        }
        return { finalText: 'thinking', iterations: 9, stopReason: 'task_no_progress', usage: { inputTokens: 2, outputTokens: 1 }, runtimeFailure: null }
      })
      const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
      const result = await tool.execute({ description: 'build', prompt: 'Write the deck to /tmp/required.html' })
      expect(result.isError).toBe(true)

      const events = readTodaysEvents(tmpHome).filter((e) => e['kind'] === 'agent_invocation')
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev['agentStatus']).toBe('failed')
      expect(ev['agentFailureCategory']).toBe('agent:no_deliverable')
      expect(ev['agentStopReason']).toBe('task_no_progress')
      expect(ev['agentTouchedPathCount']).toBe(0)
      expect(ev['agentTouchedPaths']).toEqual([])
      expect(ev['agentExpectedArtifactPaths']).toEqual([])
    } finally {
      if (prevHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = prevHome
      try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* swallow */ }
    }
  })

  it('emits agent_invocation event with status=inferred on artifact_contract + completion claim', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-agent-invok-inferred-'))
    const prevHome = process.env['OWLCODA_HOME']
    process.env['OWLCODA_HOME'] = tmpHome
    try {
      runConversationLoopMock.mockImplementation(async (conversation) => {
        conversation.options = {
          taskState: makeTaskState({
            objective: 'gen',
            sourceText: 'gen',
            touchedPaths: [],
          }),
        }
        return {
          finalText: 'Done. Generated everything you asked for.',
          iterations: 3,
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 5 },
          runtimeFailure: null,
        }
      })
      const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
      const result = await tool.execute({
        description: 'gen',
        prompt: 'generate',
        expectedArtifacts: [{ path: '/tmp/missing.html', kind: 'file', origin: 'explicit' }],
      })
      expect(result.isError).toBe(true)
      expect(result.metadata?.['completion_status']).toBe('inferred')

      const events = readTodaysEvents(tmpHome).filter((e) => e['kind'] === 'agent_invocation')
      expect(events).toHaveLength(1)
      expect(events[0]!['agentStatus']).toBe('inferred')
      expect(events[0]!['agentFailureCategory']).toBe('agent:artifact_contract')
      expect(events[0]!['agentExpectedArtifactCount']).toBe(1)
      expect(events[0]!['agentExpectedArtifactPaths']).toEqual(['/tmp/missing.html'])
      expect(events[0]!['agentTouchedPathCount']).toBe(0)
      expect(events[0]!['agentTouchedPaths']).toEqual([])
    } finally {
      if (prevHome === undefined) delete process.env['OWLCODA_HOME']
      else process.env['OWLCODA_HOME'] = prevHome
      try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* swallow */ }
    }
  })
})

function makeTaskState(opts: {
  objective: string
  sourceText: string
  touchedPaths: string[]
  allowedWritePaths?: Array<{ path: string; kind: 'file' | 'directory'; origin: string }>
  scratchArtifactPaths?: string[]
}): any {
  return {
    contract: {
      version: 1,
      sourceTurnHash: 'test',
      sourceText: opts.sourceText,
      objective: opts.objective,
      dominantGap: null,
      cwd: '/tmp/owlcoda-agent-test-cwd',
      scopeMode: opts.allowedWritePaths && opts.allowedWritePaths.length > 0 ? 'explicit_paths' : 'workspace',
      explicitWriteTargets: opts.allowedWritePaths?.map((s) => s.path) ?? [],
      allowedWritePaths: opts.allowedWritePaths ?? [],
      touchedPaths: opts.touchedPaths,
      createdAt: 1,
      updatedAt: 1,
      confidence: opts.allowedWritePaths && opts.allowedWritePaths.length > 0 ? 'high' : 'low',
    },
    run: {
      status: 'open',
      iterations: 0,
      lifetimeIterations: 0,
      productionGateFired: false,
      scratchArtifactPaths: opts.scratchArtifactPaths ?? [],
      currentFocus: null,
      lastProgressAt: 1,
      lastGuardReason: null,
      lastUpdatedAt: 1,
    },
  }
}

// ---------------------------------------------------------------------------
// 2026-05-28 Sub-agent concurrency semaphore (Patch 2)
//
// Default OWLCODA_AGENT_MAX_CONCURRENCY=1: even when the parent fans out N
// Agent tool calls in one turn, only one upstream conversation opens at a
// time. Subsequent calls wait in an internal queue. This prevents
// upstream-cluster rate-limit bursts (e.g. the mimo-v25-pro
// "Cluster rate limit exceeded, request queued but not admitted" 400s
// captured in audit log 2026-05-28T03:11:02..05).
// ---------------------------------------------------------------------------

describe('Agent semaphore (concurrency throttle)', () => {
  it('serializes two concurrent Agent calls under default max=1', async () => {
    delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']

    let inFlightObservedDuringFirst = 0
    let inFlightObservedDuringSecond = 0

    // First sub-agent's runConversationLoop pauses long enough for us to
    // observe whether the second call was admitted concurrently.
    runConversationLoopMock.mockImplementationOnce(async () => {
      inFlightObservedDuringFirst = __getAgentSemaphoreStateForTesting().inFlight
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { finalText: 'first done', iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })
    runConversationLoopMock.mockImplementationOnce(async () => {
      inFlightObservedDuringSecond = __getAgentSemaphoreStateForTesting().inFlight
      return { finalText: 'second done', iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })

    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })

    // Fire two calls concurrently — second one should block on semaphore.
    const [r1, r2] = await Promise.all([
      tool.execute({ description: 'first', prompt: 'first' }),
      tool.execute({ description: 'second', prompt: 'second' }),
    ])

    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)
    // Both observed inFlight=1 at runConversationLoop entry — they never
    // overlapped. If the semaphore were missing, the second would have seen 2.
    expect(inFlightObservedDuringFirst).toBe(1)
    expect(inFlightObservedDuringSecond).toBe(1)
    // After both complete, the semaphore drains to 0.
    expect(__getAgentSemaphoreStateForTesting().inFlight).toBe(0)
    expect(__getAgentSemaphoreStateForTesting().waiting).toBe(0)
  })

  it('allows OWLCODA_AGENT_MAX_CONCURRENCY=3 to admit 3 concurrent + queue the 4th', async () => {
    process.env['OWLCODA_AGENT_MAX_CONCURRENCY'] = '3'

    try {
      const observations: Array<{ inFlight: number; waiting: number }> = []

      const pauseUntil: Array<() => void> = []
      const releasers = [0, 1, 2, 3].map((_, i) => new Promise<void>((resolve) => { pauseUntil[i] = resolve }))

      for (let i = 0; i < 4; i++) {
        runConversationLoopMock.mockImplementationOnce(async () => {
          observations.push(__getAgentSemaphoreStateForTesting())
          await releasers[i]
          return { finalText: `done ${i}`, iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
        })
      }

      const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })

      const fired = [0, 1, 2, 3].map((i) => tool.execute({ description: `a${i}`, prompt: `p${i}` }))

      // Give microtasks a chance to enter the first 3 runConversationLoop bodies.
      await new Promise((r) => setTimeout(r, 30))

      // Exactly 3 should be in-flight; the 4th is queued.
      const state = __getAgentSemaphoreStateForTesting()
      expect(state.inFlight).toBe(3)
      expect(state.waiting).toBe(1)

      // Release them one by one; the 4th finally enters.
      for (let i = 0; i < 4; i++) pauseUntil[i]!()

      await Promise.all(fired)

      // The first 3 observed inFlight=3 at entry; the 4th observed inFlight=3
      // (a prior slot released to admit it).
      expect(observations).toHaveLength(4)
      for (const o of observations) {
        expect(o.inFlight).toBeLessThanOrEqual(3)
      }
      expect(__getAgentSemaphoreStateForTesting().inFlight).toBe(0)
    } finally {
      delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']
    }
  })

  // 2026-05-30: adaptive AIMD moved to the daemon cross-process admission gate
  // (src/endpoints/admission.ts). The client semaphore is now a STATIC ceiling
  // (= OWLCODA_AGENT_MAX_CONCURRENCY) when the flag is on — no per-process
  // slow-start, no double control loop. See cross-process coordinator spec §4.5.
  it('client semaphore is a static ceiling (= cap) when the adaptive flag is on — no slow-start', async () => {
    process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'] = '1'
    process.env['OWLCODA_AGENT_MAX_CONCURRENCY'] = '3'

    const releasers: Array<() => void> = []
    const pauses = [0, 1].map((_, i) => new Promise<void>((resolve) => { releasers[i] = resolve }))
    for (let i = 0; i < 2; i++) {
      runConversationLoopMock.mockImplementationOnce(async () => {
        await pauses[i]
        return { finalText: `done ${i}`, iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
      })
    }

    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const first = tool.execute({ description: 'first', prompt: 'first' })
    const second = tool.execute({ description: 'second', prompt: 'second' })

    await new Promise((r) => setTimeout(r, 20))
    // Static ceiling: both admitted immediately (old behavior slow-started to 1).
    expect(__getAgentSemaphoreStateForTesting()).toMatchObject({ inFlight: 2, waiting: 0, max: 3 })

    releasers[0]!(); releasers[1]!()
    await Promise.all([first, second])
    expect(__getAgentSemaphoreStateForTesting()).toMatchObject({ inFlight: 0, waiting: 0, max: 3 })
  })

  it('client cap=3 admits 3 concurrently without waiting on a per-process AIMD ramp', async () => {
    process.env['OWLCODA_AGENT_ADAPTIVE_CONCURRENCY'] = '1'
    process.env['OWLCODA_AGENT_MAX_CONCURRENCY'] = '3'

    const pauseUntil: Array<() => void> = []
    const releasers = [0, 1, 2].map((_, i) => new Promise<void>((resolve) => { pauseUntil[i] = resolve }))
    for (let i = 0; i < 3; i++) {
      runConversationLoopMock.mockImplementationOnce(async () => {
        await releasers[i]
        return { finalText: `done ${i}`, iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
      })
    }

    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })
    const fired = [0, 1, 2].map((i) => tool.execute({ description: `a${i}`, prompt: `p${i}` }))

    await new Promise((r) => setTimeout(r, 20))
    // All three admitted at once (cross-process adaptation now lives in the daemon).
    expect(__getAgentSemaphoreStateForTesting()).toMatchObject({ inFlight: 3, waiting: 0, max: 3 })

    for (let i = 0; i < 3; i++) pauseUntil[i]!()
    await Promise.all(fired)
    expect(__getAgentSemaphoreStateForTesting()).toMatchObject({ inFlight: 0, waiting: 0, max: 3 })
  })

  it('queued acquire rejects with isError when the context signal aborts', async () => {
    delete process.env['OWLCODA_AGENT_MAX_CONCURRENCY']

    // First call holds the only slot.
    let releaseFirst: () => void = () => {}
    runConversationLoopMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      return { finalText: 'first', iterations: 1, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, runtimeFailure: null }
    })

    const tool = createAgentTool({ apiBaseUrl: 'http://127.0.0.1:9999', apiKey: 'test', model: 'm', maxTokens: 100 })

    const firstPromise = tool.execute({ description: 'first', prompt: 'first' })

    // Second call waits on semaphore. Abort before slot frees.
    const controller = new AbortController()
    const secondPromise = tool.execute({ description: 'second', prompt: 'second' }, { signal: controller.signal })

    // Let second enter the wait queue.
    await new Promise((r) => setTimeout(r, 20))
    expect(__getAgentSemaphoreStateForTesting().waiting).toBe(1)

    controller.abort()
    const second = await secondPromise

    expect(second.isError).toBe(true)
    expect(second.output).toMatch(/cancelled while waiting/i)
    expect(second.metadata?.['cancelled']).toBe(true)
    expect(second.metadata?.['subAgentIsolatedFailure']).toBe(true)
    expect(second.metadata?.['completion_status']).toBe('failed')
    expect(second.metadata?.['failureCategory']).toBe('agent:semaphore_acquire')

    // Cleanup: release the first to drain.
    releaseFirst()
    await firstPromise
    expect(__getAgentSemaphoreStateForTesting().inFlight).toBe(0)
    expect(__getAgentSemaphoreStateForTesting().waiting).toBe(0)
  })
})
