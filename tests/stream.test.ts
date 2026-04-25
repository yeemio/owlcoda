import { describe, it, expect } from 'vitest'
import { StreamTranslator } from '../src/translate/stream.js'

describe('StreamTranslator', () => {
  function makeChunk(delta: object, finishReason: string | null = null): string {
    return JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })
  }

  function collectEvents(translator: StreamTranslator, lines: string[]): string[] {
    const all: string[] = []
    for (const line of lines) {
      all.push(...translator.processLine(line))
    }
    all.push(...translator.flush())
    return all
  }

  function parseEvents(events: string[]): Array<{ event: string; data: any }> {
    return events.map(e => {
      const lines = e.split('\n')
      const eventLine = lines.find(l => l.startsWith('event: '))
      const dataLine = lines.find(l => l.startsWith('data: '))
      return {
        event: eventLine?.replace('event: ', '') ?? '',
        data: dataLine ? JSON.parse(dataLine.replace('data: ', '')) : null,
      }
    })
  }

  it('translates pure text stream', () => {
    const t = new StreamTranslator('default', 50)
    const events = collectEvents(t, [
      makeChunk({ role: 'assistant', content: '' }),
      makeChunk({ content: 'Hello' }),
      makeChunk({ content: ' world' }),
      makeChunk({}, 'stop'),
      '[DONE]',
    ])

    const parsed = parseEvents(events)
    const types = parsed.map(p => p.event)

    expect(types[0]).toBe('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    expect(types).toContain('message_delta')
    expect(types[types.length - 1]).toBe('message_stop')

    const textDeltas = parsed.filter(p => p.data?.delta?.type === 'text_delta')
    expect(textDeltas.map(d => d.data.delta.text)).toEqual(['Hello', ' world'])

    const msgDelta = parsed.find(p => p.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
  })

  it('translates tool_call stream', () => {
    const t = new StreamTranslator('default', 50)
    const events = collectEvents(t, [
      makeChunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }] }),
      makeChunk({ tool_calls: [{ index: 0, function: { arguments: '{"com' } }] }),
      makeChunk({ tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] }),
      makeChunk({}, 'tool_calls'),
      '[DONE]',
    ])

    const parsed = parseEvents(events)

    const blockStart = parsed.find(p =>
      p.event === 'content_block_start' && p.data?.content_block?.type === 'tool_use'
    )
    expect(blockStart?.data.content_block.id).toBe('call_1')
    expect(blockStart?.data.content_block.name).toBe('Bash')

    const jsonDeltas = parsed.filter(p => p.data?.delta?.type === 'input_json_delta')
    expect(jsonDeltas.length).toBeGreaterThan(0)
    const fullJson = jsonDeltas.map(d => d.data.delta.partial_json).join('')
    expect(fullJson).toBe('{"command":"ls"}')

    const msgDelta = parsed.find(p => p.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('tool_use')
  })

  it('translates text + tool_call mixed stream', () => {
    const t = new StreamTranslator('default', 50)
    const events = collectEvents(t, [
      makeChunk({ role: 'assistant', content: '' }),
      makeChunk({ content: 'Let me check.' }),
      makeChunk({ content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }] }),
      makeChunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }),
      makeChunk({}, 'tool_calls'),
      '[DONE]',
    ])

    const parsed = parseEvents(events)
    const types = parsed.map(p => p.event)

    expect(types.filter(t => t === 'content_block_start').length).toBe(2)
    expect(types.filter(t => t === 'content_block_stop').length).toBe(2)
  })

  it('handles multiple tool_calls', () => {
    const t = new StreamTranslator('default', 50)
    const events = collectEvents(t, [
      makeChunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } }] }),
      makeChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp"}' } }] }),
      makeChunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'Write', arguments: '' } }] }),
      makeChunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"/out"}' } }] }),
      makeChunk({}, 'tool_calls'),
      '[DONE]',
    ])

    const parsed = parseEvents(events)
    const toolStarts = parsed.filter(p =>
      p.event === 'content_block_start' && p.data?.content_block?.type === 'tool_use'
    )
    expect(toolStarts.length).toBe(2)
    expect(toolStarts[0].data.content_block.name).toBe('Read')
    expect(toolStarts[1].data.content_block.name).toBe('Write')
  })

  it('message_start contains correct model and usage', () => {
    const t = new StreamTranslator('heavy', 200)
    const events = collectEvents(t, [
      makeChunk({ role: 'assistant', content: 'Hi' }),
      makeChunk({}, 'stop'),
      '[DONE]',
    ])

    const parsed = parseEvents(events)
    const msgStart = parsed.find(p => p.event === 'message_start')
    expect(msgStart?.data.message.model).toBe('heavy')
    expect(msgStart?.data.message.usage.input_tokens).toBe(200)
  })

  it('flush handles incomplete stream', () => {
    const t = new StreamTranslator('default', 50)
    const events1 = t.processLine(makeChunk({ role: 'assistant', content: 'Hello' }))
    const events2 = t.flush()

    const all = [...events1, ...events2]
    const parsed = parseEvents(all)
    const types = parsed.map(p => p.event)
    expect(types).toContain('message_stop')
  })
})
