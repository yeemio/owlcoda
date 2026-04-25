/**
 * OwlCoda Native Layer — Integration Test
 *
 * Tests the complete native stack from tool-defs through dispatch,
 * conversation, and REPL/headless wiring. Verifies the full flow
 * without needing an actual LLM backend.
 */

import { describe, it, expect, vi } from 'vitest'

// Import all native modules to verify they export correctly
import {
  // Tools
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  // Protocol
  buildRequest,
  parseResponse,
  consumeStream,
  createAccumulator,
  // Dispatch
  ToolDispatcher,
  // Conversation
  createConversation,
  addUserMessage,
  // Frontend
  buildNativeToolDefs,
  NATIVE_TOOL_SCHEMAS,
  buildSystemPrompt,
  // Display
  ansi,
  formatToolStart,
  formatToolEnd,
  formatError,
  Spinner,
  truncateOutput,
  // Usage
  UsageTracker,
  estimateTokens,
  // Meta
  NATIVE_VERSION,
} from '../../src/native/index.js'

describe('Native Layer Integration', () => {
  it('exports all tool factory functions', () => {
    expect(typeof createBashTool).toBe('function')
    expect(typeof createReadTool).toBe('function')
    expect(typeof createWriteTool).toBe('function')
    expect(typeof createEditTool).toBe('function')
    expect(typeof createGlobTool).toBe('function')
    expect(typeof createGrepTool).toBe('function')
  })

  it('exports protocol functions', () => {
    expect(typeof buildRequest).toBe('function')
    expect(typeof parseResponse).toBe('function')
    expect(typeof consumeStream).toBe('function')
    expect(typeof createAccumulator).toBe('function')
  })

  it('exports dispatcher and conversation', () => {
    expect(typeof ToolDispatcher).toBe('function')
    expect(typeof createConversation).toBe('function')
    expect(typeof addUserMessage).toBe('function')
  })

  it('exports frontend utilities', () => {
    expect(typeof buildNativeToolDefs).toBe('function')
    expect(typeof NATIVE_TOOL_SCHEMAS).toBe('object')
    expect(typeof buildSystemPrompt).toBe('function')
  })

  it('exports display formatters', () => {
    expect(typeof ansi).toBe('object')
    expect(typeof formatToolStart).toBe('function')
    expect(typeof formatToolEnd).toBe('function')
    expect(typeof formatError).toBe('function')
    expect(typeof Spinner).toBe('function')
    expect(typeof truncateOutput).toBe('function')
  })

  it('exports usage tracking', () => {
    expect(typeof UsageTracker).toBe('function')
    expect(typeof estimateTokens).toBe('function')
  })

  it('has a version string', () => {
    expect(NATIVE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('Full Stack: tool-defs → dispatch → conversation', () => {
  it('dispatcher registers all 40 native tools', () => {
    const dispatcher = new ToolDispatcher()
    const names = dispatcher.getToolNames()
    expect(names).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'Sleep', 'EnterPlanMode', 'ExitPlanMode', 'Config', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'SendMessage', 'TeamCreate', 'TeamDelete', 'ToolSearch', 'StructuredOutput', 'ScheduleCron', 'RemoteTrigger', 'MCPTool', 'ListMcpResources', 'ReadMcpResource', 'McpAuth', 'Skill', 'LSP', 'PowerShell', 'Brief', 'Tungsten', 'Workflow'])
  })

  it('tool-defs produces Anthropic-format tool definitions', () => {
    const dispatcher = new ToolDispatcher()
    const defs = buildNativeToolDefs(dispatcher)
    expect(defs).toHaveLength(40)
    for (const def of defs) {
      expect(def).toHaveProperty('name')
      expect(def).toHaveProperty('description')
      expect(def).toHaveProperty('input_schema')
    }
  })

  it('conversation can be created with native tool defs', () => {
    const dispatcher = new ToolDispatcher()
    const conv = createConversation({
      system: buildSystemPrompt(),
      model: 'test-model',
      maxTokens: 4096,
      tools: buildNativeToolDefs(dispatcher),
    })
    expect(conv.id).toMatch(/^conv-/)
    expect(conv.model).toBe('test-model')
    expect(conv.tools.length).toBe(40)
    expect(conv.turns).toHaveLength(0)
  })

  it('user messages are added correctly', () => {
    const conv = createConversation({
      system: 'test',
      model: 'test',
    })
    addUserMessage(conv, 'Hello, world!')
    expect(conv.turns).toHaveLength(1)
    expect(conv.turns[0]!.role).toBe('user')
    expect(conv.turns[0]!.content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: 'Hello, world!' }),
    )
  })

  it('buildRequest produces valid API request from conversation', () => {
    const dispatcher = new ToolDispatcher()
    const conv = createConversation({
      system: 'You are a test assistant.',
      model: 'test-model',
      maxTokens: 2048,
      tools: buildNativeToolDefs(dispatcher),
    })
    addUserMessage(conv, 'What files are here?')

    const request = buildRequest(conv, true)
    expect(request.model).toBe('test-model')
    expect(request.max_tokens).toBe(2048)
    expect(request.system).toEqual([
      { type: 'text', text: 'You are a test assistant.', cache_control: { type: 'ephemeral' } },
    ])
    expect(request.stream).toBe(true)
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    expect(request.tools).toHaveLength(40)
  })
})

describe('Display + Usage integration', () => {
  it('formatToolStart produces ANSI output for each tool type', () => {
    const tools = ['bash', 'read', 'write', 'edit', 'glob', 'grep']
    const expected = ['Bash', 'Read', 'Write', 'Update', 'Search', 'Search']
    for (let i = 0; i < tools.length; i++) {
      const output = formatToolStart(tools[i]!, { command: 'test' })
      expect(output).toContain(expected[i]!)
      expect(output.length).toBeGreaterThan(0)
    }
  })

  it('UsageTracker works end-to-end', () => {
    const tracker = new UsageTracker()
    tracker.recordEstimated('What files are here?', 'Here are the files in the current directory...')
    tracker.recordEstimated('Show me package.json', '{"name": "owlcoda", "version": "0.1.0"}')

    const snap = tracker.getSnapshot()
    expect(snap.requestCount).toBe(2)
    expect(snap.totalInputTokens).toBeGreaterThan(0)
    expect(snap.totalOutputTokens).toBeGreaterThan(0)

    const formatted = tracker.formatUsage()
    expect(formatted).toContain('Tokens:')
    expect(formatted).toContain('Requests: 2')
  })
})

describe('System prompt integration', () => {
  it('builds a prompt that includes all major sections', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('OwlCoda')
    expect(prompt).toContain('<environment>')
    expect(prompt).toContain('<tool_guidelines>')
    expect(prompt).toContain('# Doing tasks')
  })

  it('detects current project as Node.js', () => {
    const prompt = buildSystemPrompt({ cwd: process.cwd() })
    expect(prompt).toContain('Node.js/TypeScript')
  })

  it('includes comprehensive tool set in guidelines', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('web-fetch')
    expect(prompt).toContain('web-search')
    expect(prompt).toContain('comprehensive set of tools')
  })

  it('includes mode flags when set', () => {
    const prompt = buildSystemPrompt({ modes: { brief: true, fast: true, effort: 'low' } })
    expect(prompt).toContain('BRIEF mode')
    expect(prompt).toContain('FAST mode')
    expect(prompt).toContain('Effort level: low')
  })
})

describe('Request builder integration', () => {
  it('includes thinking parameter when enabled', () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      maxTokens: 4096,
    })
    conv.options = { thinking: true }
    addUserMessage(conv, 'Hello')
    const req = buildRequest(conv)
    expect(req.thinking).toBeDefined()
    expect((req.thinking as any).type).toBe('enabled')
  })

  it('omits thinking when not enabled', () => {
    const conv = createConversation({
      system: 'test',
      model: 'test-model',
      maxTokens: 4096,
    })
    addUserMessage(conv, 'Hello')
    const req = buildRequest(conv)
    expect(req.thinking).toBeUndefined()
  })
})
