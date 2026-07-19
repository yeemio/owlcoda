import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type RunKitTruthFreshness = 'missing' | 'fresh' | 'error'

export interface RunKitTruthPacketSummary {
  schemaVersion: string | null
  project: string | null
  subjectId: string | null
  truthFingerprint: string | null
  generatedAt: string | null
  generatedBy: string | null
  packetRef: string
}

export interface RunKitTruthClaimSummary {
  agent: string | null
  goalId: string | null
  status: string | null
  handling: string[]
  handlingSource: string | null
  cwd: string | null
  sourceRef: string | null
}

export interface RunKitTruthGateSummary {
  sequenceId: string | null
  currentGate: string | null
  passedGates: string[]
  awaitingHuman: boolean | null
  sourceRef: string | null
  readbackSourceRef: string | null
}

export interface RunKitTruthRejectedPath {
  decisionId: string | null
  path: string
  sourceRef: string | null
}

export interface RunKitTruthProofSummary {
  kind: string | null
  title: string | null
  status: string | null
  sourceRef: string | null
  at: string | null
}

export interface RunKitTruthState {
  freshness: RunKitTruthFreshness
  packet: RunKitTruthPacketSummary | null
  claim: RunKitTruthClaimSummary | null
  gate: RunKitTruthGateSummary | null
  proofs: RunKitTruthProofSummary[]
  rejectedPaths: RunKitTruthRejectedPath[]
  nextAction: string | null
  packetPath: string | null
  gatePath: string | null
  error: string | null
}

export function readRunKitTruth(projectRoot: string): RunKitTruthState {
  const root = resolve(projectRoot)
  const runkitRoot = join(root, '.owlrunkit')
  if (!existsSync(runkitRoot)) return missingTruth()

  const packetPath = findLatestPacketPath(root)
  if (!packetPath) return missingTruth()

  try {
    const packetRaw = readJsonObject(packetPath)
    const gatePath = join(root, '.owlrunkit', 'state', 'governance-gate.json')
    const gateRaw = existsSync(gatePath) ? readJsonObject(gatePath) : null
    return {
      freshness: 'fresh',
      packet: summarizePacket(packetRaw),
      claim: summarizeClaim(packetRaw['claim']),
      gate: summarizeGate(packetRaw['gate'], gateRaw),
      proofs: summarizeProofs(packetRaw),
      rejectedPaths: summarizeRejectedPaths(packetRaw['rejected_paths']),
      nextAction: stringField(recordField(packetRaw, 'next_action'), 'summary')
        ?? stringField(recordField(packetRaw, 'state'), 'next_action'),
      packetPath,
      gatePath: existsSync(gatePath) ? gatePath : null,
      error: null,
    }
  } catch (error) {
    return {
      ...missingTruth(),
      freshness: 'error',
      packetPath,
      error: error instanceof Error ? error.message : 'Failed to read RunKit truth',
    }
  }
}

function missingTruth(): RunKitTruthState {
  return {
    freshness: 'missing',
    packet: null,
    claim: null,
    gate: null,
    proofs: [],
    rejectedPaths: [],
    nextAction: null,
    packetPath: null,
    gatePath: null,
    error: null,
  }
}

function findLatestPacketPath(root: string): string | null {
  const inbox = join(root, '.owlrunkit', 'agent-inbox')
  if (!existsSync(inbox)) return null
  const packets = readdirSync(inbox)
    .filter(name => name.endsWith('.packet.json'))
    .map(name => join(inbox, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return packets[0] ?? null
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) throw new Error(`RunKit truth file is not an object: ${path}`)
  return parsed
}

function summarizePacket(packet: Record<string, unknown>): RunKitTruthPacketSummary {
  const volatile = recordField(packet, 'volatile')
  return {
    schemaVersion: stringField(packet, 'schema_version'),
    project: stringField(packet, 'project'),
    subjectId: stringField(packet, 'subject_id'),
    truthFingerprint: stringField(packet, 'truth_fingerprint'),
    generatedAt: stringField(packet, 'generated_at'),
    generatedBy: stringField(packet, 'generated_by'),
    packetRef: stringField(volatile, 'packet_ref') ?? '',
  }
}

function summarizeClaim(raw: unknown): RunKitTruthClaimSummary | null {
  if (!isRecord(raw)) return null
  return {
    agent: stringField(raw, 'agent'),
    goalId: stringField(raw, 'goal_id'),
    status: stringField(raw, 'status'),
    handling: stringArrayField(raw, 'handling'),
    handlingSource: stringField(raw, 'handling_source'),
    cwd: stringField(raw, 'cwd'),
    sourceRef: stringField(raw, 'source_ref'),
  }
}

function summarizeGate(packetGate: unknown, readbackGate: Record<string, unknown> | null): RunKitTruthGateSummary | null {
  if (!isRecord(packetGate) && !readbackGate) return null
  const packet = isRecord(packetGate) ? packetGate : {}
  const source = readbackGate ?? packet
  return {
    sequenceId: stringField(source, 'sequence_id') ?? stringField(packet, 'sequence_id'),
    currentGate: readbackGate ? stringField(readbackGate, 'current_gate') : stringField(packet, 'current_gate'),
    passedGates: stringArrayField(source, 'passed_gates').length > 0
      ? stringArrayField(source, 'passed_gates')
      : stringArrayField(packet, 'passed_gates'),
    awaitingHuman: booleanField(source, 'awaiting_human') ?? booleanField(packet, 'awaiting_human'),
    sourceRef: stringField(packet, 'source_ref'),
    readbackSourceRef: readbackGate ? '.owlrunkit/state/governance-gate.json' : null,
  }
}

function summarizeRejectedPaths(raw: unknown): RunKitTruthRejectedPath[] {
  if (!Array.isArray(raw)) return []
  const out: RunKitTruthRejectedPath[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const path = stringField(item, 'path')
    if (!path) continue
    out.push({
      decisionId: stringField(item, 'decision_id'),
      path,
      sourceRef: stringField(item, 'source_ref'),
    })
  }
  return out
}

function summarizeProofs(packet: Record<string, unknown>): RunKitTruthProofSummary[] {
  const out: RunKitTruthProofSummary[] = []
  const rawProofs = packet['proofs']
  if (Array.isArray(rawProofs)) {
    for (const item of rawProofs) {
      if (!isRecord(item)) continue
      const sourceRef = stringField(item, 'source_ref') ?? stringField(item, 'sourceRef')
      const title = stringField(item, 'title') ?? stringField(item, 'summary') ?? sourceRef
      if (!title && !sourceRef) continue
      out.push({
        kind: stringField(item, 'kind'),
        title,
        status: stringField(item, 'status'),
        sourceRef,
        at: stringField(item, 'at') ?? stringField(item, 'created_at') ?? stringField(item, 'generated_at'),
      })
    }
  }

  const provenance = recordField(packet, 'provenance')
  for (const sourceRef of stringArrayField(provenance ?? {}, 'proof_refs')) {
    if (out.some(proof => proof.sourceRef === sourceRef)) continue
    out.push({
      kind: 'proof_ref',
      title: sourceRef,
      status: null,
      sourceRef,
      at: null,
    })
  }
  return out
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  return isRecord(value) ? value : null
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function booleanField(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
