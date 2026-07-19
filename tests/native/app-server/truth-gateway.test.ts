import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readRunKitTruth } from '../../../src/native/app-server/truth-gateway.js'
import { readRuntimeRail } from '../../../src/native/app-server/runtime-rail-service.js'

describe('truth-gateway read adapter', () => {
  it('returns missing when project has no RunKit truth directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owlcoda-no-runkit-'))

    const truth = await readRunKitTruth(root)

    expect(truth.freshness).toBe('missing')
    expect(truth.packet).toBeNull()
    expect(truth.gate).toBeNull()
  })

  it('reads the latest ProjectTruthPacket and governance gate readback', async () => {
    const root = await createRunKitProjectFixture()

    const truth = await readRunKitTruth(root)

    expect(truth.freshness).toBe('fresh')
    expect(truth.packet).toMatchObject({
      schemaVersion: '1.0',
      project: 'OwlRunKit',
      subjectId: 'owlrunkit',
      truthFingerprint: 'abc123',
      packetRef: '.owlrunkit/agent-inbox/thread-a.packet.json',
      generatedBy: 'runkit-agent-hook',
    })
    expect(truth.claim).toMatchObject({
      agent: 'Codex',
      goalId: 'G112',
      status: 'active',
      cwd: root,
      sourceRef: '.owlrunkit/session-claims/thread-a.json',
    })
    expect(truth.gate).toMatchObject({
      sequenceId: 'coding-init',
      currentGate: 'confirm-flow',
      passedGates: ['confirm-architecture'],
      awaitingHuman: true,
      sourceRef: '.owlrunkit/state/governance-gate.json',
      readbackSourceRef: '.owlrunkit/state/governance-gate.json',
    })
    expect(truth.rejectedPaths).toEqual([{
      decisionId: 'D20260601-009',
      path: 'Do not make RunKit an agent memory database',
      sourceRef: '.owlrunkit/decisions/D20260601-009.md',
    }])
    expect(truth.nextAction).toBe('Generate packet before UI expansion.')
  })

  it('does not map legacy truth packets into the OwlCoda RunKit contextual rail', async () => {
    const root = await createRunKitProjectFixture()

    const rail = await readRuntimeRail({ projectId: 'owlrunkit', projectRoot: root })

    expect(rail).toEqual({
      projectId: 'owlrunkit',
      freshness: 'missing',
      summary: null,
      executionHistory: [],
      source: 'not_connected',
    })
  })
})

async function createRunKitProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'owlcoda-runkit-truth-'))
  mkdirSync(join(root, '.owlrunkit', 'agent-inbox'), { recursive: true })
  mkdirSync(join(root, '.owlrunkit', 'state'), { recursive: true })

  writeFileSync(join(root, '.owlrunkit', 'agent-inbox', 'thread-a.packet.json'), JSON.stringify({
    schema_version: '1.0',
    generated_at: '2026-06-01T13:40:00Z',
    generated_by: 'runkit-agent-hook',
    project: 'OwlRunKit',
    subject_id: 'owlrunkit',
    truth_fingerprint: 'abc123',
    claim: {
      agent: 'Codex',
      goal_id: 'G112',
      status: 'active',
      handling: ['Build packet'],
      handling_source: 'explicit',
      cwd: root,
      source_ref: '.owlrunkit/session-claims/thread-a.json',
    },
    state: {
      source_ref: '.owlrunkit/state/checkpoint.json',
      current_phase: 'g112',
      current_goal_id: 'G112-project-owned-truth-sync-layer',
      current_stage: 'Project Truth Packet',
      next_action: 'Generate packet before UI expansion.',
      blockers: ['gate writeback deferred'],
      truth_refs: ['.owlrunkit/decisions/D20260601-009.md'],
    },
    decisions: {
      confirmed: [],
      candidates: [],
    },
    rejected_paths: [{
      decision_id: 'D20260601-009',
      path: 'Do not make RunKit an agent memory database',
      source_ref: '.owlrunkit/decisions/D20260601-009.md',
    }],
    proofs: [{
      kind: 'verification',
      title: 'Desktop smoke passed',
      status: 'passed',
      source_ref: '.owlrunkit/proofs/desktop-smoke.md',
      at: '2026-06-01T13:42:00Z',
    }],
    gate: {
      sequence_id: 'coding-init',
      current_gate: 'confirm-flow',
      passed_gates: ['confirm-architecture'],
      awaiting_human: true,
      source_ref: '.owlrunkit/state/governance-gate.json',
    },
    next_action: {
      summary: 'Generate packet before UI expansion.',
      who_can_unblock: 'agent',
      source_ref: '.owlrunkit/state/checkpoint.json',
    },
    provenance: {
      truth_refs: [
        '.owlrunkit/state/checkpoint.json',
        '.owlrunkit/decisions/D20260601-009.md',
      ],
      proof_refs: [
        '.owlrunkit/proofs/desktop-smoke.md',
      ],
    },
    volatile: {
      thread_id: 'thread-a',
      reader_agent: 'Codex',
      packet_ref: '.owlrunkit/agent-inbox/thread-a.packet.json',
      generated_at: '2026-06-01T13:40:00Z',
    },
  }), 'utf8')

  writeFileSync(join(root, '.owlrunkit', 'state', 'governance-gate.json'), JSON.stringify({
    schema_version: '1.1',
    sequence_id: 'coding-init',
    gates: [
      { id: 'confirm-architecture', prompt: '确认架构真源已讲清' },
      { id: 'confirm-flow', prompt: '确认流程真源已讲清' },
    ],
    current_gate: 'confirm-flow',
    passed_gates: ['confirm-architecture'],
    awaiting_human: true,
    confirmations: [{
      gate_id: 'confirm-architecture',
      confirmed_by: 'Claude',
      note: '架构真源已讲清',
      confirmed_at: '2026-06-01T00:00:00Z',
      source_ref: '.owlrunkit/state/governance-gate.json',
    }],
  }), 'utf8')

  return root
}
