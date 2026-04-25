import { describe, it, expect } from 'vitest'
import { translateRequest } from '../src/translate/request.js'

describe('translateRequest', () => {
  it('translates simple text conversation', () => {
    const result = translateRequest({
      model: 'default',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hello' }],
    }, 'distilled-27b')
    expect(result.model).toBe('distilled-27b')
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }])
    expect(result.max_tokens).toBe(256)
  })

  it('translates system prompt string', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'y')
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
  })

  it('translates system prompt array with cache_control stripped', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      system: [
        { type: 'text', text: 'Part 1', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Part 2' },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'y')
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Part 1\n\nPart 2' })
  })

  it('translates assistant message with tool_use', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'List files' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file1.txt\nfile2.txt' },
        ]},
      ],
    }, 'y')
    const assistant = result.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBe('Let me check.')
    expect(assistant.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
    ])
    const tool = result.messages[2]
    expect(tool.role).toBe('tool')
    expect(tool.tool_call_id).toBe('call_1')
    expect(tool.content).toBe('file1.txt\nfile2.txt')
  })

  it('drops thinking blocks', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Think' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'internal...' },
          { type: 'text', text: 'My answer' },
        ]},
      ],
    }, 'y')
    expect(result.messages[1].content).toBe('My answer')
    expect(result.messages[1].tool_calls).toBeUndefined()
  })

  it('sets assistant content to null when only tool_use', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Do it' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'pwd' } },
        ]},
      ],
    }, 'y')
    expect(result.messages[1].content).toBeNull()
    expect(result.messages[1].tool_calls).toHaveLength(1)
  })

  it('handles tool_result with is_error', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Do it' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'fail' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'command not found', is_error: true },
        ]},
      ],
    }, 'y')
    expect(result.messages[2].content).toBe('[ERROR] command not found')
  })

  it('downgrades orphan tool_result blocks to plain user text', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Start here' },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_orphan', content: 'stale tool output' },
        ]},
      ],
    }, 'y')

    expect(result.messages).toEqual([
      { role: 'user', content: 'Start here' },
      { role: 'user', content: '[tool result] stale tool output' },
    ])
  })

  it('strips top_k and thinking from request', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100, top_k: 40,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'y')
    expect((result as any).top_k).toBeUndefined()
    expect((result as any).thinking).toBeUndefined()
  })

  it('passes stop_sequences as stop', () => {
    const result = translateRequest({
      model: 'x', max_tokens: 100,
      stop_sequences: ['Human:', 'Assistant:'],
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'y')
    expect(result.stop).toEqual(['Human:', 'Assistant:'])
  })
})
