import type {
  AppServerRuntimeFactsReadResult,
  AppServerRuntimeScorecardReadResult,
} from './protocol-contract.js'
import type { RunKitRailState } from './runtime-rail-service.js'
import type { ScorecardVerdict, AntiCheatStatus } from '../scorecard.js'

export type DesktopRuntimeFactsDrilldownScorecardStatus = 'ready' | 'unavailable' | 'missing'

export interface DesktopRuntimeFactsDrilldownInput {
  facts: AppServerRuntimeFactsReadResult
  scorecard?: AppServerRuntimeScorecardReadResult | null
  scorecardError?: string
  rail?: RunKitRailState | null
}

export interface DesktopRuntimeFactsDrilldown {
  surface: 'desktop-runtime-facts-drilldown'
  runId: string
  scorecardStatus: DesktopRuntimeFactsDrilldownScorecardStatus
  scorecard: DesktopRuntimeFactsScorecardSummary | null
  summary: DesktopRuntimeFactsDrilldownSummary
  entities: DesktopRuntimeFactsDrilldownEntities
  evidenceRefs: string[]
  warnings: string[]
}

export interface DesktopRuntimeFactsScorecardSummary {
  overallScore: number
  verdict: ScorecardVerdict
  antiCheat: AntiCheatStatus
  dimensions: Array<{
    id: string
    score: number
    verdict: ScorecardVerdict
    evidenceRefs: string[]
    notes: string[]
  }>
  gates: Array<{
    id: string
    status: AntiCheatStatus
    evidenceRefs: string[]
    notes: string[]
  }>
  summary: string
  trajectoryRecordCount: number
}

export interface DesktopRuntimeFactsDrilldownSummary {
  events: number
  checkpoints: number
  jobs: number
  artifacts: number
  tasks: number
  proofs: number
  score?: number
  verdict?: ScorecardVerdict
  antiCheat?: AntiCheatStatus
}

export interface DesktopRuntimeFactsDrilldownEntities {
  tasks: string[]
  jobs: DesktopRuntimeFactsJobItem[]
  artifacts: DesktopRuntimeFactsArtifactItem[]
  proofs: DesktopRuntimeFactsProofItem[]
  checkpoints: DesktopRuntimeFactsCheckpointItem[]
  events: DesktopRuntimeFactsEventItem[]
}

export interface DesktopRuntimeFactsJobItem {
  jobId: string
  status?: string
  stage?: string
  taskId?: string
  artifactCount: number
  proofRequired?: boolean
  recoveryHint?: string
}

export interface DesktopRuntimeFactsArtifactItem {
  artifactId: string
  path?: string
  artifactType?: string
  taskId?: string
  jobId?: string
  proofId?: string
}

export interface DesktopRuntimeFactsProofItem {
  proofId: string
  kind?: string | null
  title?: string | null
  status?: string | null
  sourceRef?: string | null
  at?: string | null
}

export interface DesktopRuntimeFactsCheckpointItem {
  checkpointId: string
  kind?: string
  generatedAt?: string
  taskId?: string
}

export interface DesktopRuntimeFactsEventItem {
  eventId: string
  kind: string
  at?: string
  itemId?: string
  turnId?: string
  toolName?: string
  taskId?: string
  jobId?: string
  artifactId?: string
  proofId?: string
}

export function buildDesktopRuntimeFactsDrilldown(
  input: DesktopRuntimeFactsDrilldownInput,
): DesktopRuntimeFactsDrilldown {
  const facts = input.facts
  const scorecardSummary = input.scorecard ? toScorecardSummary(input.scorecard) : null
  const scorecardStatus: DesktopRuntimeFactsDrilldownScorecardStatus = input.scorecard
    ? 'ready'
    : input.scorecardError
      ? 'unavailable'
      : 'missing'
  const warnings = input.scorecardError ? [`runtime scorecard unavailable: ${input.scorecardError}`] : []

  return {
    surface: 'desktop-runtime-facts-drilldown',
    runId: facts.runId,
    scorecardStatus,
    scorecard: scorecardSummary,
    summary: {
      events: facts.runtimeEventCount,
      checkpoints: facts.checkpointCount,
      jobs: facts.jobCount,
      artifacts: facts.artifactCount,
      tasks: facts.taskIds.length,
      proofs: facts.proofIds.length,
      ...(scorecardSummary ? {
        score: scorecardSummary.overallScore,
        verdict: scorecardSummary.verdict,
        antiCheat: scorecardSummary.antiCheat,
      } : {}),
    },
    entities: {
      tasks: [...facts.taskIds],
      jobs: facts.jobs.map(job => ({
        jobId: job.jobId,
        status: stringField(job, 'status'),
        stage: stringField(job, 'stage'),
        taskId: job.taskId ?? job.factRefs?.taskId,
        artifactCount: job.artifacts?.length ?? 0,
        proofRequired: booleanField(job, 'proofRequired'),
        recoveryHint: stringField(job, 'recoveryHint'),
      })),
      artifacts: facts.artifacts.map(artifact => ({
        artifactId: artifact.id,
        path: artifact.factRefs?.artifactPath ?? stringField(artifact, 'path'),
        artifactType: stringField(artifact, 'artifactType'),
        taskId: artifact.taskId ?? artifact.factRefs?.taskId,
        jobId: artifact.jobId ?? artifact.factRefs?.jobId,
        proofId: artifact.proofId ?? artifact.factRefs?.proofId,
      })),
      proofs: facts.proofIds.map(proofId => {
        const proof = input.rail?.proofs.find(item => item.sourceRef === proofId)
        return {
          proofId,
          kind: proof?.kind,
          title: proof?.title,
          status: proof?.status,
          sourceRef: proof?.sourceRef,
          at: proof?.at,
        }
      }),
      checkpoints: facts.checkpoints.map(checkpoint => ({
        checkpointId: checkpoint.id,
        kind: checkpoint.kind,
        generatedAt: checkpoint.generatedAt,
        taskId: checkpoint.factRefs?.taskId,
      })),
      events: facts.events.map(event => ({
        eventId: event.id,
        kind: event.kind,
        at: event.at,
        itemId: event.itemId,
        turnId: event.turnId,
        toolName: stringField(event.payload, 'tool_name'),
        taskId: event.factRefs?.taskId,
        jobId: event.factRefs?.jobId,
        artifactId: event.factRefs?.artifactId,
        proofId: event.factRefs?.proofId,
      })),
    },
    evidenceRefs: input.scorecard
      ? [...input.scorecard.scorecard.evidenceRefs]
      : uniqueStrings([
          ...facts.eventIds,
          ...facts.jobIds,
          ...facts.artifactIds,
          ...facts.proofIds,
        ]),
    warnings,
  }
}

function toScorecardSummary(result: AppServerRuntimeScorecardReadResult): DesktopRuntimeFactsScorecardSummary {
  return {
    overallScore: result.scorecard.overallScore,
    verdict: result.scorecard.verdict,
    antiCheat: result.scorecard.antiCheat.verdict,
    dimensions: result.scorecard.dimensions.map(dimension => ({
      id: dimension.id,
      score: dimension.score,
      verdict: dimension.verdict,
      evidenceRefs: [...dimension.evidenceRefs],
      notes: [...dimension.notes],
    })),
    gates: result.scorecard.antiCheat.gates.map(gate => ({
      id: gate.id,
      status: gate.status,
      evidenceRefs: [...gate.evidenceRefs],
      notes: [...gate.notes],
    })),
    summary: result.summary,
    trajectoryRecordCount: result.trajectory.recordCount,
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field ? field : undefined
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined
  return typeof value[key] === 'boolean' ? value[key] : undefined
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
