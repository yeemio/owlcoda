import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import {
  FIDELITY_ANCHOR_TYPES,
  FIDELITY_COMPACTION_FACT_REASONS,
  FIDELITY_EVIDENCE_ORIGINS,
  FIDELITY_FACT_TYPES,
  recordGateEvent,
  buildPredicateComparisonEvent,
  type GateEvent,
  type GateEventKind,
} from '../../src/native/gate-telemetry.js'

// Use a temporary OWLCODA_HOME so telemetry writes don't pollute real data
let testOwlcodaHome: string
let testTelemetryDir: string

beforeEach(async () => {
  testOwlcodaHome = await mkdtemp(join(tmpdir(), 'owlcoda-gate-telemetry-test-'))
  testTelemetryDir = join(testOwlcodaHome, 'telemetry')
  process.env['OWLCODA_HOME'] = testOwlcodaHome
})

afterEach(async () => {
  delete process.env['OWLCODA_HOME']
  delete process.env['OWLCODA_PHASE_RUNTIME']
  delete process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP']
  vi.restoreAllMocks()
  await rm(testOwlcodaHome, { recursive: true, force: true })
})

describe('recordGateEvent — unit', () => {
  it('writes event as single-line JSON to the telemetry file', async () => {
    const event: GateEvent = {
      ts: 1234567890,
      kind: 'production_gate',
      conversationId: 'conv-test-123',
      iteration: 5,
      contract: {
        cwd: '/tmp/test',
        scopeMode: 'explicit_paths',
        confidence: 'high',
        allowedWritePathsByOrigin: { explicit: 2, parent_directory: 1 },
        touchedPathsCount: 0,
        scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: ['read:abc123', 'read:def456'],
      reason: 'production gate fired',
    }

    recordGateEvent(event)

    const date = new Date().toISOString().slice(0, 10)
    const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
    const contents = await readFile(filePath, 'utf8')
    const lines = contents.trim().split('\n')
    expect(lines.length).toBe(1)

    const parsed = JSON.parse(lines[0]!) as GateEvent
    expect(parsed.kind).toBe('production_gate')
    expect(parsed.conversationId).toBe('conv-test-123')
    expect(parsed.iteration).toBe(5)
    expect(parsed.contract.confidence).toBe('high')
    expect(parsed.contract.allowedWritePathsByOrigin).toEqual({ explicit: 2, parent_directory: 1 })
  })

  it('appends multiple events as separate lines', () => {
    recordGateEvent({
      ts: 1,
      kind: 'production_gate',
      conversationId: 'c1',
      iteration: 1,
      contract: {
        cwd: '/tmp', scopeMode: 'workspace', confidence: 'low',
        allowedWritePathsByOrigin: {}, touchedPathsCount: 0, scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: [],
    })
    recordGateEvent({
      ts: 2,
      kind: 'task_no_progress_suppressed',
      conversationId: 'c1',
      iteration: 9,
      contract: {
        cwd: '/tmp', scopeMode: 'explicit_paths', confidence: 'medium',
        allowedWritePathsByOrigin: { explicit: 1 }, touchedPathsCount: 0, scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: ['read:aaa'],
      reason: 'test suppressed',
    })

    const date = new Date().toISOString().slice(0, 10)
    const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
    // Read synchronously from fs
    const { readFileSync } = require('node:fs')
    const contents: string = readFileSync(filePath, 'utf8')
    const lines = contents.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).kind).toBe('production_gate')
    expect(JSON.parse(lines[1]!).kind).toBe('task_no_progress_suppressed')
  })

  it('does not throw when fs write fails', () => {
    // Point OWLCODA_HOME to a path that cannot be written (e.g. a file, not a dir)
    process.env['OWLCODA_HOME'] = '/dev/null/not-a-dir'
    expect(() => recordGateEvent({
      ts: Date.now(),
      kind: 'tool_loop',
      conversationId: 'c2',
      iteration: 3,
      contract: {
        cwd: '/tmp', scopeMode: 'workspace', confidence: 'low',
        allowedWritePathsByOrigin: {}, touchedPathsCount: 0, scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: [],
    })).not.toThrow()
  })
})

describe('gate-telemetry — Slice 2 additions', () => {
  it('GateEventKind union includes the four new kinds', () => {
    const kinds: GateEventKind[] = [
      'gate_predicate_agreement',
      'gate_predicate_disagreement',
      'abandoned_grant_hard_stop',
      'edit_now_nudge_injected',
    ]
    expect(kinds).toHaveLength(4)
  })

  describe('buildPredicateComparisonEvent', () => {
    const base = {
      ts: 1,
      conversationId: 'c',
      iteration: 2,
      contract: {
        cwd: '/', scopeMode: 'workspace' as const, confidence: 'high' as const,
        allowedWritePathsByOrigin: {}, touchedPathsCount: 0, scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: [],
    }

    it('emits disagreement tagged old_fires_new_silent when only the old predicate fires', () => {
      const e = buildPredicateComparisonEvent(true, false, base)
      expect(e.kind).toBe('gate_predicate_disagreement')
      expect(e.disagreementKind).toBe('old_fires_new_silent')
    })

    it('tags new_fires_old_silent when only the new predicate fires', () => {
      expect(buildPredicateComparisonEvent(false, true, base).disagreementKind).toBe('new_fires_old_silent')
    })

    it('emits agreement when the predicates match (the previously-missing half)', () => {
      expect(buildPredicateComparisonEvent(true, true, base).kind).toBe('gate_predicate_agreement')
      expect(buildPredicateComparisonEvent(false, false, base).kind).toBe('gate_predicate_agreement')
    })

    it('carries the shared base fields onto the event', () => {
      const e = buildPredicateComparisonEvent(false, false, base)
      expect(e.conversationId).toBe('c')
      expect(e.iteration).toBe(2)
    })
  })

  it('permits disagreement and abandoned-grant triage fields', () => {
    const event: GateEvent = {
      ts: Date.now(),
      kind: 'gate_predicate_disagreement',
      conversationId: 'c1',
      iteration: 5,
      contract: {
        cwd: '/',
        scopeMode: 'workspace',
        confidence: 'high',
        allowedWritePathsByOrigin: {},
        touchedPathsCount: 0,
        scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: [],
      disagreementKind: 'old_fires_new_silent',
      offendingTool: 'edit',
      itersSinceGrant: 5,
    }
    expect(event.disagreementKind).toBe('old_fires_new_silent')
    expect(event.offendingTool).toBe('edit')
    expect(event.itersSinceGrant).toBe(5)
  })
})

describe('gate-telemetry — write provenance additions', () => {
  it('GateEventKind union includes write provenance event kinds', () => {
    const kinds: GateEventKind[] = [
      'path_provenance_admit_evidence',
      'path_provenance_parent_admit',
      'path_provenance_block',
      'path_provenance_would_block',
      'path_provenance_bash_unparseable',
      'path_provenance_probe_override',
      'path_provenance_deny_observed',
      'path_provenance_deny_block',
      'path_provenance_deny_revoked',
      'path_provenance_deny_pattern_skipped',
    ]
    expect(kinds).toHaveLength(10)
  })

  it('writes path_provenance_deny_block with deny triage fields', async () => {
    const event: GateEvent = {
      ts: 42,
      kind: 'path_provenance_deny_block',
      conversationId: 'conv-prov',
      iteration: 3,
      contract: {
        cwd: '/tmp/prov',
        scopeMode: 'workspace',
        confidence: 'high',
        allowedWritePathsByOrigin: {},
        touchedPathsCount: 0,
        scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: ['write:abc'],
      toolName: 'Write',
      attemptedPath: 'src/locked.ts',
      canonicalPath: '/tmp/prov/src/locked.ts',
      isNewFile: false,
      ledgerSize: 2,
      targetCount: 1,
      failedCount: 1,
      denyMarker: '不要改',
      denyOriginIteration: 0,
      denyOriginalString: '不要改 src/locked.ts',
    }

    recordGateEvent(event)

    const date = new Date().toISOString().slice(0, 10)
    const parsed = JSON.parse(
      await readFile(join(testTelemetryDir, `gate-events-${date}.jsonl`), 'utf8'),
    ) as GateEvent
    expect(parsed.kind).toBe('path_provenance_deny_block')
    expect(parsed.toolName).toBe('Write')
    expect(parsed.canonicalPath).toBe('/tmp/prov/src/locked.ts')
    expect(parsed.denyMarker).toBe('不要改')
    expect(parsed.denyOriginIteration).toBe(0)
  })

  it('writes path_provenance_would_block with admission diagnostics', async () => {
    const event: GateEvent = {
      ts: 43,
      kind: 'path_provenance_would_block',
      conversationId: 'conv-prov',
      iteration: 4,
      contract: {
        cwd: '/tmp/prov',
        scopeMode: 'workspace',
        confidence: 'medium',
        allowedWritePathsByOrigin: {},
        touchedPathsCount: 0,
        scratchArtifactPathsCount: 0,
      },
      lastToolSignatures: ['write:def'],
      toolName: 'Write',
      attemptedPath: 'src/new.ts',
      canonicalPath: '/tmp/prov/src/new.ts',
      isNewFile: true,
      ledgerSize: 1,
      parentPath: '/tmp/prov/src',
      availableRecordKinds: { user_reference: 1 },
      failedCount: 1,
      targetCount: 1,
    }

    recordGateEvent(event)

    const date = new Date().toISOString().slice(0, 10)
    const parsed = JSON.parse(
      await readFile(join(testTelemetryDir, `gate-events-${date}.jsonl`), 'utf8'),
    ) as GateEvent
    expect(parsed.kind).toBe('path_provenance_would_block')
    expect(parsed.isNewFile).toBe(true)
    expect(parsed.parentPath).toBe('/tmp/prov/src')
    expect(parsed.availableRecordKinds).toEqual({ user_reference: 1 })
  })
})

describe('gate-telemetry — evidence-ledger fidelity schema', () => {
  it('exports the shared shadow schema vocabularies', () => {
    expect(FIDELITY_ANCHOR_TYPES).toEqual([
      'path',
      'filename',
      'command',
      'number',
      'commit_hash',
      'tool_target',
      'line_ref',
    ])
    expect(FIDELITY_EVIDENCE_ORIGINS).toEqual([
      'tool_call',
      'project_map',
      'instructions',
      'compaction_summary',
      'retained_turn',
      'unknown',
    ])
    expect(FIDELITY_FACT_TYPES).toContain('decision')
    expect(FIDELITY_COMPACTION_FACT_REASONS).toEqual(['dropped', 'rephrased', 'kept', 'uncertain'])
  })

  it('writes fidelity_claim_observed with evidence ledger fields', async () => {
    const event: GateEvent = {
      ts: 51,
      kind: 'fidelity_claim_observed',
      conversationId: 'conv-fidelity',
      iteration: 7,
      lastToolSignatures: ['Read:path:src/native/conversation.ts'],
      claimId: 'claim-1',
      surface: 'I analyzed src/native/conversation.ts',
      anchorType: 'path',
      target: 'src/native/conversation.ts',
      evidenceOrigin: 'tool_call',
      matched: true,
      ageTurns: 4,
      model: 'test-model',
      phase: 'final',
    }

    recordGateEvent(event)

    const date = new Date().toISOString().slice(0, 10)
    const parsed = JSON.parse(
      await readFile(join(testTelemetryDir, `gate-events-${date}.jsonl`), 'utf8'),
    ) as GateEvent
    expect(parsed.kind).toBe('fidelity_claim_observed')
    expect(parsed.anchorType).toBe('path')
    expect(parsed.evidenceOrigin).toBe('tool_call')
    expect(parsed.matched).toBe(true)
    expect(parsed.ageTurns).toBe(4)
    expect(parsed.phase).toBe('final')
  })

  it('writes fidelity_compaction_fact_observed with before/after fields', async () => {
    const event: GateEvent = {
      ts: 52,
      kind: 'fidelity_compaction_fact_observed',
      conversationId: 'conv-fidelity',
      iteration: 8,
      lastToolSignatures: [],
      factType: 'path',
      sourceTurnId: 'turn-42',
      beforeHash: 'sha256:abcdef1',
      afterMatch: false,
      preserved: false,
      reason: 'dropped',
      model: 'test-model',
      phase: 'compact',
    }

    recordGateEvent(event)

    const date = new Date().toISOString().slice(0, 10)
    const parsed = JSON.parse(
      await readFile(join(testTelemetryDir, `gate-events-${date}.jsonl`), 'utf8'),
    ) as GateEvent
    expect(parsed.kind).toBe('fidelity_compaction_fact_observed')
    expect(parsed.factType).toBe('path')
    expect(parsed.beforeHash).toBe('sha256:abcdef1')
    expect(parsed.afterMatch).toBe(false)
    expect(parsed.preserved).toBe(false)
    expect(parsed.reason).toBe('dropped')
  })
})

function toolUseResponse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
): Response {
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

describe('gate-telemetry integration — task_no_progress events', () => {
  beforeEach(() => {
    process.env['OWLCODA_AGENTIC_MODE'] = 'strict'
  })
  afterEach(() => {
    delete process.env['OWLCODA_AGENTIC_MODE']
  })

  it('confidence=medium / 9 iter / 0 touched → emits task_no_progress_suppressed event', async () => {
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // External explicit path without ALLOW phrasing → confidence=medium
    addUserMessage(conv, 'Write the deck referencing `/Users/yeemio/work/ppt/deck-stage.js`')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 9 }, (_, i) =>
        toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/ref-${i + 1}.md` })
      ),
      textResponse('Done.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    expect(result.stopReason).not.toBe('task_no_progress')

    const date = new Date().toISOString().slice(0, 10)
    const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
    const contents = await readFile(filePath, 'utf8').catch(() => '')
    const events = contents.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as GateEvent)
    const suppressed = events.filter(e => e.kind === 'task_no_progress_suppressed')
    expect(suppressed.length).toBeGreaterThan(0)
    expect(suppressed[0]!.contract.confidence).toBe('medium')
    const phase = events.filter(e => e.kind === 'phase_derived')
    expect(phase.length).toBeGreaterThan(0)
    expect(phase[0]!.phase).toBe('explore')
    expect(phase[0]!.oldGateVerdict).toBe(false)
  })

  it('confidence=high / 9 iter / 0 touched → legacy env emits task_no_progress_hard event', async () => {
    process.env['OWLCODA_TASK_NO_PROGRESS_HARD_STOP'] = '1'
    const conv = createConversation({ system: 'test', model: 'test-model' })
    // In-cwd explicit path → confidence=high
    addUserMessage(conv, 'Write the engineering contract to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'read',
      description: 'test read',
      async execute(_input: any) {
        return { output: 'file contents', isError: false }
      },
    })

    const responses = Array.from({ length: 9 }, (_, i) =>
      toolUseResponse('read', `tool-${i + 1}`, { path: `/tmp/file-${i + 1}.ts` })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    const result = await runConversationLoop(conv, dispatcher, {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test',
    })

    const date = new Date().toISOString().slice(0, 10)
    const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
    const contents = await readFile(filePath, 'utf8').catch(() => '')
    const events = contents.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as GateEvent)
    const phase = events.filter(e => e.kind === 'phase_derived')
    expect(phase.length).toBeGreaterThan(0)
    expect(phase[0]!.phase).toBe('explore')
    expect(phase[0]!.oldGateVerdict).toBe(true)
    if (process.env['OWLCODA_GATE_V2'] === '1') {
      expect(result.stopReason).not.toBe('task_no_progress')
      const disagreement = events.filter(e => e.kind === 'gate_predicate_disagreement')
      expect(disagreement.length).toBeGreaterThan(0)
      expect(disagreement[0]!.disagreementKind).toBe('old_fires_new_silent')
      return
    }
    expect(result.stopReason).toBe('task_no_progress')
    const hardStop = events.filter(e => e.kind === 'task_no_progress_hard')
    expect(hardStop.length).toBeGreaterThan(0)
    expect(hardStop[0]!.contract.confidence).toBe('high')
  })

  it('OWLCODA_PHASE_RUNTIME=1: verification evidence suppresses old no-progress hard-stop', async () => {
    process.env['OWLCODA_PHASE_RUNTIME'] = '1'
    const originalGateV2 = process.env['OWLCODA_GATE_V2']
    process.env['OWLCODA_GATE_V2'] = '0'

    const conv = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conv, 'Write the engineering contract to docs/intake.md')

    const dispatcher = new ToolDispatcher()
    dispatcher.register({
      name: 'DeliveryAudit',
      description: 'test delivery audit',
      async execute(_input: any) {
        return { output: 'DeliveryAudit: clean', isError: false }
      },
    })

    const responses = [
      ...Array.from({ length: 12 }, (_, i) =>
        toolUseResponse('DeliveryAudit', `audit-${i + 1}`, { claims: [`checked docs/intake.md pass ${i + 1}`] })
      ),
      textResponse('Done. DeliveryAudit clean.'),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!)

    try {
      const result = await runConversationLoop(conv, dispatcher, {
        apiBaseUrl: 'http://localhost:0',
        apiKey: 'test',
      })

      expect(result.stopReason).not.toBe('task_no_progress')

      const date = new Date().toISOString().slice(0, 10)
      const filePath = join(testTelemetryDir, `gate-events-${date}.jsonl`)
      const contents = await readFile(filePath, 'utf8').catch(() => '')
      const events = contents.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as GateEvent)
      const phase = events.filter(e => e.kind === 'phase_derived')
      expect(phase.length).toBeGreaterThan(0)
      expect(phase[0]!).toEqual(expect.objectContaining({
        phase: 'verify',
        phaseConfidence: 'high',
        oldGateVerdict: true,
        phaseGateVerdict: false,
        phaseRuntimeEnabled: true,
      }))
      const suppressed = events.filter(e => e.kind === 'task_no_progress_suppressed')
      expect(suppressed.length).toBeGreaterThan(0)
      expect(suppressed[0]!.reason).toContain('phase=verify has evidence')
    } finally {
      if (originalGateV2 === undefined) delete process.env['OWLCODA_GATE_V2']
      else process.env['OWLCODA_GATE_V2'] = originalGateV2
    }
  })
})
