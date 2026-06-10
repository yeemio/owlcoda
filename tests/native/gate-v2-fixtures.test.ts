import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolDispatcher } from '../../src/native/dispatch.js'
import {
  addUserMessage,
  createConversation,
  runConversationLoop,
} from '../../src/native/conversation.js'
import {
  hasGrantedRiskyToolAwaitingEvidence,
  shouldHardStopOnAbandonedGrant,
} from '../../src/native/abandoned-grant-predicate.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function toolUseResponse(name: string, id: string, input: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  process.env['OWLCODA_GATE_V2'] = '1'
})

afterEach(() => {
  delete process.env['OWLCODA_GATE_V2']
  delete process.env['OWLCODA_LOOP_GUARD']
  vi.restoreAllMocks()
})

describe('F1 — 0.14.31 review prompt reproduction', () => {
  it('passes all six assertions (a)-(f) under GATE_V2=1', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, '看下 src/foo.ts 这段中文，你觉得有 AI 味吗？怎么改？')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => textResponse(
      '这段中文有几处 AI 味：1) 句式过于工整；2) 没有口语化连接词；3) 用了"赋能"这种套话。'
      + '我建议如下修改：将"我们能够赋能"改成"我们能帮"，将"实现降本增效"改成"省钱也省时间"。',
    ))

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: {},
    })

    const taskState = ensureTaskExecutionState(conv)

    const risky = taskState.proposedToolCalls.filter(
      (tc) => ['mutating', 'destructive', 'external_effect'].includes(tc.riskClass),
    )
    expect(risky, '(a) no risky proposedToolCalls').toHaveLength(0)

    expect(shouldHardStopOnAbandonedGrant(taskState).fire, '(b) predicate false').toBe(false)
    expect(hasGrantedRiskyToolAwaitingEvidence(taskState), '(b) helper false').toBe(false)

    const allTurnText = conv.turns
      .filter((t) => t.role === 'user')
      .flatMap((t) => t.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))
      .join('\n')
    expect(allTurnText, '(c) no create_plan nudge').not.toMatch(/Runtime task-step|create.*plan/i)
    expect(allTurnText, '(d) no [Runtime task-step] inject').not.toMatch(/\[Runtime task-step\]/)

    const taskCreateCalls = taskState.proposedToolCalls.filter((tc) => tc.tool === 'TaskCreate')
    expect(taskCreateCalls, '(e) no TaskCreate').toHaveLength(0)

    expect(result.finalText ?? '', '(f) final text delivered').toMatch(/AI 味/)
  })

  it('cross-turn: previous turn risky grant does not leak into next review prompt', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'edit src/foo.ts to add a function')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'edit',
      description: 'stub',
      async execute() {
        return { output: 'edited', isError: false, metadata: { path: 'src/foo.ts' } }
      },
    })

    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        toolUseResponse('edit', 'tu_1', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }),
      )
      .mockImplementationOnce(async () => textResponse('done with the edit'))

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      maxIterations: 10,
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const after1 = ensureTaskExecutionState(conv)
    expect(after1.proposedToolCalls.some((tc) => tc.permissionState === 'granted')).toBe(true)

    addUserMessage(conv, '你觉得现在这段代码有 AI 味吗？')
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      textResponse('代码风格还可以'),
    )

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: {},
    })

    const after2 = ensureTaskExecutionState(conv)
    expect(after2.proposedToolCalls).toHaveLength(0)
    expect(shouldHardStopOnAbandonedGrant(after2).fire).toBe(false)
    expect(hasGrantedRiskyToolAwaitingEvidence(after2)).toBe(false)
  })
})

describe('F10 — internal_state tool x N (TaskUpdate)', () => {
  it('predicate stays false across 8 TaskUpdate calls', async () => {
    process.env['OWLCODA_LOOP_GUARD'] = 'off'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'manage the task tree')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'TaskUpdate',
      description: 'stub',
      async execute() {
        return { output: 'updated', isError: false }
      },
    })

    const seq: Response[] = []
    for (let i = 0; i < 8; i += 1) {
      seq.push(toolUseResponse('TaskUpdate', `tu_${i}`, { taskId: '1', status: 'in_progress' }))
    }
    seq.push(textResponse('task management done'))

    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = seq[i]
      i += 1
      if (!response) throw new Error('over-fetched')
      return response
    })

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      maxIterations: 10,
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = ensureTaskExecutionState(conv)
    expect(taskState.proposedToolCalls).toHaveLength(8)
    for (const tc of taskState.proposedToolCalls) {
      expect(tc.riskClass).toBe('internal_state')
    }
    expect(shouldHardStopOnAbandonedGrant(taskState).fire).toBe(false)
    expect(hasGrantedRiskyToolAwaitingEvidence(taskState)).toBe(false)
  })
})

describe('F11 — narration_loop suppression', () => {
  it('does not hard-stop a review-only conversation under GATE_V2', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'review src/foo.ts and tell me your thoughts')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      textResponse('final review done'),
    )

    const onError = vi.fn()
    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onError },
    })

    expect(onError).not.toHaveBeenCalledWith(expect.stringMatching(/narration loop/))
    expect(result.stopReason).not.toBe('narration_loop')
  })
})

describe('F12 — shouldInjectContinueWhileOpen suppression', () => {
  it('does not inject [Runtime continue-while-open] for a review-only turn', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'tell me what you think of this code')

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () =>
      textResponse('here is my review of the code: it looks fine.'),
    )

    await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: {},
    })

    const allUserText = conv.turns
      .filter((t) => t.role === 'user')
      .flatMap((t) => t.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))
      .join('\n')
    expect(allUserText).not.toMatch(/\[Runtime continue-while-open/)
  })
})

describe('F13 — WebFetch external_effect tool_completion', () => {
  it('records tool_completion evidence and predicate stays false', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'fetch https://example.com and summarize')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'WebFetch',
      description: 'stub',
      async execute() {
        return { output: '<html>...</html>', isError: false }
      },
    })

    const seq = [
      toolUseResponse('WebFetch', 'tu_1', { url: 'https://example.com', prompt: 'summarize' }),
      textResponse('the page says hello'),
    ]
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = seq[i]
      i += 1
      if (!response) throw new Error('over-fetched')
      return response
    })

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://test',
      apiKey: 'k',
      callbacks: { onToolApproval: vi.fn().mockResolvedValue(true) },
    })

    const taskState = ensureTaskExecutionState(conv)
    const tc = taskState.proposedToolCalls.find((c) => c.tool === 'WebFetch')
    expect(tc?.riskClass).toBe('external_effect')
    expect(tc?.permissionState).toBe('granted')
    expect(tc?.postGrantEvidence).toContainEqual(
      expect.objectContaining({ kind: 'tool_completion' }),
    )
    expect(shouldHardStopOnAbandonedGrant(taskState).fire).toBe(false)
  })
})
