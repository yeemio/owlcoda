/**
 * Behavior-level tests for P0 recovery paths:
 * - Hard budget gate (8.1): oversized requests refused before send
 * - Auto-fallback model selection (8.2): fallback list built correctly
 * - Conversation loop recovery (8.3/8.4): context limit, stalls, tool loops
 * - Slash-like literal input safety
 */

import { describe, expect, it, vi } from 'vitest'
import {
  autoCompact,
  isContextLimitError,
  isRetryableError,
  runConversationLoop,
  type ConversationCallbacks,
} from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { MCPManager } from '../../src/native/mcp/manager.js'
import {
  buildSlashPickerItems,
  SLASH_COMMANDS_REQUIRING_ARGS,
} from '../../src/native/repl-shared.js'

// ─── Helpers ───────────────────────────────────────────────────

function makeConversation(turnCount: number, charsPerTurn = 1000) {
  return {
    system: 'You are helpful.',
    model: 'test-model',
    maxTokens: 4096,
    id: 'test-conv',
    turns: Array.from({ length: turnCount }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: [{ type: 'text' as const, text: 'x'.repeat(charsPerTurn) }],
      timestamp: Date.now(),
    })),
    tools: [],
  }
}

// ─── 8.1 Hard budget gate ──────────────────────────────────────

describe('hard budget gate', () => {
  describe('isContextLimitError', () => {
    it('detects code 2013', () => {
      expect(isContextLimitError('invalid params, error code 2013')).toBe(true)
    })

    it('detects "context window" phrasing', () => {
      expect(isContextLimitError('context window exceeds limit')).toBe(true)
    })

    it('detects "prompt is too long"', () => {
      expect(isContextLimitError('The prompt is too long for this model')).toBe(true)
    })

    it('detects "too many tokens"', () => {
      expect(isContextLimitError('Request has too many tokens')).toBe(true)
    })

    it('returns false for normal errors', () => {
      expect(isContextLimitError('Connection refused')).toBe(false)
      expect(isContextLimitError('Internal server error')).toBe(false)
    })
  })

  describe('autoCompact', () => {
    it('compacts when above threshold', () => {
      const conv = makeConversation(20, 5000)
      const result = autoCompact(conv, 10000)
      expect(result).toBe(true)
      expect(conv.turns.length).toBeLessThan(20)
    })

    it('does not compact when below threshold', () => {
      const conv = makeConversation(4, 100)
      const result = autoCompact(conv, 100000)
      expect(result).toBe(false)
      expect(conv.turns.length).toBe(4)
    })

    it('does not compact below 2 turns', () => {
      const conv = makeConversation(2, 100000)
      const result = autoCompact(conv, 100)
      expect(result).toBe(false)
    })
  })

  it('refuses request that exceeds limit after compaction', async () => {
    // Create a conversation so large that even after compaction it won't fit
    // in a tiny context window
    const conv = makeConversation(4, 50000) // 4 turns of 50K chars each = ~50K tokens
    const errors: string[] = []
    const dispatcher = new ToolDispatcher(new MCPManager())

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:1', // won't be reached
      apiKey: 'test',
      contextWindow: 100, // absurdly small — forces hard gate refusal
      callbacks: {
        onError: (msg) => { errors.push(msg) },
      },
    })

    // The loop should have broken out without sending
    expect(result.iterations).toBeLessThanOrEqual(1)
    // Should have an error about exceeding limit
    expect(errors.some(e => e.includes('exceeds context limit') || e.includes('still exceeds'))).toBe(true)
  })
})

// ─── 8.2 Fallback model selection ──────────────────────────────

describe('fallback model selection', () => {
  it('isRetryableError detects connection errors', () => {
    expect(isRetryableError('ECONNREFUSED')).toBe(true)
    expect(isRetryableError('fetch failed')).toBe(true)
    expect(isRetryableError('socket hang up')).toBe(true)
  })

  it('does not retry on 400-level errors', () => {
    expect(isRetryableError('API error 400: bad request')).toBe(false)
  })
})

// ─── 8.4 tool_use no-response stall ───────────────────────────

describe('tool_use stall detection', () => {
  it('stall messages are not misclassified as context limit', () => {
    expect(isContextLimitError('Model requested tool execution but returned no tool_use blocks')).toBe(false)
    expect(isContextLimitError('No response from test-model')).toBe(false)
  })

  it('breaks on empty response from API', async () => {
    // Simulate: API returns 200 but empty response (no text, no tools)
    const conv = makeConversation(2, 100)
    const errors: string[] = []
    const dispatcher = new ToolDispatcher(new MCPManager())

    // Mock fetch to return an empty response
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    }) as any

    try {
      const result = await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:1',
        apiKey: 'test',
        callbacks: {
          onError: (msg) => { errors.push(msg) },
        },
      })

      expect(result.finalText).toBe('')
      // Should show "No response" message
      expect(errors.some(e => e.includes('No response') || e.includes('no tool_use'))).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// ─── Slash-like literal input safety ───────────────────────────

describe('slash command safety', () => {
  it('buildSlashPickerItems returns known commands', () => {
    const items = buildSlashPickerItems()
    expect(items.length).toBeGreaterThan(10)
    expect(items.some(i => i.value === '/help')).toBe(true)
    expect(items.some(i => i.value === '/model')).toBe(true)
  })

  it('SLASH_COMMANDS_REQUIRING_ARGS contains expected commands', () => {
    expect(SLASH_COMMANDS_REQUIRING_ARGS.has('/resume')).toBe(true)
    expect(SLASH_COMMANDS_REQUIRING_ARGS.has('/rename')).toBe(true)
  })

  it('URL-like paths are not in SLASH_COMMANDS', () => {
    const items = buildSlashPickerItems()
    const values = items.map(i => i.value)
    expect(values).not.toContain('/mes/outsource')
    expect(values).not.toContain('/usr/bin')
    expect(values).not.toContain('/api/v1')
  })
})
