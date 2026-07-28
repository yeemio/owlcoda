import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import type { GateEvent } from '../../src/native/gate-telemetry.js'

async function readGateEvents(home: string): Promise<GateEvent[]> {
  const dir = join(home, 'telemetry')
  try {
    const files = await readdir(dir)
    const events: GateEvent[] = []
    for (const file of files.filter(f => f.startsWith('gate-events-'))) {
      const contents = await readFile(join(dir, file), 'utf8')
      for (const line of contents.split('\n').filter(Boolean)) {
        events.push(JSON.parse(line) as GateEvent)
      }
    }
    return events
  } catch {
    return []
  }
}

function toolUseResponse(name: string, input: Record<string, unknown>, id = 'tool-1'): Response {
  return multiToolUseResponse([{ name, input, id }])
}

function multiToolUseResponse(
  calls: Array<{ name: string; input: Record<string, unknown>; id: string }>,
): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: calls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(text = 'Done.'): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function registerRead(dispatcher: ToolDispatcher, output: string, isError = false): void {
  dispatcher.register({
    name: 'read',
    description: 'test read',
    async execute() {
      return { output, isError }
    },
  })
}

function registerNoopWrite(dispatcher: ToolDispatcher, writes: string[]): void {
  dispatcher.register({
    name: 'write',
    description: 'test write',
    async execute(input: Record<string, unknown>) {
      const path = String(input['path'] ?? '')
      writes.push(path)
      return {
        output: `wrote ${path}`,
        isError: false,
        metadata: { path },
      }
    },
  })
}

function registerBash(dispatcher: ToolDispatcher, output: string, isError = false): void {
  dispatcher.register({
    name: 'bash',
    description: 'test bash',
    async execute() {
      return { output, isError }
    },
  })
}

async function writeProjectSettings(projectRoot: string, content: unknown): Promise<void> {
  const dir = join(projectRoot, '.owlcoda')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify(content), 'utf8')
}

afterEach(() => {
  delete process.env['OWLCODA_HOME']
  delete process.env['OWLCODA_GATE_PROVENANCE']
  vi.restoreAllMocks()
})

describe('conversation write-target provenance shadow gate', () => {
  it('shadow mode lets an invented write execute and emits would-block telemetry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-shadow-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请直接回答，不需要写文件。')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'invented.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_would_block',
        canonicalPath: target,
        isNewFile: true,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('user-declared target emits admit evidence before write execution', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-admit-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请写 src/declared.ts')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'declared.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'user_declared_target',
        authorizingKind: 'user_declared_target',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('Read success then Write same existing file emits admit evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-read-admit-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'src', 'known.ts')
      await mkdir(join(canonicalCwd, 'src'), { recursive: true })
      await writeFile(target, 'existing content')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '先看文件，再原地更新。')
      const dispatcher = new ToolDispatcher()
      registerRead(dispatcher, 'existing content')
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-read-1', name: 'read', input: { path: target } },
          { id: 'tool-write-1', name: 'write', input: { path: target, content: 'next' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'tool_confirmed_existing',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('Read success does not admit sibling new-file write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-read-sibling-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const readTarget = join(canonicalCwd, 'src', 'known.ts')
      const writeTarget = join(canonicalCwd, 'src', 'sibling.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '先看文件，再决定。')
      const dispatcher = new ToolDispatcher()
      registerRead(dispatcher, 'existing content')
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-read-1', name: 'read', input: { path: readTarget } },
          { id: 'tool-write-1', name: 'write', input: { path: writeTarget, content: 'next' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([writeTarget])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_would_block',
        canonicalPath: writeTarget,
        isNewFile: true,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('failed Read does not admit the missing path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-read-fail-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'src', 'missing.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '处理这个文件，必要时写结果。')
      const dispatcher = new ToolDispatcher()
      registerRead(dispatcher, 'ENOENT', true)
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-read-1', name: 'read', input: { path: target } },
          { id: 'tool-write-1', name: 'write', input: { path: target, content: 'next' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_would_block',
        canonicalPath: target,
      }))
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('Bash ls admits parent directory for a subsequent new-file write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-bash-ls-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const dir = join(canonicalCwd, 'dist')
      const target = join(dir, 'out.html')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '先列目录，再写结果。')
      const dispatcher = new ToolDispatcher()
      registerBash(dispatcher, 'total 0\n')
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-bash-1', name: 'bash', input: { command: `ls ${dir}` } },
          { id: 'tool-write-1', name: 'write', input: { path: target, content: '<html></html>' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_parent_admit',
        canonicalPath: target,
        via: 'parent_listing',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('conversation write-target provenance — flag-on blocking (S2-1)', () => {
  it('F1: invented new path blocks under flag (write tool not executed)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-block-f1-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请直接回答，不需要写文件。')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'invented.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      // Critical: the write tool MUST NOT have executed under flag.
      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      // The block event is emitted instead of would_block.
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
        canonicalPath: target,
        isNewFile: true,
      }))
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_would_block',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F2: user-declared target passes under flag (write tool executes)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-block-f2-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请写 src/declared.ts')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'declared.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      // User declared it, so write proceeds.
      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'user_declared_target',
      }))
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F5: bash redirect to unproven path blocks under flag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-block-f5-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const bashRan: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请直接回答，不需要落盘。')
      const dispatcher = new ToolDispatcher()
      dispatcher.register({
        name: 'bash',
        description: 'test bash',
        async execute(input: Record<string, unknown>) {
          bashRan.push(String(input['command'] ?? ''))
          return { output: '', isError: false }
        },
      })
      const target = join(canonicalCwd, 'invented.log')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('bash', { command: `echo X > ${target}` }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      // bash didn't execute — blocked at provenance gate
      expect(bashRan).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F6: user-mentioned redirect target passes under flag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-block-f6-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const bashRan: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'output.log')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // User explicitly declares the target path with an action verb.
      addUserMessage(conv, `写一下 ${target} 这个 log`)
      const dispatcher = new ToolDispatcher()
      dispatcher.register({
        name: 'bash',
        description: 'test bash',
        async execute(input: Record<string, unknown>) {
          bashRan.push(String(input['command'] ?? ''))
          return { output: '', isError: false }
        },
      })
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('bash', { command: `echo hello > ${target}` }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test-key',
        cwd: canonicalCwd,
        maxIterations: 3,
      })

      expect(bashRan).toEqual([`echo hello > ${target}`])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'user_declared_target',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('conversation write-target provenance — deny / revoke F-fixtures (S2-3)', () => {
  it('F29: `不要改 /tmp/foo` blocks subsequent write to /tmp/foo with deny event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f29-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'tmp-foo.txt')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `不要改 ${target}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'evil' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F30: deny then `算了 改吧 X` lifts the deny and admits the write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f30-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'sometimes-ok.txt')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `不要改 ${target}`)
      addUserMessage(conv, `算了 改吧 ${target}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'ok-now' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // The revoke's dual record (revoke + declared_target) admits the write.
      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'user_declared_target',
      }))
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F31: deny then vague `那个改一下` (no path) keeps deny active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f31-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'still-denied.txt')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `不要改 ${target}`)
      // Vague follow-up — names no path. Stage B revoke requires marker + verb + path.
      addUserMessage(conv, `那个改一下`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'sneak' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F32: deny → revoke → deny again blocks (deny re-asserted)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f32-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'flip-flop.txt')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `不要改 ${target}`)
      addUserMessage(conv, `算了 改吧 ${target}`)
      addUserMessage(conv, `不要改 ${target}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'sneak' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: target,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F33: glob-shaped deny `不要改 src/*.ts` does NOT create a deny record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f33-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    const bashRan: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const srcDir = join(canonicalCwd, 'src')
      const target = join(srcDir, 'foo.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Glob deny — should be skipped, no literal deny created.
      addUserMessage(conv, '不要改 src/*.ts')
      // Then a normal flow: list parent dir, write a file in it.
      // (Avoid `看` so the intent classifier doesn't tag this as analysis-only;
      // intent gate is independent of provenance gate but would short-circuit here.)
      addUserMessage(conv, '先列出 src/，再写结果。')
      const dispatcher = new ToolDispatcher()
      registerBash(dispatcher, 'total 0\n')
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-bash-1', name: 'bash', input: { command: `ls ${srcDir}` } },
          { id: 'tool-write-1', name: 'write', input: { path: target, content: 'x' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      const dispatcherWithBash = dispatcher
      void dispatcherWithBash
      // bashRan via existing registerBash
      void bashRan

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // If glob-deny were honored as exact deny on src/foo.ts, write would block.
      // It is NOT honored → ls admits src as parent_listing → new-file write passes.
      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      // No deny_block ever fires for this path.
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: target,
      }))
      // Parent_admit (parent_listing kind) authorizes the new file.
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_parent_admit',
        canonicalPath: target,
        via: 'parent_listing',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F34: subtree deny on existing dir blocks descendant write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f34-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const projDir = join(canonicalCwd, 'project')
      await mkdir(projDir, { recursive: true })
      const child = join(projDir, 'a.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Deny on an existing directory → extractor marks denyScope=subtree.
      addUserMessage(conv, `不要改 ${projDir}`)
      // Try to write a child even though user later authorizes something else.
      addUserMessage(conv, `改 ${child}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: child, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Subtree deny on parent dir wins over declared_target on child.
      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: child,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F36: child-path revoke does NOT lift parent subtree deny', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f36-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const projDir = join(canonicalCwd, 'protected')
      await mkdir(projDir, { recursive: true })
      const child = join(projDir, 'a.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Subtree deny on parent directory.
      addUserMessage(conv, `不要改 ${projDir}`)
      // Revoke names the CHILD path — should NOT lift parent deny.
      addUserMessage(conv, `算了 改吧 ${child}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: child, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Subtree deny on /protected still active — child revoke doesn't reach it.
      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: child,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('F37b: parent revoke + ls parent → child new-file write passes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-prov-f37b-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-prov-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const projDir = join(canonicalCwd, 'thawed')
      await mkdir(projDir, { recursive: true })
      const child = join(projDir, 'fresh.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `不要改 ${projDir}`)
      // Revoke on the SAME path as the deny — lifts subtree deny.
      addUserMessage(conv, `算了 改吧 ${projDir}`)
      // Plus parent_listing via ls — admits the new-file child write.
      addUserMessage(conv, '先 ls 一下再写。')
      const dispatcher = new ToolDispatcher()
      registerBash(dispatcher, 'total 0\n')
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(multiToolUseResponse([
          { id: 'tool-bash-1', name: 'bash', input: { command: `ls ${projDir}` } },
          { id: 'tool-write-1', name: 'write', input: { path: child, content: 'x' } },
        ]))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Subtree deny lifted (revoke names same path), parent_listing admits child.
      expect(writes).toEqual([child])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_parent_admit',
        canonicalPath: child,
        via: 'parent_listing',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('settings.json permission rules — end-to-end (PERM-7)', () => {
  it('project-level deny rule blocks a write that conversation would otherwise admit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-deny-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const protectedFile = join(canonicalCwd, 'secret.lock')
      // Project settings.json denies any tool writing to *.lock.
      await writeProjectSettings(canonicalCwd, {
        permissions: { deny: ['*(./secret.lock)'] },
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // User explicitly asks to write — would normally pass as
      // user_declared_target. Rule should override.
      addUserMessage(conv, `请写 ${protectedFile}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: protectedFile, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Write blocked — settings rule beats conversation declared_target.
      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_deny_block',
        canonicalPath: protectedFile,
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('project-level deny SURVIVES a conversation revoke (permanent flag wins)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-permanent-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const protectedFile = join(canonicalCwd, 'secret.lock')
      await writeProjectSettings(canonicalCwd, {
        permissions: { deny: ['*(./secret.lock)'] },
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Even if user explicitly tries to authorize, the settings rule wins.
      addUserMessage(conv, `算了 改吧 ${protectedFile}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: protectedFile, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('project-level allow rule cannot authorize a write the conversation cannot justify', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-allow-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const outFile = join(canonicalCwd, 'out', 'result.html')
      // Project settings.json allows anything under ./out.
      await writeProjectSettings(canonicalCwd, {
        permissions: { allow: ['Write(./out/**)'] },
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Neutral / implementation-intent message; no path mention.
      addUserMessage(conv, '请生成结果')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: outFile, content: '<html/>' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
        canonicalPath: outFile,
        isNewFile: true,
      }))
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: outFile,
        via: 'user_declared_target',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('Bash(...) rule emits path_provenance_rule_warning telemetry on load', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-bashwarn-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    try {
      const canonicalCwd = await realpath(cwd)
      await writeProjectSettings(canonicalCwd, {
        permissions: { deny: ['Bash(curl *)'] },
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请执行命令')
      const dispatcher = new ToolDispatcher()
      // Register a bash that runs — we don't expect the rule to block it
      // (Bash rules are parsed-but-not-enforced in v1).
      dispatcher.register({
        name: 'bash',
        description: 'test bash',
        async execute() {
          return { output: '', isError: false }
        },
      })
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('bash', { command: 'echo hi' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_rule_warning',
        ruleWarningReason: 'bash_not_enforced',
        ruleWarningRaw: 'Bash(curl *)',
        ruleWarningSource: 'project',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('bare-string rule emits bare_string warning telemetry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-bare-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    try {
      const canonicalCwd = await realpath(cwd)
      await writeProjectSettings(canonicalCwd, {
        permissions: { deny: ['~/.ssh/**'] },   // missing Tool() wrapper
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请生成结果')
      const dispatcher = new ToolDispatcher()
      const writes: string[] = []
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', {
          path: join(canonicalCwd, 'innocuous.ts'),
          content: 'x',
        }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_rule_warning',
        ruleWarningReason: 'bare_string',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('valid path rule does NOT emit warning telemetry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-nowarn-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-perm-e2e-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    try {
      const canonicalCwd = await realpath(cwd)
      await writeProjectSettings(canonicalCwd, {
        permissions: { deny: ['*(./scratch/**)'] },
      })
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请生成结果')
      const dispatcher = new ToolDispatcher()
      const writes: string[] = []
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', {
          path: join(canonicalCwd, 'innocuous.ts'),
          content: 'x',
        }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      const events = await readGateEvents(home)
      const warnings = events.filter(e => e.kind === 'path_provenance_rule_warning')
      expect(warnings).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})
