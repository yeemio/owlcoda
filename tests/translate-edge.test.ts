/**
 * Translate layer edge case tests — request and response translation boundary conditions.
 */
import { describe, it, expect } from 'vitest'
import { translateRequest } from '../src/translate/request.js'
import { translateResponse } from '../src/translate/response.js'
import { translateTools, translateToolChoice } from '../src/translate/tools.js'
import type { AnthropicMessagesRequest, OpenAIChatResponse } from '../src/types.js'
import type { OwlCodaConfig } from '../src/config.js'

function makeConfig(): OwlCodaConfig {
  return {
    models: [
      { id: 'test-model', label: 'Test', backendModel: 'test-model', aliases: [], tier: 'general', contextWindow: 32768 },
    ],
    routerUrl: 'http://localhost:11435/v1',
    responseModelStyle: 'upstream_alias',
  } as unknown as OwlCodaConfig
}

describe('translateRequest', () => {
  it('translates simple text message', () => {
    const req: AnthropicMessagesRequest = {
      model: 'default',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    }
    const result = translateRequest(req, 'local-model')
    expect(result.model).toBe('local-model')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toBe('Hello')
    expect(result.max_tokens).toBe(1024)
  })

  it('translates string system prompt', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      system: 'You are a helpful assistant.',
    }
    const result = translateRequest(req, 'local')
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(result.messages[1].role).toBe('user')
  })

  it('translates array system prompt', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      system: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    }
    const result = translateRequest(req, 'local')
    expect(result.messages[0].content).toBe('Part 1\n\nPart 2')
  })

  it('handles absent system prompt', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    expect(result.messages[0].role).toBe('user')
  })

  it('translates user message with image content', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    const msg = result.messages[0]
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as any[]
    expect(parts[0]).toEqual({ type: 'text', text: 'What is this?' })
    expect(parts[1].type).toBe('image_url')
    expect(parts[1].image_url.url).toBe('data:image/png;base64,abc123')
  })

  it('translates assistant content blocks with tool_use', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [
        { role: 'user', content: 'search for cats' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'cats' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'Found 3 results' },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    // user → assistant (with tool_calls) → tool
    const assistantMsg = result.messages.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toBe('Let me search.')
    expect(assistantMsg!.tool_calls).toHaveLength(1)
    expect(assistantMsg!.tool_calls![0].function.name).toBe('search')
    expect(assistantMsg!.tool_calls![0].function.arguments).toBe('{"q":"cats"}')

    const toolMsg = result.messages.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toBe('Found 3 results')
    expect(toolMsg!.tool_call_id).toBe('call_1')
  })

  it('translates tool_result with is_error flag', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [
        { role: 'user', content: 'do something' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_2', name: 'run', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_2', content: 'Permission denied', is_error: true },
          ],
        },
      ],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    const toolMsg = result.messages.find(m => m.role === 'tool')
    expect(toolMsg!.content).toBe('[ERROR] Permission denied')
  })

  it('skips thinking blocks in assistant content', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'visible response' },
        ],
      }],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    const assistant = result.messages.find(m => m.role === 'assistant')
    expect(assistant!.content).toBe('visible response')
    expect(assistant!.tool_calls).toBeUndefined()
  })

  it('passes through temperature, top_p, stop_sequences, stream', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['END'],
      stream: true,
    }
    const result = translateRequest(req, 'local')
    expect(result.temperature).toBe(0.5)
    expect(result.top_p).toBe(0.9)
    expect(result.stop).toEqual(['END'])
    expect(result.stream).toBe(true)
  })

  it('omits optional fields when not present', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    const result = translateRequest(req, 'local')
    expect(result).not.toHaveProperty('temperature')
    expect(result).not.toHaveProperty('top_p')
    expect(result).not.toHaveProperty('stop')
    expect(result).not.toHaveProperty('stream')
    expect(result).not.toHaveProperty('tools')
  })

  it('translates tools and tool_choice', () => {
    const req: AnthropicMessagesRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tools: [{
        name: 'search',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      }],
      tool_choice: { type: 'auto' },
    }
    const result = translateRequest(req, 'local')
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe('search')
    expect(result.tool_choice).toBe('auto')
  })
})

describe('translateResponse', () => {
  const config = makeConfig()

  it('translates text response', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  it('translates tool_calls response', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-456',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"cats"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    const toolUse = result.content[0] as any
    expect(toolUse.name).toBe('search')
    expect(toolUse.input).toEqual({ q: 'cats' })
    expect(result.stop_reason).toBe('tool_use')
  })

  it('adds empty text block when response has no content', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-789',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null },
        finish_reason: 'stop',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: '' })
  })

  it('maps finish_reason: length → max_tokens', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-len',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'truncated' },
        finish_reason: 'length',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.stop_reason).toBe('max_tokens')
  })

  it('defaults to 0 tokens when usage is missing', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-nousage',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.usage.input_tokens).toBe(0)
    expect(result.usage.output_tokens).toBe(0)
    expect(result.usage.cache_creation_input_tokens).toBe(0)
    expect(result.usage.cache_read_input_tokens).toBe(0)
  })

  it('generates valid msg_ ID format', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-x',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.id).toMatch(/^msg_[a-f0-9]{24}$/)
  })

  it('handles text + tool_calls together', () => {
    const openai: OpenAIChatResponse = {
      id: 'chatcmpl-both',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'I will search.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const result = translateResponse(openai, 'test', config)
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1].type).toBe('tool_use')
  })
})

describe('translateTools', () => {
  it('translates Anthropic tool defs to OpenAI format', () => {
    const tools = translateTools([{
      name: 'calculate',
      description: 'Do math',
      input_schema: { type: 'object', properties: { expr: { type: 'string' } } },
    }])
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('calculate')
    expect(tools[0].function.description).toBe('Do math')
    expect(tools[0].function.parameters).toEqual({ type: 'object', properties: { expr: { type: 'string' } } })
  })

  it('handles tool without description', () => {
    const tools = translateTools([{
      name: 'noop',
      input_schema: { type: 'object' },
    }])
    expect(tools[0].function).not.toHaveProperty('description')
  })

  it('translates empty tools array', () => {
    expect(translateTools([])).toEqual([])
  })
})

describe('translateToolChoice', () => {
  it('auto → "auto"', () => {
    expect(translateToolChoice({ type: 'auto' })).toBe('auto')
  })

  it('any → "required"', () => {
    expect(translateToolChoice({ type: 'any' })).toBe('required')
  })

  it('none → "none"', () => {
    expect(translateToolChoice({ type: 'none' })).toBe('none')
  })

  it('tool → { type: "function", function: { name } }', () => {
    const result = translateToolChoice({ type: 'tool', name: 'search' })
    expect(result).toEqual({ type: 'function', function: { name: 'search' } })
  })

  it('undefined → undefined', () => {
    expect(translateToolChoice(undefined)).toBeUndefined()
  })
})
