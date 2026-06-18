import { describe, it, expect, vi } from 'vitest'

// Mock the dispatch module
vi.mock('../../src/native/dispatch.js', () => {
  const STUB_DESCRIPTIONS: Record<string, string> = {
    McpAuth: '[stub] tokens are NOT validated',
  }
  class MockDispatcher {
    getToolNames() { return ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'Sleep', 'LongTaskList', 'LongTaskGet', 'LongTaskAwait', 'LongTaskReplace', 'RuntimeRecoveryList', 'RuntimeRecoveryGet', 'EnterPlanMode', 'ExitPlanMode', 'Config', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'TeamCreate', 'TeamDelete', 'ToolSearch', 'StructuredOutput', 'RemoteTrigger', 'MCPTool', 'ListMcpResources', 'ReadMcpResource', 'McpAuth', 'Skill', 'LSP', 'PowerShell', 'Brief'] }
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

  it('TaskUpdate schema exposes verification spec repair', () => {
    const schema = NATIVE_TOOL_SCHEMAS['TaskUpdate'] as Record<string, any>
    expect(schema.properties.verification).toBeDefined()
    expect(schema.properties.verification.description).toContain('correct an unsatisfiable or wrong TaskVerify spec')
    expect(schema.properties.verification.items.properties.kind.enum).toContain('artifact_count')
  })

  it('TaskCreate schema exposes optional command-backed execution fields', () => {
    const schema = NATIVE_TOOL_SCHEMAS['TaskCreate'] as Record<string, any>
    expect(schema.properties.command.description).toContain('safe_readonly')
    expect(schema.properties.cwd.description).toContain('Working directory')
    expect(schema.required).toEqual(['subject', 'description'])
  })

  it('Agent schema exposes per-call watchdog timeout controls', () => {
    const schema = NATIVE_TOOL_SCHEMAS['Agent'] as Record<string, any>
    expect(schema.properties.idle_timeout_ms.description).toContain('Positive values only')
    expect(schema.properties.max_runtime_ms.description).toContain('hard ceiling')
  })

  it('Agent lifecycle inspection schemas are read-only and queryable', () => {
    const list = NATIVE_TOOL_SCHEMAS['AgentRunList'] as Record<string, any>
    const get = NATIVE_TOOL_SCHEMAS['AgentRunGet'] as Record<string, any>
    expect(list.properties.limit.description).toContain('Maximum recent Agent runs')
    expect(get.required).toEqual(['agentId'])
    expect(get.properties.agentId.description).toContain('Agent run ID')
    expect(get.description).toContain('does not resume')
  })

  it('RuntimeRecovery inspection schemas are read-only and queryable', () => {
    const list = NATIVE_TOOL_SCHEMAS['RuntimeRecoveryList'] as Record<string, any>
    const get = NATIVE_TOOL_SCHEMAS['RuntimeRecoveryGet'] as Record<string, any>
    expect(list.properties.limit.description).toContain('runtime recovery checkpoints')
    expect(list.description).toContain('Read-only')
    expect(get.required).toEqual(['checkpointId'])
    expect(get.properties.checkpointId.description).toContain('checkpoint ID')
    expect(get.description).toContain('does not resume')
  })

  it('LongTask lifecycle inspection schemas are read-only and queryable', () => {
    const list = NATIVE_TOOL_SCHEMAS['LongTaskList'] as Record<string, any>
    const get = NATIVE_TOOL_SCHEMAS['LongTaskGet'] as Record<string, any>
    expect(list.properties.limit.description).toContain('long-task lifecycle records')
    expect(list.description).toContain('Read-only')
    expect(get.required).toEqual(['longTaskId'])
    expect(get.properties.longTaskId.description).toContain('Long task ID')
    expect(get.description).toContain('does not wait')

    const awaitSchema = NATIVE_TOOL_SCHEMAS['LongTaskAwait'] as Record<string, any>
    expect(awaitSchema.required).toEqual(['longTaskId'])
    expect(awaitSchema.properties.longTaskId.description).toContain('Long task ID')
    expect(awaitSchema.properties.timeoutMs.description).toContain('runtime wait')
    expect(awaitSchema.description).toContain('runtime-managed')

    const replace = NATIVE_TOOL_SCHEMAS['LongTaskReplace'] as Record<string, any>
    expect(replace.required).toEqual(['longTaskId'])
    expect(replace.properties.command.description).toContain('safe_readonly')
    expect(replace.description).toContain('replace_or_retry')
  })
})

describe('buildNativeToolDefs', () => {
  it('builds tool definitions for all registered tools', () => {
    const dispatcher = new ToolDispatcher()
    const defs = buildNativeToolDefs(dispatcher)

    expect(defs).toHaveLength(42)
    const names = defs.map((d: { name: string }) => d.name)
    expect(names).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'Sleep', 'LongTaskList', 'LongTaskGet', 'LongTaskAwait', 'LongTaskReplace', 'RuntimeRecoveryList', 'RuntimeRecoveryGet', 'EnterPlanMode', 'ExitPlanMode', 'Config', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'TeamCreate', 'TeamDelete', 'ToolSearch', 'StructuredOutput', 'RemoteTrigger', 'MCPTool', 'ListMcpResources', 'ReadMcpResource', 'McpAuth', 'Skill', 'LSP', 'PowerShell', 'Brief'])
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
