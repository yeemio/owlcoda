import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

export interface RunKitProofAppendInput {
  projectRoot: string
  kind: string
  title: string
  status?: string
  detail?: string
  at?: string
}

export interface RunKitProofAppendResult {
  status: 'appended'
  proof: RunKitTruthProofSummary
  proofPath: string
  packetPath: string
  readback: RunKitTruthState
}

export interface RunKitGateConfirmInput {
  projectRoot: string
  gateId?: string
  note?: string
  confirmedBy?: string
  confirmedAt?: string
}

export interface RunKitGateConfirmResult {
  status: 'confirmed'
  gateId: string
  gatePath: string
  readback: RunKitTruthState
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

export function appendRunKitProof(input: RunKitProofAppendInput): RunKitProofAppendResult {
  const root = resolve(input.projectRoot)
  const truth = readRunKitTruth(root)
  if (truth.freshness !== 'fresh' || !truth.packetPath) {
    throw new Error('RunKit truth packet is required before appending proof')
  }
  const at = input.at ?? new Date().toISOString()
  const proofId = `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const sourceRef = `.owlrunkit/proofs/${proofId}.json`
  const proofPath = join(root, sourceRef)
  mkdirSync(join(root, '.owlrunkit', 'proofs'), { recursive: true })
  const proofRecord = {
    schema_version: '1.0',
    id: proofId,
    kind: input.kind,
    title: input.title,
    status: input.status ?? 'recorded',
    source_ref: sourceRef,
    at,
    ...(input.detail ? { detail: input.detail } : {}),
  }
  writeFileSync(proofPath, JSON.stringify(proofRecord, null, 2), 'utf8')

  const packet = readJsonObject(truth.packetPath)
  const proofs = Array.isArray(packet['proofs']) ? [...packet['proofs']] : []
  proofs.push(proofRecord)
  packet['proofs'] = proofs
  const provenance = recordField(packet, 'provenance') ?? {}
  const proofRefs = stringArrayField(provenance, 'proof_refs')
  if (!proofRefs.includes(sourceRef)) proofRefs.push(sourceRef)
  provenance['proof_refs'] = proofRefs
  packet['provenance'] = provenance
  writeFileSync(truth.packetPath, JSON.stringify(packet, null, 2), 'utf8')

  const readback = readRunKitTruth(root)
  const proof = readback.proofs.find(item => item.sourceRef === sourceRef) ?? {
    kind: input.kind,
    title: input.title,
    status: input.status ?? 'recorded',
    sourceRef,
    at,
  }
  return {
    status: 'appended',
    proof,
    proofPath,
    packetPath: truth.packetPath,
    readback,
  }
}

export function confirmRunKitGate(input: RunKitGateConfirmInput): RunKitGateConfirmResult {
  const root = resolve(input.projectRoot)
  const truth = readRunKitTruth(root)
  if (truth.freshness !== 'fresh') {
    throw new Error('RunKit truth packet is required before confirming a gate')
  }
  const gatePath = truth.gatePath ?? join(root, '.owlrunkit', 'state', 'governance-gate.json')
  if (!existsSync(gatePath)) {
    throw new Error('RunKit governance gate file is required before confirming a gate')
  }
  const gate = readJsonObject(gatePath)
  const gateId = input.gateId ?? stringField(gate, 'current_gate')
  if (!gateId) throw new Error('gateId is required')
  const passedGates = stringArrayField(gate, 'passed_gates')
  if (!passedGates.includes(gateId)) passedGates.push(gateId)

  const gates = Array.isArray(gate['gates'])
    ? gate['gates'].filter(isRecord)
    : []
  const currentIndex = gates.findIndex(item => stringField(item, 'id') === gateId)
  const nextGate = currentIndex >= 0
    ? gates.slice(currentIndex + 1).find(item => {
        const id = stringField(item, 'id')
        return id ? !passedGates.includes(id) : false
      })
    : null
  const nextGateId = nextGate ? stringField(nextGate, 'id') : null
  const confirmations = Array.isArray(gate['confirmations']) ? [...gate['confirmations']] : []
  confirmations.push({
    gate_id: gateId,
    confirmed_by: input.confirmedBy ?? 'OwlCoda Desktop',
    note: input.note ?? '',
    confirmed_at: input.confirmedAt ?? new Date().toISOString(),
    source_ref: '.owlrunkit/state/governance-gate.json',
  })
  gate['passed_gates'] = passedGates
  gate['current_gate'] = nextGateId
  gate['awaiting_human'] = Boolean(nextGateId)
  gate['confirmations'] = confirmations
  writeFileSync(gatePath, JSON.stringify(gate, null, 2), 'utf8')

  const readback = readRunKitTruth(root)
  if (!readback.gate?.passedGates.includes(gateId)) {
    throw new Error('RunKit gate readback did not include confirmed gate')
  }
  return {
    status: 'confirmed',
    gateId,
    gatePath,
    readback,
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
