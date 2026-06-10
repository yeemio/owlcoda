import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { buildProjectMapSnapshot } from '../../src/native/project-map.js'
import { buildRequest } from '../../src/native/protocol/request.js'
import type { AnthropicMessagesRequest } from '../../src/native/protocol/types.js'

describe('Project Map runtime harness conversation cache', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-conversation-project-map-'))
    initGit(tmpDir, 'cccccccccccccccccccccccccccccccccccccccc')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'prefer src first')
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true })
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'pm-runtime',
      version: '9.8.7',
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    })
  })

  afterEach(() => {
    delete process.env['OWLCODA_PROJECT_MAP']
    delete process.env['OWLCODA_GATE_PROVENANCE']
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('by default caches a snapshot and injects compact summary into the request system prompt', async () => {
    const requests: AnthropicMessagesRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)) as AnthropicMessagesRequest)
      return textResponse('done')
    })

    const conv = createConversation({ system: 'base system', model: 'test-model' })
    addUserMessage(conv, 'map this project')

    await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 1,
    })

    expect(conv.options?.projectMapSnapshot?.packageName).toBe('pm-runtime')
    expect(conv.options?.projectMapPromptSummary).toContain('<project_map>')
    const systemText = extractSystemText(requests[0]!)
    expect(systemText).toContain('base system')
    expect(systemText).toContain('<project_map>')
    expect(systemText).toContain('Package: pm-runtime@9.8.7')
    expect(systemText).toContain('Instructions: AGENTS.md')
    expect(systemText).toContain('Entry points: src (source_dir), tests (test_dir)')
    expect(systemText).toContain('Verification: npm test; npm run typecheck')
  })

  it('reuses an existing fresh snapshot for the same cwd', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '1'
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    const cachedSnapshot = buildProjectMapSnapshot(tmpDir, {
      createdAt: '2026-05-30T04:00:00.000Z',
    })
    conv.options = {
      projectMapSnapshot: cachedSnapshot,
    }
    addUserMessage(conv, 'continue')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResponse('done'))

    await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 1,
    })

    expect(conv.options?.projectMapSnapshot).toBe(cachedSnapshot)
    expect(conv.options?.projectMapPromptSummary).toContain('Package: pm-runtime@9.8.7')
  })

  it('with OWLCODA_PROJECT_MAP=0 leaves request system prompt unchanged and does not cache a snapshot', () => {
    process.env['OWLCODA_PROJECT_MAP'] = '0'
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    const req = buildRequest(conv)

    expect(extractSystemText(req)).toBe('base system')
    expect(conv.options?.projectMapSnapshot).toBeUndefined()
    expect(conv.options?.projectMapPromptSummary).toBeUndefined()
  })

  it('project map deny boundary hard-blocks a matching write under the flag', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '1'
    const target = path.join(tmpDir, 'src', 'secret.ts')
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    conv.options = {
      projectMapSnapshot: {
        ...buildProjectMapSnapshot(tmpDir, { createdAt: '2026-05-30T05:00:00.000Z' }),
        writeBoundaries: [{
          path: path.join(tmpDir, 'src'),
          kind: 'deny',
          scope: 'directory',
          origin: 'instructions',
          reason: 'source tree is protected by project map instructions',
        }],
      },
    }
    addUserMessage(conv, `请写 ${target}`)
    const writes: string[] = []
    const dispatcher = new ToolDispatcher()
    registerNoopWrite(dispatcher, writes)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
      .mockResolvedValueOnce(textResponse('blocked'))

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 3,
    })

    expect(writes).toEqual([])
    expect(lastToolResultContent(conv)).toContain('[Project Map boundary]')
    expect(lastToolResultContent(conv)).toContain(path.join(tmpDir, 'src'))
  })

  it('project map boundaries are ignored when OWLCODA_PROJECT_MAP=0 rollback is set', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '0'
    const target = path.join(tmpDir, 'src', 'secret.ts')
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    conv.options = {
      projectMapSnapshot: {
        ...buildProjectMapSnapshot(tmpDir, { createdAt: '2026-05-30T05:10:00.000Z' }),
        writeBoundaries: [{
          path: path.join(tmpDir, 'src'),
          kind: 'deny',
          scope: 'directory',
          origin: 'instructions',
          reason: 'source tree is protected by project map instructions',
        }],
      },
    }
    addUserMessage(conv, `请写 ${target}`)
    const writes: string[] = []
    const dispatcher = new ToolDispatcher()
    registerNoopWrite(dispatcher, writes)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
      .mockResolvedValueOnce(textResponse('done'))

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 3,
    })

    expect(writes).toEqual([target])
  })

  it('project map allow boundary does not bypass an explicit provenance deny', async () => {
    process.env['OWLCODA_PROJECT_MAP'] = '1'
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const target = path.join(tmpDir, 'src', 'blocked.ts')
    const conv = createConversation({ system: 'base system', model: 'test-model' })
    conv.options = {
      projectMapSnapshot: {
        ...buildProjectMapSnapshot(tmpDir, { createdAt: '2026-05-30T05:20:00.000Z' }),
        writeBoundaries: [{
          path: path.join(tmpDir, 'src'),
          kind: 'allow',
          scope: 'directory',
          origin: 'detected',
          reason: 'source directory is a common edit surface',
        }],
      },
    }
    addUserMessage(conv, `不要改 ${target}`)
    const writes: string[] = []
    const dispatcher = new ToolDispatcher()
    registerNoopWrite(dispatcher, writes)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
      .mockResolvedValueOnce(textResponse('blocked'))

    await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 3,
    })

    expect(writes).toEqual([])
    expect(lastToolResultContent(conv)).toContain('explicitly prohibited this path')
  })
})

function registerNoopWrite(dispatcher: ToolDispatcher, writes: string[]): void {
  dispatcher.register({
    name: 'write',
    description: 'test write',
    async execute(input: Record<string, unknown>) {
      const filePath = String(input['path'] ?? '')
      writes.push(filePath)
      return { output: `wrote ${filePath}`, isError: false, metadata: { path: filePath } }
    },
  })
}

function toolUseResponse(name: string, input: Record<string, unknown>, id = 'tool-1'): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text = 'done'): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function extractSystemText(request: AnthropicMessagesRequest): string {
  const system = request.system
  if (Array.isArray(system)) {
    return system.map((block) => block.type === 'text' ? block.text : '').join('\n')
  }
  return typeof system === 'string' ? system : ''
}

function lastToolResultContent(conv: ReturnType<typeof createConversation>): string {
  const resultBlocks = conv.turns
    .flatMap((turn) => turn.content)
    .filter((block) => block.type === 'tool_result') as Array<{ content?: unknown }>
  const last = resultBlocks[resultBlocks.length - 1]
  return String(last?.content ?? '')
}

function initGit(repo: string, head: string): void {
  const refsDir = path.join(repo, '.git', 'refs', 'heads')
  fs.mkdirSync(refsDir, { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(refsDir, 'main'), `${head}\n`)
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
