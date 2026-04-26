import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import type { AnthropicToolUseBlock } from '../../src/native/protocol/types.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { ensureTaskExecutionState } from '../../src/native/task-state.js'

describe('Native Tool Dispatcher', () => {
  let tempDir = ''
  let prevAllow: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-dispatch-test-'))
    // The fs-policy guard restricts writes to process.cwd(); these tests
    // exercise the dispatcher against a tmpdir scratch path, so opt that
    // path in via the same env-var seam users would use.
    prevAllow = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = tempDir
  })

  afterEach(async () => {
    if (prevAllow === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('registers all 40 default tools', () => {
    const dispatcher = new ToolDispatcher()
    const names = dispatcher.getToolNames()
    expect(names).toContain('bash')
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('glob')
    expect(names).toContain('grep')
    expect(names).toContain('WebFetch')
    expect(names).toContain('WebSearch')
    expect(names).toContain('TodoWrite')
    expect(names).toContain('AskUserQuestion')
    expect(names).toContain('Sleep')
    expect(names).toContain('EnterPlanMode')
    expect(names).toContain('ExitPlanMode')
    expect(names).toContain('Config')
    expect(names).toContain('NotebookEdit')
    expect(names).toContain('EnterWorktree')
    expect(names).toContain('ExitWorktree')
    expect(names).toContain('TaskCreate')
    expect(names).toContain('TaskList')
    expect(names).toContain('TaskGet')
    expect(names).toContain('TaskUpdate')
    expect(names).toContain('TaskStop')
    expect(names).toContain('TaskOutput')
    expect(names).toContain('SendMessage')
    expect(names).toContain('TeamCreate')
    expect(names).toContain('TeamDelete')
    expect(names).toContain('ToolSearch')
    expect(names).toContain('StructuredOutput')
    expect(names).toContain('ScheduleCron')
    expect(names).toContain('RemoteTrigger')
    expect(names).toContain('MCPTool')
    expect(names).toContain('ListMcpResources')
    expect(names).toContain('ReadMcpResource')
    expect(names).toContain('McpAuth')
    expect(names).toContain('Skill')
    expect(names).toContain('LSP')
    expect(names).toContain('PowerShell')
    expect(names).toContain('Brief')
    expect(names).toContain('Tungsten')
    expect(names).toContain('Workflow')
    expect(names).toHaveLength(40)
  })

  it('has() returns true for registered tools', () => {
    const dispatcher = new ToolDispatcher()
    expect(dispatcher.has('bash')).toBe(true)
    expect(dispatcher.has('nonexistent')).toBe(false)
  })

  it('executes a bash tool_use block', async () => {
    const dispatcher = new ToolDispatcher()
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'bash',
      input: { command: 'echo hello' },
    }
    const result = await dispatcher.executeTool(block)
    expect(result.toolUseId).toBe('call_1')
    expect(result.toolName).toBe('bash')
    expect(result.result.isError).toBe(false)
    expect(result.result.output).toBe('hello')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns error for unknown tool', async () => {
    const dispatcher = new ToolDispatcher()
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'call_2',
      name: 'unknown_tool',
      input: {},
    }
    const result = await dispatcher.executeTool(block)
    expect(result.result.isError).toBe(true)
    expect(result.result.output).toContain('unknown tool')
  })

  it('executeAll runs multiple blocks sequentially', async () => {
    const dispatcher = new ToolDispatcher()
    const blocks: AnthropicToolUseBlock[] = [
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'echo one' } },
      { type: 'tool_use', id: 'c2', name: 'bash', input: { command: 'echo two' } },
    ]
    const results = await dispatcher.executeAll(blocks)
    expect(results).toHaveLength(2)
    expect(results[0]!.result.output).toBe('one')
    expect(results[1]!.result.output).toBe('two')
  })

  it('toContentBlocks creates tool_result blocks', async () => {
    const dispatcher = new ToolDispatcher()
    const blocks: AnthropicToolUseBlock[] = [
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'echo ok' } },
    ]
    const results = await dispatcher.executeAll(blocks)
    const contentBlocks = dispatcher.toContentBlocks(results)
    expect(contentBlocks).toHaveLength(1)
    expect(contentBlocks[0]!.type).toBe('tool_result')
    expect((contentBlocks[0] as any).tool_use_id).toBe('c1')
    expect((contentBlocks[0] as any).content).toBe('ok')
    expect((contentBlocks[0] as any).is_error).toBe(false)
  })

  it('handles tool execution errors gracefully', async () => {
    const dispatcher = new ToolDispatcher()
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'c3',
      name: 'read',
      input: { path: '/nonexistent/path/to/file.txt' },
    }
    const result = await dispatcher.executeTool(block)
    expect(result.result.isError).toBe(true)
    expect(result.result.output).toContain('Error')
  })

  it('allows registering custom tools', async () => {
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'custom',
      description: 'A custom tool',
      async execute() {
        return { output: 'custom result', isError: false }
      },
    })
    expect(dispatcher.has('custom')).toBe(true)
    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'c4',
      name: 'custom',
      input: {},
    })
    expect(result.result.output).toBe('custom result')
  })

  it('blocks out-of-scope writes when task contract has explicit file targets', async () => {
    const allowedPath = join(tempDir, 'allowed.txt')
    const blockedPath = join(tempDir, 'blocked.txt')
    const dispatcher = new ToolDispatcher()
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Only modify \`${allowedPath}\`.`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)

    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'write-blocked',
      name: 'write',
      input: { path: blockedPath, content: 'nope' },
    }, { taskState })

    expect(result.result.isError).toBe(true)
    expect(result.result.output).toContain('Task contract blocked write')
    expect((result.result.metadata as Record<string, unknown>)?.taskGuardBlocked).toBe(true)
    expect(taskState.run.status).toBe('waiting_user')
    expect(taskState.run.pendingWriteApproval?.attemptedPaths).toContain(join(await realpath(tempDir), 'blocked.txt'))
  })

  it('allows a previously blocked write after the user approves the expanded scope', async () => {
    const allowedPath = join(tempDir, 'allowed.txt')
    const blockedPath = join(tempDir, 'blocked.txt')
    const dispatcher = new ToolDispatcher()
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Only modify \`${allowedPath}\`.`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)

    const blocked = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'write-blocked',
      name: 'write',
      input: { path: blockedPath, content: 'blocked first\n' },
    }, { taskState })
    expect(blocked.result.isError).toBe(true)

    addUserMessage(conversation, '批准，继续写这个被拦截的文件。')
    const approvedState = ensureTaskExecutionState(conversation, tempDir)
    const allowed = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'write-approved',
      name: 'write',
      input: { path: blockedPath, content: 'approved\n' },
    }, { taskState: approvedState })

    expect(allowed.result.isError).toBe(false)
    expect(await readFile(blockedPath, 'utf-8')).toBe('approved\n')
    expect(approvedState.run.status).toBe('open')
  })

  it('allows writes to derived companion test paths for explicit src targets', async () => {
    const srcFile = join(tempDir, 'src', 'native', 'conversation.ts')
    const testFile = join(tempDir, 'tests', 'native', 'conversation.test.ts')
    const dispatcher = new ToolDispatcher()
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Update \`${srcFile}\` and keep the tests honest.`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)

    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'write-test',
      name: 'write',
      input: { path: testFile, content: 'export {}\n' },
    }, { taskState })
    const canonicalTempDir = await realpath(tempDir)
    const canonicalTestFile = join(canonicalTempDir, 'tests', 'native', 'conversation.test.ts')

    expect(result.result.isError).toBe(false)
    expect(await readFile(testFile, 'utf-8')).toBe('export {}\n')
    expect(taskState.contract.touchedPaths).toContain(canonicalTestFile)
  })

  it('does not block reads or record read paths as writes under an explicit task contract', async () => {
    const allowedPath = join(tempDir, 'allowed.txt')
    const readOnlyPath = join(tempDir, 'notes.txt')
    await writeFile(readOnlyPath, 'hello from read\n')

    const dispatcher = new ToolDispatcher()
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Only modify \`${allowedPath}\`.`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)

    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'read-ok',
      name: 'read',
      input: { path: readOnlyPath },
    }, { taskState })

    expect(result.result.isError).toBe(false)
    expect(result.result.output).toContain('hello from read')
    expect(taskState.run.status).toBe('open')
    expect(taskState.contract.touchedPaths).not.toContain(readOnlyPath)
    expect(taskState.contract.allowedWritePaths.some((scope) => scope.path === readOnlyPath)).toBe(false)
  })
})
