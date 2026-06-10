import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'

// Force the snapshot build to throw; keep the rest of the module real so the
// enable/stale gates still behave normally. Project Map is default-on, so this
// build runs on every conversation — a throw here must NOT break the loop.
vi.mock('../../src/native/project-map.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/native/project-map.js')>()),
  buildProjectMapSnapshot: vi.fn(() => {
    throw new Error('boom: simulated snapshot build failure')
  }),
}))

function textResponse(text = 'done'): Response {
  return new Response(JSON.stringify({
    type: 'message', role: 'assistant', model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => { delete process.env['OWLCODA_PROJECT_MAP']; vi.restoreAllMocks() })

describe('Project Map snapshot build is crash-isolated (default-on safety)', () => {
  it('a build failure degrades to no Project Map instead of breaking the conversation', async () => {
    // default-on (OWLCODA_PROJECT_MAP unset) → build attempted → throws (mocked).
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    addUserMessage(conv, 'hello')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResponse('done'))

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 1,
    })

    // The conversation must complete normally; Project Map simply absent.
    expect(result.finalText).toBe('done')
    expect(conv.options?.projectMapSnapshot).toBeUndefined()
    expect(conv.options?.projectMapPromptSummary).toBeUndefined()
  })
})
