import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import type { AnthropicToolUseBlock } from '../../src/native/protocol/types.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { ensureTaskExecutionState, markTaskIteration, recordBashArtifactProgress } from '../../src/native/task-state.js'

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

  it('registers all 51 default tools', () => {
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
    expect(names).toContain('LongTaskList')
    expect(names).toContain('LongTaskGet')
    expect(names).toContain('LongTaskAwait')
    expect(names).toContain('LongTaskReplace')
    expect(names).toContain('AgentRunList')
    expect(names).toContain('AgentRunGet')
    expect(names).toContain('RuntimeRecoveryList')
    expect(names).toContain('RuntimeRecoveryGet')
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
    expect(names).toContain('TaskVerify')
    expect(names).toContain('TeamCreate')
    expect(names).toContain('TeamDelete')
    expect(names).toContain('ToolSearch')
    expect(names).toContain('StructuredOutput')
    expect(names).toContain('RemoteTrigger')
    expect(names).toContain('MCPTool')
    expect(names).toContain('ListMcpResources')
    expect(names).toContain('ReadMcpResource')
    expect(names).toContain('McpAuth')
    expect(names).toContain('Skill')
    expect(names).toContain('LSP')
    expect(names).toContain('PowerShell')
    expect(names).toContain('Brief')
    expect(names).toContain('DeliveryAudit')
    expect(names).toContain('SkillRoutePreview')
    expect(names).toContain('RunWorkspace')
    expect(names).toContain('ProjectMap')
    expect(names).toContain('ArtifactVerify')
    expect(names).toContain('ProbePlan')
    expect(names).toHaveLength(51)
  })

  it('has() returns true for registered tools', () => {
    const dispatcher = new ToolDispatcher()
    expect(dispatcher.has('bash')).toBe(true)
    expect(dispatcher.has('nonexistent')).toBe(false)
  })

  it('getToolDescription returns honest stub-disclosure copy from tool factories', () => {
    const dispatcher = new ToolDispatcher()
    // Stub tools self-disclose in their factory description.
    expect(dispatcher.getToolDescription('McpAuth')).toMatch(/NOT validated/)
    expect(dispatcher.getToolDescription('StructuredOutput')).toMatch(/validates the data payload/)
    // Unregistered tool returns undefined.
    expect(dispatcher.getToolDescription('definitely-not-a-tool')).toBeUndefined()
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
    // 0.13.60: bash output structured with [stdout]/[exit code: N] sections.
    expect(result.result.output).toContain('hello')
    expect(result.result.output).toContain('[exit code: 0]')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('binds structured file-artifact TaskCreate plans to a run workspace', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'owlcoda-dispatch-output-'))
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Build the HTML PPT and output to ${outputRoot}/`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)
    const dispatcher = new ToolDispatcher()

    try {
      const result = await dispatcher.executeTool({
        type: 'tool_use',
        id: 'task-create',
        name: 'TaskCreate',
        input: {
          subject: 'Build deck',
          description: 'Create the deck and build notes.',
          steps: [
            { id: 'step-1', title: 'Read sources', description: 'Read source material.' },
            { id: 'step-2', title: 'Write deck', description: 'Write deck artifacts.' },
          ],
        },
      } as AnthropicToolUseBlock, { taskState })
      const canonicalOutputRoot = await realpath(outputRoot)

      expect(result.result.isError).toBe(false)
      expect(taskState.run.runWorkspace).toMatchObject({
        outputRoot: canonicalOutputRoot,
        runDir: join(canonicalOutputRoot, '.owlcoda-run'),
        taskFamily: 'deck',
        deliverableMode: 'file_artifact_delivery',
      })
      expect(taskState.run.runWorkspace?.manifestPath).toBe(join(canonicalOutputRoot, '.owlcoda-run', 'manifest.json'))
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
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

  // 2026-06-13 dogfood (P2-12): a model intermittently emitted the tool name
  // "Bash" (capitalized) while the registry only holds lowercase "bash", so a
  // case-sensitive Map.get missed and returned `unknown tool "Bash"` for some
  // calls in a session where other bash calls worked. Resolve tolerantly and
  // normalize to the canonical registered name for downstream guards/telemetry.
  it('resolves tool names case-insensitively when the model emits the wrong case', async () => {
    const dispatcher = new ToolDispatcher()
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'call_case',
      name: 'Bash',
      input: { command: 'echo hi' },
    }
    const result = await dispatcher.executeTool(block)
    expect(result.result.isError).toBe(false)
    expect(result.result.output).toContain('hi')
    // normalized to the canonical registered name, not the model's casing
    expect(result.toolName).toBe('bash')
  })

  it('exposes has() and getToolDescription() case-insensitively', () => {
    const dispatcher = new ToolDispatcher()
    expect(dispatcher.has('Bash')).toBe(true)
    expect(dispatcher.has('READ')).toBe(true)
    expect(dispatcher.getToolDescription('Bash')).toBe(dispatcher.getToolDescription('bash'))
  })

  it('still reports unknown for a genuinely unregistered tool name', async () => {
    const dispatcher = new ToolDispatcher()
    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'call_frob',
      name: 'Frobnicate',
      input: {},
    } as AnthropicToolUseBlock)
    expect(result.result.isError).toBe(true)
    expect(result.result.output).toContain('unknown tool "Frobnicate"')
  })

  // 2026-06-13 (P2-12 hardening): the case-insensitive resolver above is only
  // safe while no two registered tool names collide once lowercased — otherwise
  // resolveTool() would silently pick whichever was inserted into the Map first
  // and dispatch to the WRONG tool. That is a far worse failure mode than a loud
  // "unknown tool" error, so lock the invariant: a future clash (e.g. both "LSP"
  // and "lsp", or dispatch adopting capitalized "Bash") must fail here loudly.
  function caseInsensitiveCollisions(names: string[]): string[][] {
    const byLower = new Map<string, string[]>()
    for (const name of names) {
      const lower = name.toLowerCase()
      const bucket = byLower.get(lower) ?? []
      bucket.push(name)
      byLower.set(lower, bucket)
    }
    return [...byLower.values()].filter(bucket => bucket.length > 1)
  }

  it('registers no two default tool names that collide case-insensitively', () => {
    const dispatcher = new ToolDispatcher()
    expect(caseInsensitiveCollisions(dispatcher.getToolNames())).toEqual([])
  })

  it('case-insensitive collision detection is not vacuous (flags a real clash)', () => {
    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'BASH',
      description: 'deliberately collides with the lowercase bash tool',
      async execute() { return { output: '', isError: false } },
    })
    const collisions = caseInsensitiveCollisions(dispatcher.getToolNames())
    expect(collisions.some(bucket => bucket.includes('bash') && bucket.includes('BASH'))).toBe(true)
  })

  it('executeAll runs multiple blocks sequentially', async () => {
    const dispatcher = new ToolDispatcher()
    const blocks: AnthropicToolUseBlock[] = [
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'echo one' } },
      { type: 'tool_use', id: 'c2', name: 'bash', input: { command: 'echo two' } },
    ]
    const results = await dispatcher.executeAll(blocks)
    expect(results).toHaveLength(2)
    expect(results[0]!.result.output).toContain('one')
    expect(results[1]!.result.output).toContain('two')
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
    expect((contentBlocks[0] as any).content).toContain('ok')
    expect((contentBlocks[0] as any).content).toContain('[exit code: 0]')
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

  it('blocks out-of-scope bash artifacts before executing the command', async () => {
    const allowedPath = join(tempDir, 'allowed.txt')
    const blockedPath = join(tempDir, 'blocked.txt')
    const dispatcher = new ToolDispatcher()
    let executed = false
    dispatcher.register({
      name: 'bash',
      description: 'test bash',
      async execute() {
        executed = true
        return { output: 'should not run', isError: false }
      },
    })
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, `Only modify \`${allowedPath}\`.`)
    const taskState = ensureTaskExecutionState(conversation, tempDir)

    const result = await dispatcher.executeTool({
      type: 'tool_use',
      id: 'bash-blocked',
      name: 'bash',
      input: { command: `cat > "${blockedPath}" << 'EOF'\nnope\nEOF` },
    }, { taskState })

    expect(executed).toBe(false)
    expect(result.result.isError).toBe(true)
    expect(result.result.output).toContain('Task contract blocked write')
    expect((result.result.metadata as Record<string, unknown>)?.taskGuardBlocked).toBe(true)
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

  // user-external deliverable path e2e tests
  describe('user-external deliverable paths (e2e)', () => {
    it('allows write tool to user-declared external path and records it as touched', async () => {
      // cwd is tempDir (fake workspace); user declares output outside of it
      const externalOut = join(tempDir, '..', 'external-deliverable', 'v.html')
      // The env-var seam opens tempDir but NOT the parent. We need the parent to be reachable by fs-policy.
      // Use OWLCODA_ALLOW_FS_ROOTS to allow the external dir for this test.
      const externalDir = join(tempDir, '..', 'external-deliverable')
      const prevAllow2 = process.env['OWLCODA_ALLOW_FS_ROOTS']
      process.env['OWLCODA_ALLOW_FS_ROOTS'] = `${tempDir}:${externalDir}`

      try {
        const cwd = tempDir
        const conversation = createConversation({ system: 'test', model: 'm' })
        addUserMessage(conversation, `输出到 ${externalOut}`)
        const taskState = ensureTaskExecutionState(conversation, cwd)

        // Sanity: should have user-external scope
        expect(taskState.contract.allowedWritePaths.some(
          (s) => s.origin === 'user-external' && s.path.endsWith('/v.html'),
        )).toBe(true)

        const dispatcher = new ToolDispatcher()
        const result = await dispatcher.executeTool({
          type: 'tool_use',
          id: 'ext-write',
          name: 'write',
          input: { path: externalOut, content: '<html/>' },
        } as AnthropicToolUseBlock, { taskState })

        // Should succeed (not blocked by guard or fs-policy)
        expect(result.result.isError).toBe(false)
        // Should be recorded as a touched path (durable deliverable)
        expect(taskState.contract.touchedPaths.some((p) => p.endsWith('/v.html'))).toBe(true)
      } finally {
        if (prevAllow2 === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
        else process.env['OWLCODA_ALLOW_FS_ROOTS'] = prevAllow2
      }
    })

    it('undeclared external bash write stays in scratch channel (not durable)', () => {
      const cwd = join(tmpdir(), 'owlcoda-dispatch-ext-scratch-cwd')
      const conversation = createConversation({ system: 'test', model: 'm' })
      // User does NOT declare any external path — just a generic task
      addUserMessage(conversation, 'Generate the slides.')
      const taskState = ensureTaskExecutionState(conversation, cwd)
      markTaskIteration(taskState, { iterations: 1 })

      // Bash writes to tmpdir (scratch) — should stay in scratchArtifactPaths
      recordBashArtifactProgress(taskState, 'bash', {
        command: "cat > '/tmp/scratch-random-undeclared.html' << 'EOF'\n<html/>\nEOF",
        cwd,
      })

      // Should NOT be in touchedPaths (not durable)
      expect(taskState.contract.touchedPaths.some((p) => p.endsWith('scratch-random-undeclared.html'))).toBe(false)
      // Should be in scratchArtifactPaths
      expect(taskState.run.scratchArtifactPaths?.some((p) => p.endsWith('scratch-random-undeclared.html'))).toBe(true)
    })
  })
})
