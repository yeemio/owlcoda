import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { buildToolDef } from '../../src/native/protocol/request.js'
import { shouldScheduleRuntimeAutoRetry } from '../../src/native/repl-shared.js'

function toolUseResponse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function contentResponse(
  content: Array<Record<string, unknown>>,
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('native conversation free-mode long task loop policy', () => {
  beforeEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('does not hard-stop repeated failing bash attempts in default free mode', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep diagnosing a long task until you can report the exact blocker.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(input) {
        return { output: `bash failed ${String(input['command'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('bash', 'tool-1', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-1234.log' }),
      toolUseResponse('bash', 'tool-2', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-5678.log' }),
      toolUseResponse('bash', 'tool-3', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-9012.log' }),
      toolUseResponse('bash', 'tool-4', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-3456.log' }),
      textResponse('I isolated the blocker and will stop here with the evidence.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('I isolated the blocker')
  })

  it('does not hard-stop long successful no-output verification chains in default free mode', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Run the whole verification chain and only report when complete.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute() {
        return { output: '', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 24 }, (_, index) =>
        toolUseResponse('bash', `tool-${index + 1}`, {
          cwd: '/tmp/project',
          command: `./verify-step-${index + 1}.sh`,
        }),
      ),
      textResponse('verification chain complete'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('verification chain complete')
  })
})

describe('native conversation tool loop guard', () => {
  // These tests exercise the STRICT agentic guards (convergence → synthesis,
  // fan-out summary gate, tool-only nudge after N turns, etc.). From 0.12.8
  // the loop runs in FREE mode by default — the user is the only authority
  // on when to stop. Strict mode is opt-in via OWLCODA_AGENTIC_MODE=strict,
  // so this suite sets the env var to keep coverage of the guard logic.
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('stops repeated read/search oscillation before another tool_result is appended', async () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      tools: [buildToolDef('read', 'test read', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      })],
    })
    addUserMessage(conv, 'Find and inspect the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })
    dispatcher.register({
      name: 'grep',
      description: 'test grep',
      async execute(input) {
        return { output: `grep ${String(input['pattern'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('grep', 'tool-2', { path: '/tmp/demo.ts', pattern: 'foo' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      toolUseResponse('grep', 'tool-4', { path: '/tmp/demo.ts', pattern: 'foo' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/demo.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated read/search attempts')
    expect(result.stopReason).toBe('tool_loop')
    expect(result.conversation.turns.at(-1)?.role).toBe('assistant')
  })

  it('stops repeated read/update oscillation before another tool_result is appended', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Read and fix the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input) {
        return { output: `edit ${String(input['path'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/demo.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated read/update attempts')
    expect(result.stopReason).toBe('tool_loop')
    expect(result.conversation.turns.at(-1)?.role).toBe('assistant')
  })

  it('stops repeated failing updates on the same file even when edit payloads change', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep trying to fix the same file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input) {
        return { output: `edit failed ${String(input['path'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'alpha', newStr: 'beta' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'beta', newStr: 'gamma' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'gamma', newStr: 'delta' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'delta', newStr: 'epsilon' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated failing update attempts')
    expect(result.stopReason).toBe('tool_loop')
  })

  it('allows multiple different edits on the same file', async () => {
    // Real workflow: one file often needs several distinct edits in sequence.
    // Guard should not kill progress just because the path repeats.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the file in multiple passes')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input) {
        return { output: `edited ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const endResponse = new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    // 4 distinct edits on the same path → still allowed; final text response ends cleanly
    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'alpha', newStr: 'beta' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'beta', newStr: 'gamma' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'gamma', newStr: 'delta' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'delta', newStr: 'epsilon' }),
      endResponse,
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('done')
  })

  it('stops repeated failing bash attempts when only temp-artifact arguments change', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep rerunning the same failing smoke command')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute(input) {
        return { output: `bash failed ${String(input['command'] ?? '')}`, isError: true }
      },
    })

    const responses = [
      toolUseResponse('bash', 'tool-1', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-1234.log' }),
      toolUseResponse('bash', 'tool-2', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-5678.log' }),
      toolUseResponse('bash', 'tool-3', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-9012.log' }),
      toolUseResponse('bash', 'tool-4', { cwd: '/tmp/project', command: 'cd /tmp/project && python3 tests/smoke.py /tmp/run-3456.log' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors.at(-1)).toContain('repeated failing bash attempts')
    expect(result.stopReason).toBe('tool_loop')
  })

  it('allows productive rereads of the same file when the read window changes', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect different parts of the same file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return {
          output: `read ${String(input['path'] ?? '')} ${String(input['startLine'] ?? '')}:${String(input['endLine'] ?? '')}`,
          isError: false,
        }
      },
    })

    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts', startLine: 1, endLine: 40 }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/demo.ts', startLine: 41, endLine: 80 }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts:120' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/demo.ts', offset: 2048, limit: 512 }),
      textResponse('done'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toBe('done')
  })

  it('keeps the runtime nudge attached to tool_result after 3 tool-only turns', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `read ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: Array<{ messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }> = []
    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/demo.ts' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/demo.ts' }),
      textResponse('summary'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(notices).toContain('Nudge: requesting text summary after 3 consecutive tool-only turns')

    const followupRequest = requestBodies[3]
    expect(followupRequest?.messages.at(-2)?.role).toBe('assistant')
    expect(followupRequest?.messages.at(-2)?.content.some(block => block.type === 'tool_use')).toBe(true)
    expect(followupRequest?.messages.at(-1)?.role).toBe('user')
    expect(followupRequest?.messages.at(-1)?.content.some(block => block.type === 'tool_result')).toBe(true)
    expect(
      followupRequest?.messages.at(-1)?.content.some(
        (block) => block.type === 'text' && block.text?.includes('3 consecutive tool calls'),
      ),
    ).toBe(true)
  })

  it('blocks 6 identical successful edits on the same file (true loop)', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Fix the file')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'test edit',
      async execute(input) {
        return { output: `edited ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    // With threshold of 5, 6 identical edits triggers the guard (5 in window + 1 next)
    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-3', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-4', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-5', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }),
      toolUseResponse('edit', 'tool-6', { path: '/tmp/demo.ts', oldStr: 'foo', newStr: 'bar' }), // 6th — blocked
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: { onError(e) { errors.push(e) } },
    })

    expect(errors.at(-1)).toContain('repeated update attempts')
    expect(result.stopReason).toBe('tool_loop')
  })

  it('keeps productive long exploration open past the old request threshold', async () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      tools: [buildToolDef('read', 'test read', {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      })],
    })
    addUserMessage(conv, 'Keep exploring while new files still add evidence')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      toolUseResponse('read', 'tool-1', { path: '/tmp/a.ts' }),
      toolUseResponse('read', 'tool-2', { path: '/tmp/b.ts' }),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/d.ts' }),
      textResponse('done'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.requestCount).toBe(5)
    expect(requestBodies[3].tool_choice).toBeUndefined()
    expect(requestBodies[3].tools).toBeDefined()
    expect(notices.some((notice) => notice.startsWith('Synthesis phase:'))).toBe(false)
  })

  it('defer-executes large exploratory fan-out behind a summary gate', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect a lot of files')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
        { type: 'tool_use', id: 'tool-3', name: 'read', input: { path: '/tmp/c.ts' } },
        { type: 'tool_use', id: 'tool-4', name: 'read', input: { path: '/tmp/d.ts' } },
        { type: 'tool_use', id: 'tool-5', name: 'read', input: { path: '/tmp/e.ts' } },
        { type: 'tool_use', id: 'tool-6', name: 'read', input: { path: '/tmp/f.ts' } },
      ], 'tool_use'),
      textResponse('Conclusion: Enough evidence.\n\nEvidence: Read the first batch.\n\nUncertainty: One deferred file may still hide an edge case.\n\nNext: Review the deferred path only if the first batch is insufficient.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(notices).toContain('Summary gate: batched 4 exploratory tools and deferred 2 more until the assistant summarizes')
    expect(conv.turns[1]!.content.filter((block: any) => block.type === 'tool_use')).toHaveLength(4)
    expect(conv.turns[2]!.content.some((block: any) => block.type === 'text' && String(block.text).includes('Runtime summary gate'))).toBe(true)
    expect(requestBodies[1].messages.at(-2).content.filter((block: any) => block.type === 'tool_use')).toHaveLength(4)
  })

  it('treats repeatedly-ignored summary-gate exploration as a tool loop (counter-based)', async () => {
    // Before 0.12.5 a single summary-gate violation hard-stopped the
    // loop. That was too aggressive for real multi-file investigation
    // tasks — one extra read after the summary nudge was enough to
    // kill the whole turn. Now the loop nudges on each violation and
    // only hard-stops after the model has clearly refused to switch
    // modes (SUMMARY_GATE_VIOLATION_STOP_THRESHOLD) times in a row.
    // We feed enough violating responses to trip the threshold here.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Keep exploring')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      // Iter 1 — triggers the summary gate (batched 5 tools).
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
        { type: 'tool_use', id: 'tool-3', name: 'read', input: { path: '/tmp/c.ts' } },
        { type: 'tool_use', id: 'tool-4', name: 'read', input: { path: '/tmp/d.ts' } },
        { type: 'tool_use', id: 'tool-5', name: 'read', input: { path: '/tmp/e.ts' } },
      ], 'tool_use'),
      // Iters 2..6 — model keeps answering with an exploratory read
      // instead of summarizing. The threshold is 4 violations, so
      // iter 5 should emit the hard stop.
      toolUseResponse('read', 'tool-6', { path: '/tmp/f.ts' }),
      toolUseResponse('read', 'tool-7', { path: '/tmp/g.ts' }),
      toolUseResponse('read', 'tool-8', { path: '/tmp/h.ts' }),
      toolUseResponse('read', 'tool-9', { path: '/tmp/i.ts' }),
      toolUseResponse('read', 'tool-10', { path: '/tmp/j.ts' }),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onError(error) { errors.push(error) },
        onNotice(notice) { notices.push(notice) },
      },
    })

    expect(result.stopReason).toBe('tool_loop')
    expect(errors.at(-1)).toMatch(/ignored the summary gate \d+ times in a row/)
    // Saw at least one "still pending" nudge before the final stop.
    expect(notices.some((n) => n.startsWith('Summary gate still pending'))).toBe(true)
  })

  it('switches into synthesis mode with a tool-free final-answer contract request', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze the files and conclude')

    const dispatcher = new ToolDispatcher()
    const readCounts = new Map<string, number>()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        const path = String(input['path'] ?? '')
        const count = (readCounts.get(path) ?? 0) + 1
        readCounts.set(path, count)
        if (path.endsWith('c.ts') && count > 1) {
          return { output: 'ok', isError: false }
        }
        return { output: `function found in ${path}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('Conclusion: The runtime now converges after progress plateaus.\n\nEvidence: The last two reads repeated the same target without yielding fresh evidence.\n\nUncertainty: There may still be edge-case drift outside the sampled files.\n\nNext: Tighten the synthesis wording and retest.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.requestCount).toBe(5)
    expect(requestBodies[4].tool_choice).toEqual({ type: 'none' })
    expect(requestBodies[4].tools).toBeUndefined()
    expect(requestBodies[4].stream).toBe(false)
    expect(requestBodies[4].max_tokens).toBe(900)
    expect(requestBodies[4].stop_sequences).toContain('\n[TOOL_CALL]')
    expect(String(requestBodies[4].messages[0].content[0].text)).toContain('Evidence:')
  })

  it('treats pseudo tool-call text as unusable synthesis and recovers via fallback synthesis', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze and conclude')

    const dispatcher = new ToolDispatcher()
    const readCounts = new Map<string, number>()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        const path = String(input['path'] ?? '')
        const count = (readCounts.get(path) ?? 0) + 1
        readCounts.set(path, count)
        if (path.endsWith('c.ts') && count > 1) {
          return { output: 'ok', isError: false }
        }
        return { output: `function found in ${path}`, isError: false }
      },
    })

    const requestBodies: any[] = []
    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('[TOOL_CALL]\nread /tmp/d.ts\n[/TOOL_CALL]'),
      textResponse('Conclusion: The synthesis validator rejected pseudo tool output and forced a fallback close.\n\nEvidence: The first synthesis reply emitted TOOL_CALL markup instead of a contract answer.\n\nUncertainty: Quality can still drift even when shape is enforced.\n\nNext: Keep the fallback path, then tighten wording and rerun live minimax.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return responses.shift()!
    })

    const notices: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) {
          notices.push(message)
        },
      },
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('Conclusion:')
    expect(result.usage.requestCount).toBe(6)
    expect(notices.some((notice) => notice.startsWith('Fallback synthesis:'))).toBe(true)
    expect(requestBodies[5].max_tokens).toBe(650)
    expect(requestBodies[5].tool_choice).toEqual({ type: 'none' })
  })

  it('accepts free-form final-answer prose without the 4-section contract', async () => {
    // After 0.12.4 the validator is soft on shape — a free-form prose answer
    // that is non-empty, doesn't beg for tools, and doesn't emit pseudo
    // tool-call text is accepted as-is. The old rigid contract
    // (Conclusion/Evidence/Uncertainty/Next required) trapped real long
    // sessions at hard_stop even after the model had done useful work
    // (wrote files, ran commands) — kimi-for-coding and other thinking
    // models don't naturally emit the exact section labels at the end of
    // a complex multi-iteration turn. The hard-reject cases (empty,
    // tool-begging, pseudo tool-call, escape-to-more-exploration) still
    // trigger fallback / hard_stop — see the two preceding tests.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Analyze and conclude')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(input) {
        return { output: `function found in ${String(input['path'] ?? '')}`, isError: false }
      },
    })

    const responses = [
      contentResponse([
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: '/tmp/b.ts' } },
      ], 'tool_use'),
      toolUseResponse('read', 'tool-3', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-4', { path: '/tmp/c.ts' }),
      toolUseResponse('read', 'tool-5', { path: '/tmp/c.ts' }),
      textResponse('I finished the investigation. The three files define the feature pipeline and look consistent.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const notices: string[] = []
    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      callbacks: {
        onNotice(message) { notices.push(message) },
        onError(error) { errors.push(error) },
      },
    })

    expect(result.stopReason).not.toBe('hard_stop')
    expect(result.finalText).toContain('I finished the investigation')
    // Fallback should NOT have fired — free-form prose is accepted directly.
    expect(notices.some((n) => n.startsWith('Fallback synthesis:'))).toBe(false)
    expect(notices.some((n) => n.startsWith('Hard stop:'))).toBe(false)
    expect(errors.length).toBe(0)
  })

  it('does not escalate task-contract blocks into tool_loop while the model realigns', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Only touch `src/native/allowed.ts` while following the packet.')

    const responses = [
      toolUseResponse('edit', 'tool-1', { path: '/tmp/blocked.ts', oldStr: 'a', newStr: 'b' }),
      toolUseResponse('edit', 'tool-2', { path: '/tmp/blocked.ts', oldStr: 'b', newStr: 'c' }),
      textResponse('I need the user to expand the task contract before editing outside the allowed scope.'),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const errors: string[] = []
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(errors).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('expand the task contract')
    expect(result.conversation.options?.taskState?.run.status).toBe('waiting_user')
  })

  it('stops parent continuation after a terminal Agent failure', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Delegate the long audit and do not improvise if the agent fails.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Agent',
      description: 'test agent',
      async execute() {
        return {
          output: 'Agent incomplete: stop_reason=max_iterations',
          isError: true,
          metadata: {
            terminalToolFailure: true,
            terminalFailureReason: 'Sub-agent hit max_iterations before producing a final message.',
          },
        }
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(toolUseResponse('Agent', 'tool-agent-1', {
      description: 'Long audit',
      prompt: 'Audit deeply',
    }))

    const errors: string[] = []
    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
      callbacks: {
        onError(error) {
          errors.push(error)
        },
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('terminal_tool_failure')
    expect(result.finalText).toBe('')
    expect(errors).toContain('Sub-agent hit max_iterations before producing a final message.')
    expect(result.conversation.options?.taskState?.run.status).toBe('drifted')
    expect(result.conversation.options?.taskState?.run.lastGuardReason).toContain('max_iterations')
  })

  it('keeps runtimeFailure null on terminal tool failure so the REPL does not auto-continue', async () => {
    // The cmux 0.13.20 evidence showed the parent loop continuing past a
    // sub-agent max_iterations failure and letting the model produce
    // false claims ("`owlcoda` code has no iteration limit"). The
    // terminal-tool-failure contract is: the parent stops cleanly, no
    // runtimeFailure is synthesised, and the REPL's auto-retry gate
    // refuses to fire because runtimeFailure is null. Together those
    // guarantees keep the model from improvising over a known incomplete
    // sub-agent run.
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Delegate the long audit; do not improvise on terminal failure.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'Agent',
      description: 'test agent',
      async execute() {
        return {
          output: 'Agent incomplete: stop_reason=max_iterations',
          isError: true,
          metadata: {
            terminalToolFailure: true,
            terminalFailureReason: 'Sub-agent hit max_iterations before producing a final message.',
          },
        }
      },
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(toolUseResponse('Agent', 'tool-agent-2', {
      description: 'Long audit',
      prompt: 'Audit deeply',
    }))

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
    })

    expect(result.stopReason).toBe('terminal_tool_failure')
    expect(result.runtimeFailure).toBeNull()
    expect(shouldScheduleRuntimeAutoRetry({
      runtimeFailure: result.runtimeFailure,
      taskAborted: false,
      clearEpochUnchanged: true,
      currentRetryCount: 0,
      retryLimit: 8,
      hasQueuedInput: false,
    })).toBe(false)
  })
})
