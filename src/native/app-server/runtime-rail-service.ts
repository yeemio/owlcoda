import { readRunKitTruth, type RunKitTruthClaimSummary, type RunKitTruthGateSummary, type RunKitTruthPacketSummary, type RunKitTruthProofSummary, type RunKitTruthRejectedPath } from './truth-gateway.js'

export type RunKitRailFreshness = 'missing' | 'fresh' | 'error'

export interface RuntimeRailReadInput {
  projectId: string
  projectRoot?: string
}

export interface RunKitRailState {
  projectId: string
  freshness: RunKitRailFreshness
  packet: RunKitTruthPacketSummary | null
  gate: RunKitTruthGateSummary | null
  claim: RunKitTruthClaimSummary | null
  proofs: RunKitTruthProofSummary[]
  rejectedPaths: RunKitTruthRejectedPath[]
  nextAction: string | null
  source: 'not_connected' | 'project_truth_packet' | 'project_truth_error'
  error?: string | null
}

export async function readRuntimeRail(input: string | RuntimeRailReadInput): Promise<RunKitRailState> {
  const projectId = typeof input === 'string' ? input : input.projectId
  const projectRoot = typeof input === 'string' ? undefined : input.projectRoot
  if (!projectRoot) return missingRail(projectId)

  const truth = readRunKitTruth(projectRoot)
  if (truth.freshness === 'missing') return missingRail(projectId)
  if (truth.freshness === 'error') {
    return {
      ...missingRail(projectId),
      freshness: 'error',
      source: 'project_truth_error',
      error: truth.error,
    }
  }

  return {
    projectId,
    freshness: 'fresh',
    packet: truth.packet,
    gate: truth.gate,
    claim: truth.claim,
    proofs: truth.proofs,
    rejectedPaths: truth.rejectedPaths,
    nextAction: truth.nextAction,
    source: 'project_truth_packet',
  }
}

function missingRail(projectId: string): RunKitRailState {
  return {
    projectId,
    freshness: 'missing',
    packet: null,
    gate: null,
    claim: null,
    proofs: [],
    rejectedPaths: [],
    nextAction: null,
    source: 'not_connected',
  }
}
