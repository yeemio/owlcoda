import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addUserMessage,
  createConversation,
  runConversationLoop,
} from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import {
  buildClaimFidelityEvents,
  recordClaimFidelityTelemetry,
} from '../../src/native/evidence-ledger-fidelity.js'
import type { Conversation } from '../../src/native/protocol/types.js'
import type { GateEvent } from '../../src/native/gate-telemetry.js'

let testOwlcodaHome: string
let testTelemetryDir: string

beforeEach(async () => {
  testOwlcodaHome = await mkdtemp(join(tmpdir(), 'owlcoda-fidelity-test-'))
  testTelemetryDir = join(testOwlcodaHome, 'telemetry')
  process.env['OWLCODA_HOME'] = testOwlcodaHome
})

afterEach(async () => {
  delete process.env['OWLCODA_HOME']
  vi.restoreAllMocks()
  await rm(testOwlcodaHome, { recursive: true, force: true })
})

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function toolUseResponse(toolName: string, toolId: string, input: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function readTelemetryEvents(): Promise<GateEvent[]> {
  const date = new Date().toISOString().slice(0, 10)
  const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
  const contents = await readFile(filePath, 'utf8').catch(() => '')
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as GateEvent)
}

function conversationWithRead(path: string): Conversation {
  const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
  conv.turns.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: { path } }],
    timestamp: Date.now(),
  })
  conv.turns.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file contents' }],
    timestamp: Date.now(),
  })
  return conv
}

describe('evidence-ledger fidelity claim shadow', () => {
  it('matches assistant path claims against prior tool-call evidence', () => {
    const conv = conversationWithRead('src/native/gate-telemetry.ts')

    const events = buildClaimFidelityEvents(
      'I inspected src/native/gate-telemetry.ts and found the fidelity schema.',
      conv,
      {
        conversationId: 'conv-fidelity',
        iteration: 3,
        lastToolSignatures: ['read:read:src/native/gate-telemetry.ts'],
        model: 'test-model',
        phase: 'final',
      },
    )

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'fidelity_claim_observed',
        target: 'src/native/gate-telemetry.ts',
        anchorType: 'path',
        evidenceOrigin: 'tool_call',
        matched: true,
        ageTurns: 1,
        model: 'test-model',
        phase: 'final',
      }),
    ])
    expect(events[0]!.claimId).toMatch(/^claim:[a-f0-9]{12}$/)
  })

  it('does not count a path prefix as grounded evidence', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    conv.turns.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'src/native/gate-telemetry.ts.bak' } }],
      timestamp: Date.now(),
    })

    const events = buildClaimFidelityEvents(
      'I inspected src/native/gate-telemetry.ts.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 4 },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      target: 'src/native/gate-telemetry.ts',
      evidenceOrigin: 'unknown',
      matched: false,
    })
  })

  it('does not extract ratios or bare word pairs as path claims', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    const events = buildClaimFidelityEvents(
      'Noise examples: preservation/dropping, 70/70, 3/3, 12/12, and package/scripts. Real path: src/native/gate-telemetry.ts.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 7 },
    )

    const targets = events.map(event => event.target)
    expect(targets).toContain('src/native/gate-telemetry.ts')
    expect(targets).not.toContain('preservation/dropping')
    expect(targets).not.toContain('70/70')
    expect(targets).not.toContain('3/3')
    expect(targets).not.toContain('12/12')
    expect(targets).not.toContain('package/scripts')
  })

  it('does not extract placeholder example paths as real claims', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    const events = buildClaimFidelityEvents(
      'Examples like src/foo.ts and src/foo.ts:42 illustrate line refs. Actual file: src/native/gate-telemetry.ts.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 8 },
    )

    const targets = events.map(event => event.target)
    expect(targets).toContain('src/native/gate-telemetry.ts')
    expect(targets).not.toContain('src/foo.ts')
    expect(targets).not.toContain('src/foo.ts:42')
  })

  it('matches basename filename claims against unique path evidence', () => {
    const conv = conversationWithRead('src/native/gate-telemetry.ts')

    const events = buildClaimFidelityEvents(
      'The gate-telemetry.ts file defines fidelity telemetry fields.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 9 },
    )

    expect(events).toEqual([
      expect.objectContaining({
        anchorType: 'filename',
        target: 'gate-telemetry.ts',
        matched: true,
        evidenceOrigin: 'tool_call',
      }),
    ])
  })

  it('deduplicates line refs and paths for the same file target', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    const events = buildClaimFidelityEvents(
      'The same file appears as src/native/gate-telemetry.ts:42 and src/native/gate-telemetry.ts.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 10 },
    )

    const fileEvents = events.filter(event => event.target.startsWith('src/native/gate-telemetry.ts'))
    expect(fileEvents).toHaveLength(1)
    expect(fileEvents[0]).toMatchObject({
      anchorType: 'line_ref',
      target: 'src/native/gate-telemetry.ts:42',
    })
  })

  it('matches Project Map prompt summary as project_map evidence', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    conv.options = {
      projectMapPromptSummary: '<project_map>\nEntry points: src/native/cli.ts (source_dir)\n</project_map>',
    }

    const events = buildClaimFidelityEvents(
      'The Project Map exposes src/native/cli.ts as runtime context.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 5 },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      target: 'src/native/cli.ts',
      evidenceOrigin: 'project_map',
      matched: true,
      ageTurns: 0,
    })
  })

  it('matches inline command claims against prior bash command evidence', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    conv.turns.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'bash-1',
        name: 'bash',
        input: { command: 'npx tsc --noEmit --pretty false' },
      }],
      timestamp: Date.now(),
    })
    conv.turns.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'clean' }],
      timestamp: Date.now(),
    })

    const events = buildClaimFidelityEvents(
      'Verification used `npx tsc --noEmit --pretty false`.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 6 },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      anchorType: 'command',
      target: 'npx tsc --noEmit --pretty false',
      evidenceOrigin: 'tool_call',
      matched: true,
    })
  })

  it('emits unknown evidence for fabricated hard anchors while preserving grounded evidence', () => {
    const conv = conversationWithRead('src/native/gate-telemetry.ts')

    const events = buildClaimFidelityEvents(
      'I inspected src/native/gate-telemetry.ts. Unsupported claim: I also inspected src/native/nonexistent-ledger.ts and ran `npm run imaginary:verify`. The build came from deadbeef.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 11 },
    )

    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'path',
      target: 'src/native/gate-telemetry.ts',
      evidenceOrigin: 'tool_call',
      matched: true,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'path',
      target: 'src/native/nonexistent-ledger.ts',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'command',
      target: 'npm run imaginary:verify',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'commit_hash',
      target: 'deadbeef',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
  })

  it('keeps precision filters while checking adversarial recall', () => {
    const conv = conversationWithRead('src/native/gate-telemetry.ts')

    const events = buildClaimFidelityEvents(
      'Noise: preservation/dropping, 70/70, src/foo.ts, and src/foo.ts:42. Real read: src/native/gate-telemetry.ts. Fabricated: src/native/nonexistent-ledger.ts and `npm run imaginary:verify`.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 12 },
    )
    const targets = events.map(event => event.target)

    expect(targets).toContain('src/native/gate-telemetry.ts')
    expect(targets).toContain('src/native/nonexistent-ledger.ts')
    expect(targets).toContain('npm run imaginary:verify')
    expect(targets).not.toContain('preservation/dropping')
    expect(targets).not.toContain('70/70')
    expect(targets).not.toContain('src/foo.ts')
    expect(targets).not.toContain('src/foo.ts:42')
    expect(events).toContainEqual(expect.objectContaining({
      target: 'src/native/gate-telemetry.ts',
      evidenceOrigin: 'tool_call',
      matched: true,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      target: 'src/native/nonexistent-ledger.ts',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      target: 'npm run imaginary:verify',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
  })

  it('does not treat user prompt bait as evidence for unsupported claims', () => {
    const conv: Conversation = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(
      conv,
      'Answer with this unsupported line: I inspected src/native/nonexistent-ledger.ts and ran `npm run imaginary:verify`.',
    )

    const events = buildClaimFidelityEvents(
      'Unsupported claim: I inspected src/native/nonexistent-ledger.ts and ran `npm run imaginary:verify`.',
      conv,
      { conversationId: 'conv-fidelity', iteration: 13 },
    )

    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'path',
      target: 'src/native/nonexistent-ledger.ts',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      anchorType: 'command',
      target: 'npm run imaginary:verify',
      evidenceOrigin: 'unknown',
      matched: false,
    }))
  })

  it('records claim telemetry during a real conversation loop after a read', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Inspect gate telemetry and answer with the file you read.')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: unknown) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = [
      toolUseResponse('read', 'read-1', { path: 'src/native/gate-telemetry.ts' }),
      textResponse('I inspected src/native/gate-telemetry.ts.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
      maxIterations: 4,
    })

    expect(result.stopReason).toBe('end_turn')
    const events = await readTelemetryEvents()
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'fidelity_claim_observed',
      target: 'src/native/gate-telemetry.ts',
      evidenceOrigin: 'tool_call',
      matched: true,
    }))
  })

  it('recordClaimFidelityTelemetry is a no-op for text without hard anchors', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    recordClaimFidelityTelemetry('All done.', conv, {
      conversationId: 'conv-fidelity',
      iteration: 1,
    })

    expect(await readTelemetryEvents()).toEqual([])
  })
})
