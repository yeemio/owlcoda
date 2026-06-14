import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { initializeOperatingModeState } from '../../src/native/modes.js'
import { decideHeadlessApproval } from '../../src/native/headless-approval.js'

// Regression for the audit's HIGH finding: in an UNATTENDED (headless) run, the
// UNSAFE_HEADLESS_TOOLS denylist is enforced solely via the onToolApproval
// callback. The conversation loop skips that callback when the operating mode
// auto-approves (`autoApproveByMode`), so `--mode yolo` let dangerous bash run
// unattended — the callback that would DENY it was never consulted. A headless
// approval callback is a hard deny-gate, not an interactive prompt: mode
// auto-approve may suppress a human prompt, never a deny.

function toolUseResponse(name: string, input: Record<string, unknown>, id = 'tool-1'): Response {
  return new Response(JSON.stringify({
    type: 'message', role: 'assistant', model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text = 'Done.'): Response {
  return new Response(JSON.stringify({
    type: 'message', role: 'assistant', model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

// Mirrors the core policy of buildHeadlessApprovalCallback: decideHeadlessApproval
// is THE headless deny-gate. `unattended: true` marks it as a hard gate.
const headlessDenyGate = (name: string, input: Record<string, unknown>) =>
  Promise.resolve(decideHeadlessApproval(name, false, input).allowed)

function makeRecordingDispatcher(ran: string[]) {
  const dispatcher = new ToolDispatcher()
  dispatcher.register({
    name: 'bash', description: 'test bash',
    async execute(input: Record<string, unknown>) {
      ran.push(`bash:${String(input['command'])}`)
      return { output: 'ran', isError: false }
    },
  })
  dispatcher.register({
    name: 'read', description: 'test read',
    async execute(input: Record<string, unknown>) {
      ran.push(`read:${String(input['path'])}`)
      return { output: 'file contents', isError: false }
    },
  })
  return dispatcher
}

describe('headless unattended runs honor the dangerous-bash deny-gate regardless of mode', () => {
  afterEach(() => vi.restoreAllMocks())

  it('mode=yolo does NOT execute dangerous bash in an unattended run (deny-gate consulted)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    initializeOperatingModeState(conv, 'yolo')
    addUserMessage(conv, 'clean the build dir')
    const ran: string[] = []
    const dispatcher = makeRecordingDispatcher(ran)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('bash', { command: 'rm -rf /tmp/owlcoda-nonexistent-victim' }))
      .mockResolvedValueOnce(textResponse())

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 3,
      callbacks: { onToolApproval: headlessDenyGate, unattended: true },
    })

    expect(ran).toEqual([]) // dangerous bash must be DENIED, never executed
  })

  it('mode=yolo still ALLOWS a safe tool in an unattended run (gate blocks only dangerous)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    initializeOperatingModeState(conv, 'yolo')
    addUserMessage(conv, 'read the config')
    const ran: string[] = []
    const dispatcher = makeRecordingDispatcher(ran)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('read', { path: '/tmp/x' }))
      .mockResolvedValueOnce(textResponse())

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 3,
      callbacks: { onToolApproval: headlessDenyGate, unattended: true },
    })

    expect(ran).toEqual(['read:/tmp/x'])
  })

  it('interactive yolo (no unattended flag) keeps suppressing the prompt — dangerous bash runs', async () => {
    // The fix must be scoped to unattended runs: interactive yolo means "no
    // prompts", so the callback (a TUI prompt) stays suppressed. Without the
    // unattended marker, behavior is unchanged.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    initializeOperatingModeState(conv, 'yolo')
    addUserMessage(conv, 'clean the build dir')
    const ran: string[] = []
    const dispatcher = makeRecordingDispatcher(ran)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('bash', { command: 'rm -rf /tmp/owlcoda-nonexistent-victim' }))
      .mockResolvedValueOnce(textResponse())

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 3,
      callbacks: { onToolApproval: headlessDenyGate /* no unattended */ },
    })

    expect(ran).toEqual(['bash:rm -rf /tmp/owlcoda-nonexistent-victim'])
  })
})
