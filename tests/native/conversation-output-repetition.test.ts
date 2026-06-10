import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'

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

// A reply that degenerated into repeating the same substantive line — the
// 0.14.59 kimi-code dogfood failure mode.
const DEGENERATE = Array.from({ length: 8 }, () => '处理失败，请稍后重试该请求并确认。').join('\n')
const HEALTHY = '好的，我这就重启网关并归档膨胀会话，然后验证结果是否恢复。'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['OWLCODA_OUTPUT_REPETITION_GUARD']
  delete process.env['OWLCODA_OUTPUT_REPETITION_SHADOW']
})

async function run(reply: string) {
  const conv = createConversation({ system: 'test', model: 'test-model' })
  addUserMessage(conv, 'report on production status')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResponse(reply))
  const errors: string[] = []
  const result = await runConversationLoop(conv, new ToolDispatcher(), {
    apiBaseUrl: 'http://localhost:0',
    apiKey: 'test',
    callbacks: { onError(e) { errors.push(e) } },
  })
  return { result, errors }
}

describe('output-repetition guard wiring (conversation loop)', () => {
  it('default (no flag): a repetitive reply ends normally — zero behavior change', async () => {
    const { result, errors } = await run(DEGENERATE)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('处理失败')
    expect(errors).toHaveLength(0)
  })

  it('OWLCODA_OUTPUT_REPETITION_GUARD=1: soft-stops a degenerate reply', async () => {
    process.env['OWLCODA_OUTPUT_REPETITION_GUARD'] = '1'
    const { result, errors } = await run(DEGENERATE)
    expect(result.stopReason).toBe('output_repetition')
    expect(errors.at(-1)).toMatch(/repeat|repetition|loop/i)
  })

  it('OWLCODA_OUTPUT_REPETITION_GUARD=1: a healthy reply is NOT stopped', async () => {
    process.env['OWLCODA_OUTPUT_REPETITION_GUARD'] = '1'
    const { result, errors } = await run(HEALTHY)
    expect(result.stopReason).toBe('end_turn')
    expect(errors).toHaveLength(0)
  })

  it('OWLCODA_OUTPUT_REPETITION_SHADOW=1: observes but does NOT stop', async () => {
    process.env['OWLCODA_OUTPUT_REPETITION_SHADOW'] = '1'
    const { result } = await run(DEGENERATE)
    expect(result.stopReason).toBe('end_turn')
    expect(result.finalText).toContain('处理失败')
  })
})
