import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { recordGateEvent } from '../../src/native/gate-telemetry.js'

// Mock only recordGateEvent; keep the rest of the module real (types etc.).
vi.mock('../../src/native/gate-telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/native/gate-telemetry.js')>()),
  recordGateEvent: vi.fn(),
}))

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
function registerNoopWrite(dispatcher: ToolDispatcher): void {
  dispatcher.register({
    name: 'write', description: 'test write',
    async execute(input: Record<string, unknown>) {
      return { output: `wrote ${String(input['path'] ?? '')}`, isError: false }
    },
  })
}
async function run(
  conv: ReturnType<typeof createConversation>,
  dispatcher: ToolDispatcher,
  input: Record<string, unknown>,
  onToolApproval?: (t: string, i: Record<string, unknown>) => Promise<boolean>,
): Promise<void> {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolUseResponse('write', input))
    .mockResolvedValueOnce(textResponse())
  await runConversationLoop(conv, dispatcher, {
    apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 3,
    callbacks: onToolApproval ? { onToolApproval } : undefined,
  })
}
function emittedKinds(): string[] {
  return vi.mocked(recordGateEvent).mock.calls.map(c => (c[0] as { kind: string }).kind)
}

beforeEach(() => vi.mocked(recordGateEvent).mockClear())
afterEach(() => { delete process.env['OWLCODA_MODES']; vi.restoreAllMocks() })

describe('mode-gate telemetry (Slice D3)', () => {
  it('emits mode_gate_block when plan mode blocks a mutating tool', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'plan' } }
    addUserMessage(conv, '改一下这个文件')
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher)
    await run(conv, dispatcher, { path: 'd3.ts', file_path: 'd3.ts', content: 'x' })
    expect(emittedKinds()).toContain('mode_gate_block')
  })

  it('emits mode_analysis_hint when an analysis intent is softened under modes', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'normal' } }
    addUserMessage(conv, '看一下这个文件')
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher)
    await run(conv, dispatcher, { path: 'd3.ts', file_path: 'd3.ts', content: 'x' })
    expect(emittedKinds()).toContain('mode_analysis_hint')
  })

  it('emits mode_auto_approve when auto mode auto-grants a low-risk call', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'auto' } }
    addUserMessage(conv, '改一下这个文件')
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher)
    await run(conv, dispatcher, { path: 'd3.ts', file_path: 'd3.ts', content: 'x' }, vi.fn<(t: string, i: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(true))
    expect(emittedKinds()).toContain('mode_auto_approve')
  })

  it('emits NO mode_* events when OWLCODA_MODES is explicitly disabled', async () => {
    process.env['OWLCODA_MODES'] = '0'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '看一下这个文件')
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher)
    await run(conv, dispatcher, { path: 'd3.ts', file_path: 'd3.ts', content: 'x' })
    expect(emittedKinds().filter(k => k.startsWith('mode_'))).toEqual([])
  })
})
