import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'

afterEach(() => vi.restoreAllMocks())

// When the request still exceeds the context window after compaction, the loop
// refuses to send and breaks. The synthesis branch set lastStopReason='hard_stop'
// but the normal branch set nothing, leaving a stale 'tool_use' (or null) — which
// headless then reports as exit 0 + stale text, a silent false success.
describe('conversation: refuse-to-send on context overflow reports a stop reason', () => {
  it('stops with hard_stop (not stale/null) and never sends the request', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'x'.repeat(80000)) // far exceeds the tiny window below
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      contextWindow: 200, // hardLimit — request cannot fit even after compaction
    })

    expect(result.stopReason).toBe('hard_stop')
    expect(fetchSpy).not.toHaveBeenCalled() // refused before any network send
    expect(conv.turns).toHaveLength(1) // no context-pressure nudge for an unsendable turn
  })
})
