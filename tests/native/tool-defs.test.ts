import { describe, it, expect, vi } from 'vitest'

// Mock the dispatch module
vi.mock('../../src/native/dispatch.js', () => {
  const STUB_DESCRIPTIONS: Record<string, string> = {
    McpAuth: '[stub] tokens are NOT validated',
  }
  class MockDispatcher {
    getToolNames() { return ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'Sleep', 'EnterPlanMode', 'ExitPlanMode', 'Config', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'TeamCreate', 'TeamDelete', 'ToolSearch', 'StructuredOutput', 'RemoteTrigger', 'MCPTool', 'ListMcpResources', 'ReadMcpResource', 'McpAuth', 'Skill', 'LSP', 'PowerShell', 'Brief'] }
    getToolDescription(name: string): string | undefined { return STUB_DESCRIPTIONS[name] }
  }
  return { ToolDispatcher: MockDispatcher }
})

// Mock the protocol request module
vi.mock('../../src/native/protocol/request.js', () => ({
  buildToolDef: (name: string, desc: string, schema: unknown) => ({
    name,
    description: desc,
    input_schema: schema,
  }),
}))

import { NATIVE_TOOL_SCHEMAS, buildNativeToolDefs } from '../../src/native/tool-defs.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'

describe('NATIVE_TOOL_SCHEMAS', () => {
  it('defines schemas for all 6 native tools', () => {
    const expected = ['bash', 'read', 'write', 'edit', 'glob', 'grep']
    for (const name of expected) {
      expect(NATIVE_TOOL_SCHEMAS[name]).toBeDefined()
      expect(NATIVE_TOOL_SCHEMAS[name]!['type']).toBe('object')
      expect(NATIVE_TOOL_SCHEMAS[name]!['properties']).toBeDefined()
      expect(NATIVE_TOOL_SCHEMAS[name]!['required']).toBeDefined()
    }
  })

  it('bash schema requires "command"', () => {
    expect(NATIVE_TOOL_SCHEMAS['bash']!['required']).toEqual(['command'])
  })

  it('read schema requires "path"', () => {
    expect(NATIVE_TOOL_SCHEMAS['read']!['required']).toEqual(['path'])
  })

  it('write schema requires "path" and "content"', () => {
    expect(NATIVE_TOOL_SCHEMAS['write']!['required']).toEqual(['path', 'content'])
  })

  it('edit schema requires "path", "oldStr", and "newStr"', () => {
    expect(NATIVE_TOOL_SCHEMAS['edit']!['required']).toEqual(['path', 'oldStr', 'newStr'])
  })
})

describe('buildNativeToolDefs', () => {
  it('builds tool definitions for all registered tools', () => {
    const dispatcher = new ToolDispatcher()
    const defs = buildNativeToolDefs(dispatcher)

    expect(defs).toHaveLength(36)
    const names = defs.map((d: { name: string }) => d.name)
    expect(names).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'Sleep', 'EnterPlanMode', 'ExitPlanMode', 'Config', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'TeamCreate', 'TeamDelete', 'ToolSearch', 'StructuredOutput', 'RemoteTrigger', 'MCPTool', 'ListMcpResources', 'ReadMcpResource', 'McpAuth', 'Skill', 'LSP', 'PowerShell', 'Brief'])
  })

  it('each def has name, description, and input_schema', () => {
    const dispatcher = new ToolDispatcher()
    const defs = buildNativeToolDefs(dispatcher)

    for (const def of defs) {
      expect(def).toHaveProperty('name')
      expect(def).toHaveProperty('description')
      expect(def).toHaveProperty('input_schema')
    }
  })

  it('honest stub disclosure from tool factory reaches the LLM (not the Native X placeholder)', () => {
    const dispatcher = new ToolDispatcher()
    const defs = buildNativeToolDefs(dispatcher)

    const mcpAuth = defs.find((d: { name: string }) => d.name === 'McpAuth')!
    expect(mcpAuth.description).toBe('[stub] tokens are NOT validated')

    // Tools with no factory-supplied description fall back to the
    // legacy `Native ${name} tool` placeholder, which is fine because
    // it's only those that didn't bother authoring one.
    const bash = defs.find((d: { name: string }) => d.name === 'bash')!
    expect(bash.description).toBe('Native bash tool')
  })
})
