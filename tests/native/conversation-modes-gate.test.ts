import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'

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
function registerNoopWrite(dispatcher: ToolDispatcher, writes: string[]): void {
  dispatcher.register({
    name: 'write', description: 'test write',
    async execute(input: Record<string, unknown>) {
      const path = String(input['path'] ?? '')
      writes.push(path)
      return { output: `wrote ${path}`, isError: false, metadata: { path } }
    },
  })
}
async function runWrite(conv: ReturnType<typeof createConversation>, dispatcher: ToolDispatcher): Promise<void> {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolUseResponse('write', { path: '/tmp/x.ts', content: 'x' }))
    .mockResolvedValueOnce(textResponse())
  await runConversationLoop(conv, dispatcher, {
    apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: '/tmp', maxIterations: 3,
  })
}
function registerNoopBash(dispatcher: ToolDispatcher, ran: string[]): void {
  dispatcher.register({
    name: 'bash', description: 'test bash',
    async execute(input: Record<string, unknown>) {
      const cmd = String(input['command'] ?? '')
      ran.push(cmd)
      return { output: `ran ${cmd}`, isError: false }
    },
  })
}
async function runToolWithApproval(
  conv: ReturnType<typeof createConversation>,
  dispatcher: ToolDispatcher,
  toolName: string,
  input: Record<string, unknown>,
  onToolApproval: (toolName: string, input: Record<string, unknown>) => Promise<boolean>,
): Promise<void> {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolUseResponse(toolName, input))
    .mockResolvedValueOnce(textResponse())
  await runConversationLoop(conv, dispatcher, {
    apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', maxIterations: 3,
    callbacks: { onToolApproval },
  })
}

afterEach(() => { delete process.env['OWLCODA_MODES']; vi.restoreAllMocks() })

describe('mode gate in the dispatch loop (OWLCODA_MODES)', () => {
  it('plan mode hard-blocks a mutating tool (even with implementation intent)', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'plan' } }
    addUserMessage(conv, '改一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    await runWrite(conv, dispatcher)
    expect(writes).toEqual([])
  })

  it('normal mode allows a mutating tool', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'normal' } }
    addUserMessage(conv, '改一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    await runWrite(conv, dispatcher)
    expect(writes).toEqual(['/tmp/x.ts'])
  })

  it('under modes, analysis-only intent is demoted to a hint (write proceeds)', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'normal' } }
    addUserMessage(conv, '看一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    await runWrite(conv, dispatcher)
    expect(writes).toEqual(['/tmp/x.ts'])
  })

  it('MODES explicitly off: analysis-only intent still hard-blocks (legacy escape hatch)', async () => {
    process.env['OWLCODA_MODES'] = '0'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '看一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    await runWrite(conv, dispatcher)
    expect(writes).toEqual([])
  })
})

describe('auto mode auto-approval (OWLCODA_MODES, Slice D2)', () => {
  it('auto auto-approves a low-risk in-cwd edit without prompting', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'auto' } }
    addUserMessage(conv, '改一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    const approval = vi.fn<(t: string, i: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(true)
    await runToolWithApproval(conv, dispatcher, 'write', { path: 'd2-auto.ts', file_path: 'd2-auto.ts', content: 'x' }, approval)
    expect(approval).not.toHaveBeenCalled()
    expect(writes).toEqual(['d2-auto.ts'])
  })

  it('auto still prompts for dangerous bash (destructive tier)', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'auto' } }
    addUserMessage(conv, '执行这个命令')
    const ran: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopBash(dispatcher, ran)
    const approval = vi.fn<(t: string, i: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(true)
    await runToolWithApproval(conv, dispatcher, 'bash', { command: 'rm -rf /tmp/d2x' }, approval)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(ran).toEqual(['rm -rf /tmp/d2x'])
  })

  it('normal mode prompts for a write (no auto-approval)', async () => {
    process.env['OWLCODA_MODES'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    conv.options = { ...conv.options, operatingModeState: { mode: 'normal' } }
    addUserMessage(conv, '改一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    const approval = vi.fn<(t: string, i: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(true)
    await runToolWithApproval(conv, dispatcher, 'write', { path: 'd2-auto.ts', file_path: 'd2-auto.ts', content: 'x' }, approval)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(writes).toEqual(['d2-auto.ts'])
  })

  it('MODES explicitly off: a write is prompted (no auto path exists)', async () => {
    process.env['OWLCODA_MODES'] = '0'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '改一下这个文件')
    const writes: string[] = []
    const dispatcher = new ToolDispatcher(); registerNoopWrite(dispatcher, writes)
    const approval = vi.fn<(t: string, i: Record<string, unknown>) => Promise<boolean>>().mockResolvedValue(true)
    await runToolWithApproval(conv, dispatcher, 'write', { path: 'd2-auto.ts', file_path: 'd2-auto.ts', content: 'x' }, approval)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(writes).toEqual(['d2-auto.ts'])
  })
})
