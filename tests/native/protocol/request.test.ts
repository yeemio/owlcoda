import { describe, it, expect } from 'vitest'
import {
  buildRequest,
  buildRequestFromOptions,
  userMessage,
  toolResultMessage,
  buildToolDef,
  sanitizeConversationTurns,
  validateAndRepairConversation,
} from '../../../src/native/protocol/request.js'
import type { Conversation, ConversationTurn } from '../../../src/native/protocol/types.js'

describe('Native Protocol — Request Builder', () => {
  const baseConversation: Conversation = {
    id: 'test-conv',
    system: 'You are a helpful assistant.',
    turns: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      },
    ],
    tools: [],
    model: 'default',
    maxTokens: 4096,
  }

  it('builds a basic request from conversation', () => {
    const req = buildRequest(baseConversation)
    expect(req.model).toBe('default')
    expect(req.max_tokens).toBe(4096)
    // System is now structured text blocks with cache_control
    expect(Array.isArray(req.system)).toBe(true)
    const sysBlocks = req.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(sysBlocks).toHaveLength(1)
    expect(sysBlocks[0]!.text).toBe('You are a helpful assistant.')
    expect(sysBlocks[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]!.role).toBe('user')
    expect(req.stream).toBe(true)
  })

  it('includes tools when present with cache_control on last', () => {
    const conv: Conversation = {
      ...baseConversation,
      tools: [
        buildToolDef('bash', 'Run a command', {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        }),
        buildToolDef('read', 'Read a file', {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        }),
      ],
    }
    const req = buildRequest(conv)
    expect(req.tools).toHaveLength(2)
    expect(req.tools![0]!.name).toBe('bash')
    expect((req.tools![0] as any).cache_control).toBeUndefined()
    expect(req.tools![1]!.name).toBe('read')
    expect((req.tools![1] as any).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('omits system when empty', () => {
    const conv: Conversation = { ...baseConversation, system: '' }
    const req = buildRequest(conv)
    expect(req.system).toBeUndefined()
  })

  it('sets stream=false when requested', () => {
    const req = buildRequest(baseConversation, false)
    expect(req.stream).toBe(false)
  })

  it('includes temperature when set', () => {
    const conv: Conversation = { ...baseConversation, temperature: 0.7 }
    const req = buildRequest(conv)
    expect(req.temperature).toBe(0.7)
  })

  it('builds from explicit options', () => {
    const req = buildRequestFromOptions({
      model: 'test-model',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1024,
      stream: false,
    })
    expect(req.model).toBe('test-model')
    expect(req.stream).toBe(false)
    expect(req.max_tokens).toBe(1024)
  })

  // ── Message helpers ──

  it('creates user message', () => {
    const msg = userMessage('test input')
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: 'test input' }])
  })

  it('creates tool result message', () => {
    const msg = toolResultMessage('call-1', 'result text', false)
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    const blocks = msg.content as Array<Record<string, unknown>>
    expect(blocks[0]!['type']).toBe('tool_result')
    expect(blocks[0]!['tool_use_id']).toBe('call-1')
  })

  it('creates error tool result message', () => {
    const msg = toolResultMessage('call-2', 'error detail', true)
    const blocks = msg.content as Array<Record<string, unknown>>
    expect(blocks[0]!['is_error']).toBe(true)
  })

  it('builds tool definition', () => {
    const def = buildToolDef('read', 'Read a file', {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    expect(def.name).toBe('read')
    expect(def.input_schema).toHaveProperty('properties')
  })

  it('includes thinking parameter when options.thinking is true', () => {
    const convo: Conversation = {
      ...baseConversation,
      options: { thinking: true },
    }
    const req = buildRequest(convo)
    expect(req.thinking).toBeDefined()
    expect((req.thinking as any).type).toBe('enabled')
    expect((req.thinking as any).budget_tokens).toBeGreaterThan(0)
  })

  it('omits thinking parameter when options.thinking is false', () => {
    const convo: Conversation = {
      ...baseConversation,
      options: { thinking: false },
    }
    const req = buildRequest(convo)
    expect(req.thinking).toBeUndefined()
  })

  it('drops dangling assistant tool_use blocks before a later user text turn', () => {
    const conv: Conversation = {
      ...baseConversation,
      turns: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Fix it' }],
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Working on it.' },
            { type: 'tool_use', id: 'edit:38', name: 'edit', input: { path: 'foo.ts' } },
          ],
          timestamp: 2,
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '继续' }],
          timestamp: 3,
        },
      ],
    }

    const req = buildRequest(conv)
    expect(req.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ])
  })

  it('drops orphan tool_result turns during sanitization', () => {
    const turns = sanitizeConversationTurns([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: 1,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'stale output' }],
        timestamp: 2,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 3,
      },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.role).toBe('user')
    expect(turns[1]!.role).toBe('assistant')
  })
})

describe('sanitizeConversationTurns — allMatched fix', () => {
  it('preserves valid tool_use/tool_result pair when user turn also contains text', () => {
    const turns = sanitizeConversationTurns([
      {
        role: 'user',
        content: [{ type: 'text', text: 'fix this' }],
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'edit:1', name: 'edit', input: { path: 'f.ts' } }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'edit:1', content: 'ok', is_error: false },
          { type: 'text', text: 'also some context' },
        ],
        timestamp: 3,
      },
    ] as ConversationTurn[])

    expect(turns).toHaveLength(3)
    expect(turns[1]!.role).toBe('assistant')
    expect(turns[1]!.content.some(b => b.type === 'tool_use')).toBe(true)
    expect(turns[2]!.content.some(b => b.type === 'tool_result')).toBe(true)
    expect(turns[2]!.content.some(b => b.type === 'text')).toBe(true)
  })

  it('handles multiple tool_use blocks where all are resolved', () => {
    const turns = sanitizeConversationTurns([
      {
        role: 'user',
        content: [{ type: 'text', text: 'do both' }],
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'read:1', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'edit:2', name: 'edit', input: { path: 'b.ts' } },
        ],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'read:1', content: 'contents', is_error: false },
          { type: 'tool_result', tool_use_id: 'edit:2', content: 'edited', is_error: false },
        ],
        timestamp: 3,
      },
    ] as ConversationTurn[])

    expect(turns).toHaveLength(3)
    expect(turns[1]!.content.filter(b => b.type === 'tool_use')).toHaveLength(2)
    expect(turns[2]!.content.filter(b => b.type === 'tool_result')).toHaveLength(2)
  })

  it('strips dangling tool_use when not all pending IDs are resolved', () => {
    const turns = sanitizeConversationTurns([
      {
        role: 'user',
        content: [{ type: 'text', text: 'go' }],
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'edit:1', name: 'edit', input: {} },
          { type: 'tool_use', id: 'edit:2', name: 'edit', input: {} },
        ],
        timestamp: 2,
      },
      {
        role: 'user',
        // Only one of the two tool_use IDs resolved
        content: [{ type: 'tool_result', tool_use_id: 'edit:1', content: 'ok', is_error: false }],
        timestamp: 3,
      },
    ] as ConversationTurn[])

    // No assistant turn should have a dangling tool_use
    const hasDanglingToolUse = turns.some((t, i) => {
      if (t.role !== 'assistant') return false
      const toolUseBlocks = t.content.filter(b => b.type === 'tool_use')
      if (toolUseBlocks.length === 0) return false
      const next = turns[i + 1]
      if (!next || next.role !== 'user') return true
      const resultIds = next.content
        .filter(b => b.type === 'tool_result')
        .map(b => (b as { tool_use_id: string }).tool_use_id)
      return !toolUseBlocks.every(tb => resultIds.includes((tb as { id: string }).id))
    })
    expect(hasDanglingToolUse).toBe(false)
  })
})

describe('validateAndRepairConversation', () => {
  it('returns repaired=false for clean history', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: 2 },
    ]
    const result = validateAndRepairConversation(turns)
    expect(result.repaired).toBe(false)
    expect(result.warnings).toHaveLength(0)
    expect(result.turns).toHaveLength(2)
  })

  it('returns repaired=true and removes dangling tool_use', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'edit:38', name: 'edit', input: {} }],
        timestamp: 2,
      },
      // Missing tool_result — dangling tool_use
      { role: 'user', content: [{ type: 'text', text: 'continue' }], timestamp: 3 },
    ]
    const result = validateAndRepairConversation(turns)
    expect(result.repaired).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    const hasDanglingToolUse = result.turns.some(t =>
      t.role === 'assistant' && t.content.some(b => b.type === 'tool_use'),
    )
    expect(hasDanglingToolUse).toBe(false)
  })

  it('returns repaired=false for empty turns', () => {
    const result = validateAndRepairConversation([])
    expect(result.repaired).toBe(false)
    expect(result.turns).toHaveLength(0)
  })

  // ── P0 cancel-closure regression guard ──
  //
  // After a Ctrl+C mid-tool, the conversation loop synthesizes an
  // "[aborted] Tool cancelled by user" tool_result user turn so the
  // assistant's tool_use pair is well-formed. THIS TEST locks down
  // the contract that the synthesized pair passes validation
  // cleanly: no repair, no warning, no stripping. Without this
  // guard, a future refactor could reintroduce the real-machine
  // QA bug where the next turn emitted
  // "⚠ Conversation repair: cleaned orphaned tool calls" and the
  // model re-executed the cancelled tool.
  it('passes synthesized [tool_use + aborted tool_result] pair through without repair', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'run sleep' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'bash:42', name: 'bash', input: { command: 'sleep 60' } }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'bash:42',
          content: '[aborted] Tool cancelled by user',
          is_error: true,
        }],
        timestamp: 3,
      },
    ]
    const result = validateAndRepairConversation(turns)
    expect(result.repaired).toBe(false)
    expect(result.warnings).toHaveLength(0)
    expect(result.turns).toHaveLength(3)
    // Assistant tool_use survives intact.
    const assistantBlock = result.turns[1]!.content[0] as { type: string; id: string }
    expect(assistantBlock.type).toBe('tool_use')
    expect(assistantBlock.id).toBe('bash:42')
    // Tool_result pair preserved with matching id.
    const toolResultBlock = result.turns[2]!.content[0] as {
      type: string
      tool_use_id: string
      is_error: boolean
    }
    expect(toolResultBlock.type).toBe('tool_result')
    expect(toolResultBlock.tool_use_id).toBe('bash:42')
    expect(toolResultBlock.is_error).toBe(true)
  })

  it('passes synthesized pair plus a follow-up user message without repair', () => {
    // Real-world cancel+queue flow: after abort, the queued message
    // drains as a new user turn appended to history. The whole
    // sequence — original request, assistant tool_use, synthesized
    // tool_result, follow-up user text — must validate clean.
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'run sleep' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'bash:77', name: 'bash', input: {} }],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'bash:77',
          content: '[aborted] Tool cancelled by user',
          is_error: true,
        }],
        timestamp: 3,
      },
      { role: 'user', content: [{ type: 'text', text: 'try a different approach' }], timestamp: 4 },
    ]
    const result = validateAndRepairConversation(turns)
    expect(result.repaired).toBe(false)
    expect(result.warnings).toHaveLength(0)
    expect(result.turns).toHaveLength(4)
  })

  it('passes synthesized pair with partial-complete + filler results (mixed abort path)', () => {
    // One tool_use block had time to finish before abort, a second
    // didn't — the conversation loop mixes real and synthesized
    // results into one tool_result user turn. Must still validate.
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: 'read two files' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'read:1', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'read:2', name: 'read', input: { path: 'b.ts' } },
        ],
        timestamp: 2,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read:1',
            content: 'file a contents',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'read:2',
            content: '[aborted] Tool cancelled by user',
            is_error: true,
          },
        ],
        timestamp: 3,
      },
    ]
    const result = validateAndRepairConversation(turns)
    expect(result.repaired).toBe(false)
    expect(result.warnings).toHaveLength(0)
    expect(result.turns[2]!.content).toHaveLength(2)
  })
})
