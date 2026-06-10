import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import type { GateEvent } from '../../src/native/gate-telemetry.js'

// Verifies the dispatch loop gate stack composition (spec §4.2 ordering):
//
//   1. evaluateIntentGuard          — analysis intent / probe consent
//   2. evaluateWriteTargetProvenance — this slice's gate
//   3. evaluateWriteGuard           — touched-path task scope
//   4. GATE_V2 abandoned-grant      — when OWLCODA_GATE_V2=1
//   5. (future) phase intervention  — when OWLCODA_PHASE_RUNTIME=1
//
// Each earlier gate must short-circuit the later ones — no provenance
// telemetry fires when IntentGuard already blocked the call, etc.

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
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text = 'Done.'): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function registerNoopWrite(dispatcher: ToolDispatcher, writes: string[]): void {
  dispatcher.register({
    name: 'write',
    description: 'test write',
    async execute(input: Record<string, unknown>) {
      const path = String(input['path'] ?? '')
      writes.push(path)
      return { output: `wrote ${path}`, isError: false, metadata: { path } }
    },
  })
}

beforeEach(() => {
  process.env['OWLCODA_MODES'] = '0'
})

afterEach(() => {
  delete process.env['OWLCODA_MODES']
  delete process.env['OWLCODA_HOME']
  delete process.env['OWLCODA_GATE_PROVENANCE']
  delete process.env['OWLCODA_GATE_V2']
  vi.restoreAllMocks()
})

describe('conversation dispatch loop — gate stack ordering (IG1-IG6, S2-5)', () => {
  it('IG1: IntentGuard pre-empts the provenance gate (analysis intent → no PROV event)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-stack-ig1-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-stack-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Analysis-only intent — IntentGuard short-circuits BEFORE provenance.
      addUserMessage(conv, '看一下这个文件')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'declared.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Tool blocked, no execution.
      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      // No provenance events for this attempt — IntentGuard short-circuited.
      const provEvents = events.filter(e => String(e.kind).startsWith('path_provenance_'))
      expect(provEvents).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('IG2: provenance block pre-empts WriteGuard (no touched path mutation)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-stack-ig2-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-stack-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      // Implementation intent (passes IntentGuard) but no path mention →
      // provenance fails for the invented target.
      addUserMessage(conv, '请写出结果')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'invented.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      expect(writes).toEqual([])
      const events = await readGateEvents(home)
      // Provenance fired (and blocked) ...
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
        canonicalPath: target,
      }))
      // ... and WriteGuard's scope-block telemetry did NOT fire for this
      // call (the tool never reached WriteGuard).
      const writeGuardBlocks = events.filter(e => e.kind === 'write_scope_block')
      expect(writeGuardBlocks).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('IG3: all pass → tool executes and tool-result feeds the ledger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-stack-ig3-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-stack-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'src', 'allowed.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `请写 ${target}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Tool ran (user declared the target).
      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      // Admit evidence fired before execution.
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_admit_evidence',
        canonicalPath: target,
        via: 'user_declared_target',
      }))
      // No block events of any kind.
      const blockEvents = events.filter(e =>
        String(e.kind) === 'path_provenance_block' ||
        String(e.kind) === 'path_provenance_deny_block'
      )
      expect(blockEvents).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('IG5: flag-off shadow mode lets the tool run and emits would-block telemetry', async () => {
    // Spec §10.1: unset / 0 / off → shadow mode. Tool executes.
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-stack-ig5-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-stack-home-'))
    process.env['OWLCODA_HOME'] = home
    // OWLCODA_GATE_PROVENANCE intentionally NOT set.
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, '请写出结果')
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      const target = join(canonicalCwd, 'src', 'shadow.ts')
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Tool ran (shadow mode never blocks).
      expect(writes).toEqual([target])
      const events = await readGateEvents(home)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'path_provenance_would_block',
        canonicalPath: target,
      }))
      // And no path_provenance_block in shadow mode.
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: 'path_provenance_block',
      }))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('IG6: enabling both GATE_V2 and provenance does not regress provenance behavior', async () => {
    // Smoke test: with both flags on, a user-declared write still passes
    // through the provenance gate (admit_evidence emitted) regardless of
    // what GATE_V2 decides. This proves the gates compose without one
    // smothering the other.
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-stack-ig6-'))
    const home = await mkdtemp(join(tmpdir(), 'owlcoda-stack-home-'))
    process.env['OWLCODA_HOME'] = home
    process.env['OWLCODA_GATE_PROVENANCE'] = '1'
    process.env['OWLCODA_GATE_V2'] = '1'
    const writes: string[] = []
    try {
      const canonicalCwd = await realpath(cwd)
      const target = join(canonicalCwd, 'src', 'gate-v2-allowed.ts')
      const conv = createConversation({ system: 'test', model: 'test-model' })
      addUserMessage(conv, `请写 ${target}`)
      const dispatcher = new ToolDispatcher()
      registerNoopWrite(dispatcher, writes)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(toolUseResponse('write', { path: target, content: 'x' }))
        .mockResolvedValueOnce(textResponse())

      await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0', apiKey: 'test-key', cwd: canonicalCwd, maxIterations: 3,
      })

      // Provenance fired admit_evidence regardless of GATE_V2 state.
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
