/**
 * StreamTranslator edge case tests — malformed input, empty events, unicode, premature close.
 */
import { describe, it, expect } from 'vitest'
import { StreamTranslator } from '../src/translate/stream.js'

function makeTextChunk(content: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: finishReason,
    }],
  })
}

function makeRoleChunk(): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    }],
  })
}

function makeToolChunk(index: number, id?: string, name?: string, args?: string, finish?: string | null): string {
  const tc: any = { index }
  if (id) tc.id = id
  if (name) tc.function = { name, ...(args ? { arguments: args } : {}) }
  else if (args) tc.function = { arguments: args }
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { tool_calls: [tc] },
      finish_reason: finish ?? null,
    }],
  })
}

function makeFinishChunk(reason: string = 'stop'): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: reason,
    }],
  })
}

function makeUsageChunk(prompt: number, completion: number): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null,
    }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

describe('StreamTranslator edge cases', () => {
  it('handles malformed JSON gracefully', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine('not json at all')
    expect(events).toEqual([])
  })

  it('handles empty choices array', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [],
    }))
    expect(events).toEqual([])
  })

  it('handles [DONE] marker correctly', () => {
    const t = new StreamTranslator('test-model', 100)
    // Process some content first
    t.processLine(makeTextChunk('hello'))
    const events = t.processLine('[DONE]')
    // Should close the stream
    expect(events.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('produces message_start on first content', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine(makeTextChunk('hi'))
    expect(events[0]).toContain('message_start')
    expect(events[0]).toContain('test-model')
    expect(events[0]).toContain('"input_tokens":100')
  })

  it('handles role-only initial chunk (no content)', () => {
    // After the 0.12.3 thinking-stream fix, a role-only opener no longer
    // preemptively opens an empty text block — doing so would trap any
    // subsequent reasoning_content chunks in a state branch that doesn't
    // handle them and silently drop every thinking delta kimi emits.
    // Message_start still fires (client needs the handshake), but the
    // first content block opens only when real content arrives.
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine(makeRoleChunk())
    expect(events.some(e => e.includes('message_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_start'))).toBe(false)
    // If the stream closes here with no further chunks, flush() backfills
    // an empty text block so the client sees a well-formed turn.
    const flushed = t.flush()
    expect(flushed.some(e => e.includes('content_block_start'))).toBe(true)
    expect(flushed.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(flushed.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('forwards reasoning_content after role-only opener as thinking block', () => {
    // Regression guard for the 0.12.2 bug: kimi's first chunk is
    // `{role:'assistant',content:''}`, then it emits reasoning_content
    // deltas. The translator must carry those into Anthropic thinking
    // events rather than dropping them (which caused kimi to 400 on the
    // next turn with "reasoning_content is missing in assistant tool
    // call message").
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeRoleChunk())
    const reasoning = t.processLine(JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 0,
      choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }],
    }))
    expect(reasoning.some(e => e.includes('"type":"thinking"'))).toBe(true)
    expect(reasoning.some(e => e.includes('thinking_delta'))).toBe(true)
    expect(reasoning.some(e => e.includes('thinking...'))).toBe(true)
    // Only one message_start across the whole stream — the role-only
    // chunk and the reasoning_content chunk both land in INIT, but the
    // messageStartEmitted gate prevents a duplicate handshake.
    const allMessageStarts = reasoning.filter(e => e.includes('"type":"message_start"')).length
    expect(allMessageStarts).toBe(0)
  })

  it('streams unicode content correctly', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('Hello '))
    const events = t.processLine(makeTextChunk('世界 🌍'))
    expect(events.some(e => e.includes('世界 🌍'))).toBe(true)
  })

  it('handles empty content delta', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('start'))
    // Empty string content — should not emit delta
    const events = t.processLine(makeTextChunk(''))
    // Should not have a content_block_delta with empty text
    expect(events.filter(e => e.includes('content_block_delta'))).toHaveLength(0)
  })

  it('handles finish_reason without prior content', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine(makeFinishChunk('stop'))
    // Should emit message_start + empty block + close
    expect(events.some(e => e.includes('message_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(events.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('maps finish_reason: stop → end_turn', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hi'))
    const events = t.processLine(makeFinishChunk('stop'))
    const delta = events.find(e => e.includes('message_delta'))
    expect(delta).toContain('end_turn')
  })

  it('maps finish_reason: length → max_tokens', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hi'))
    const events = t.processLine(makeFinishChunk('length'))
    const delta = events.find(e => e.includes('message_delta'))
    expect(delta).toContain('max_tokens')
  })

  it('maps finish_reason: tool_calls → tool_use', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeToolChunk(0, 'call_1', 'search', '{"q":"test"}'))
    const events = t.processLine(makeFinishChunk('tool_calls'))
    const delta = events.find(e => e.includes('message_delta'))
    expect(delta).toContain('tool_use')
  })

  it('maps unknown finish_reason → end_turn', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hi'))
    const events = t.processLine(makeFinishChunk('something_new'))
    const delta = events.find(e => e.includes('message_delta'))
    expect(delta).toContain('end_turn')
  })

  it('does not emit events after DONE', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hi'))
    t.processLine('[DONE]')
    // Further processing should be empty
    const events = t.processLine(makeTextChunk('more'))
    expect(events).toEqual([])
  })

  it('flush on empty stream produces valid message', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.flush()
    expect(events.some(e => e.includes('message_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(events.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('flush after content closes block and message', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('partial'))
    const events = t.flush()
    expect(events.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(events.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('flush is idempotent (second flush is empty)', () => {
    const t = new StreamTranslator('test-model', 100)
    t.flush()
    expect(t.flush()).toEqual([])
  })

  it('uses upstream usage when available', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hi'))
    t.processLine(makeUsageChunk(50, 25))
    const events = t.processLine(makeFinishChunk('stop'))
    const delta = events.find(e => e.includes('message_delta'))
    expect(delta).toContain('"output_tokens":25')
  })

  it('estimates output tokens from char count when no usage chunk', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('abcdefgh')) // 8 chars → ~2 tokens
    const usage = t.getFinalUsage()
    expect(usage.inputTokens).toBe(100) // estimate from constructor
    expect(usage.outputTokens).toBe(2)  // ceil(8/4)
  })

  it('tool call stream produces correct Anthropic events', () => {
    const t = new StreamTranslator('test-model', 100)
    const events1 = t.processLine(makeToolChunk(0, 'call_1', 'search', '{"q":'))
    expect(events1.some(e => e.includes('message_start'))).toBe(true)
    expect(events1.some(e => e.includes('"type":"tool_use"'))).toBe(true)
    expect(events1.some(e => e.includes('input_json_delta'))).toBe(true)

    // Continue arguments
    const events2 = t.processLine(makeToolChunk(0, undefined, undefined, '"hello"}'))
    expect(events2.some(e => e.includes('input_json_delta'))).toBe(true)
  })

  it('handles text → tool transition', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('Let me search'))
    // Now a tool call arrives
    const events = t.processLine(makeToolChunk(0, 'call_1', 'search', '{}'))
    // Should close text block and open tool block
    expect(events.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(events.some(e => e.includes('"type":"tool_use"'))).toBe(true)
  })

  it('handles multiple sequential tool calls', () => {
    const t = new StreamTranslator('test-model', 100)
    // First tool call
    const events1 = t.processLine(makeToolChunk(0, 'call_1', 'read_file', '{"path":"/a"}'))
    expect(events1.some(e => e.includes('message_start'))).toBe(true)
    expect(events1.some(e => e.includes('"name":"read_file"'))).toBe(true)

    // Second tool call — different index
    const events2 = t.processLine(makeToolChunk(1, 'call_2', 'list_dir', '{"path":"/"}'))
    expect(events2.some(e => e.includes('content_block_stop'))).toBe(true) // close first
    expect(events2.some(e => e.includes('"name":"list_dir"'))).toBe(true)
  })

  it('uses upstream usage when available', () => {
    const t = new StreamTranslator('test-model', 50)
    // Chunk with usage
    t.processLine(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    }))
    const usage = t.getFinalUsage()
    expect(usage.inputTokens).toBe(42) // from upstream, not estimate
    expect(usage.outputTokens).toBe(7) // from upstream
  })

  it('mapFinishReason translates tool_calls to tool_use', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeToolChunk(0, 'call_1', 'bash', '{}'))
    const events = t.processLine(makeFinishChunk('tool_calls'))
    const messageDelta = events.find(e => e.includes('message_delta'))
    expect(messageDelta).toBeDefined()
    expect(messageDelta).toContain('"stop_reason":"tool_use"')
  })

  it('mapFinishReason translates length to max_tokens', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('some text'))
    const events = t.processLine(makeFinishChunk('length'))
    const messageDelta = events.find(e => e.includes('message_delta'))
    expect(messageDelta).toContain('"stop_reason":"max_tokens"')
  })

  it('flush from INIT state produces valid message envelope', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.flush()
    expect(events.some(e => e.includes('message_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_start'))).toBe(true)
    expect(events.some(e => e.includes('content_block_stop'))).toBe(true)
    expect(events.some(e => e.includes('message_delta'))).toBe(true)
    expect(events.some(e => e.includes('message_stop'))).toBe(true)
  })

  it('flush after DONE is a no-op', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeTextChunk('hello'))
    t.processLine(makeFinishChunk('stop'))
    const events = t.flush()
    expect(events).toEqual([])
  })

  it('tool args across multiple chunks are accumulated', () => {
    const t = new StreamTranslator('test-model', 100)
    t.processLine(makeToolChunk(0, 'call_1', 'write_file', '{"path":'))
    const e2 = t.processLine(makeToolChunk(0, undefined, undefined, '"/tmp/x",'))
    const e3 = t.processLine(makeToolChunk(0, undefined, undefined, '"content":"hi"}'))
    // Each continuation should produce input_json_delta
    expect(e2.some(e => e.includes('input_json_delta'))).toBe(true)
    expect(e3.some(e => e.includes('input_json_delta'))).toBe(true)
  })

  it('messageId format is msg_ prefix + 24 hex chars', () => {
    const t = new StreamTranslator('test-model', 100)
    const events = t.processLine(makeTextChunk('test'))
    const msgStart = events.find(e => e.includes('message_start'))!
    const match = msgStart.match(/"id":"(msg_[a-f0-9]+)"/)
    expect(match).toBeTruthy()
    expect(match![1].length).toBe(4 + 24) // 'msg_' + 24 chars
  })
})
