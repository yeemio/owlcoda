import type { AppServerClient } from './client.js'
import { createReviewCenterAdapter, type ReviewCenterState } from './review-center-adapter.js'
import type { AppServerApprovalListResult, AppServerInteractionListResult } from './approval-service.js'
import type {
  AppServerProviderEvalReportReadResult,
  AppServerRuntimeFactsReadResult,
  AppServerRuntimeScorecardReadResult,
  AppServerStructuredOutputArtifactsReadResult,
} from './protocol-contract.js'
import {
  buildDesktopRuntimeFactsDrilldown,
  type DesktopRuntimeFactsDrilldown,
} from './desktop-runtime-facts-drilldown.js'
import type { ProjectSummary } from './project-service.js'
import type { RunKitRailState } from './runtime-rail-service.js'
import type { RuntimeTranscriptResult } from './runtime-transcript-service.js'
import type { AppServerThread } from './thread-service.js'

export type DesktopProductShellViewModelStatus = 'ready' | 'no_project' | 'no_thread'
export type DesktopRuntimeFactsStatus = 'ready' | 'missing_run_id' | 'unavailable'
export type DesktopModelComparisonPanelStatus = 'ready' | 'empty' | 'unavailable'

export interface DesktopModelComparisonLeaderboardItem {
  providerId: string
  modelId: string
  providerModel: string
  runCount: number
  passedCount: number
  failedCount: number
  passRate: number
  passRatePercent: number
  averageScore: number
  totalTokens: number
  totalCostUsd: number
  averageDurationMs: number
  verdict: string
}

export interface DesktopModelComparisonCaseItem {
  caseId: string
  providerId: string
  modelId: string
  providerModel: string
  passed: boolean
  score: number
  verdict: string
  antiCheat: string
  totalTokens: number
  costUsd: number
  durationMs: number
  evidenceRefCount: number
  error?: string
}

export interface DesktopModelComparisonPanel {
  surface: 'model-comparison-panel'
  status: DesktopModelComparisonPanelStatus
  sourceMethod: 'benchmark/providerEvalReport/read'
  recordPath?: string
  recordCount: number
  providerModelCount: number
  caseCount: number
  passedCount: number
  failedCount: number
  localOnly: true
  trainingUse: 'not_collected'
  summary: string
  leaderboard: DesktopModelComparisonLeaderboardItem[]
  cases: DesktopModelComparisonCaseItem[]
  markdownAvailable: boolean
  unavailableReason?: string
}

export interface DesktopProductShellViewModelParams {
  projectId?: string
  threadId?: string
  threadLimit?: number
}

export interface DesktopProductShellRuntimeView {
  runId: string | null
  transcript: RuntimeTranscriptResult | null
  runtimeFactsStatus: DesktopRuntimeFactsStatus
  runtimeFacts: AppServerRuntimeFactsReadResult | null
  runtimeScorecard: AppServerRuntimeScorecardReadResult | null
  structuredOutputArtifacts: AppServerStructuredOutputArtifactsReadResult | null
  drilldown: DesktopRuntimeFactsDrilldown | null
  runtimeFactsError?: string
  runtimeScorecardError?: string
  structuredOutputArtifactsError?: string
}

export interface DesktopProductShellViewModel {
  surface: 'desktop-product-shell-view-model'
  status: DesktopProductShellViewModelStatus
  project: ProjectSummary | null
  projects: ProjectSummary[]
  thread: AppServerThread | null
  threads: AppServerThread[]
  rail: RunKitRailState | null
  runtime: DesktopProductShellRuntimeView
  approvals: AppServerApprovalListResult | null
  interactions: AppServerInteractionListResult | null
  review: ReviewCenterState | null
  providerEvalReport: AppServerProviderEvalReportReadResult | null
  modelComparison: DesktopModelComparisonPanel
  warnings: string[]
}

export async function loadDesktopProductShellViewModel(
  client: AppServerClient,
  params: DesktopProductShellViewModelParams = {},
): Promise<DesktopProductShellViewModel> {
  const projectList = await client.projectList()
  const project = selectProject(projectList.projects, params.projectId)
  if (!project) {
    return emptyDesktopProductShellViewModel('no_project', projectList.projects)
  }

  const threadList = await client.threadList({
    projectId: project.id,
    limit: params.threadLimit,
  })
  const thread = selectThread(threadList.threads, params.threadId)
  const rail = await client.runtimeRailRead({ projectId: project.id })
  const providerEvalReport = await optionalRead(() => client.providerEvalReportRead())
  const modelComparison = buildDesktopModelComparisonPanel(providerEvalReport as ProviderEvalReportMaybeUnavailable)

  if (!thread) {
    return {
      ...emptyDesktopProductShellViewModel('no_thread', projectList.projects),
      project,
      threads: threadList.threads,
      rail,
      providerEvalReport,
      modelComparison,
    }
  }

  const scope = { projectId: project.id, threadId: thread.id }
  const transcript = await client.runtimeTranscriptRead(scope)
  const runId = latestRunIdFromDesktopTranscript(transcript)
  const { status: runtimeFactsStatus, facts: runtimeFacts, error: runtimeFactsError } = await loadRuntimeFacts(
    client,
    scope,
    runId,
  )
  const { scorecard: runtimeScorecard, error: runtimeScorecardError } = await loadRuntimeScorecard(
    client,
    scope,
    runtimeFacts,
    runId,
  )
  const { artifacts: structuredOutputArtifacts, error: structuredOutputArtifactsError } = await loadStructuredOutputArtifacts(
    client,
    scope,
    runtimeFacts,
    runId,
  )
  const drilldown = runtimeFacts
    ? buildDesktopRuntimeFactsDrilldown({
        facts: runtimeFacts,
        scorecard: runtimeScorecard,
        scorecardError: runtimeScorecardError,
        rail,
      })
    : null
  const approvals = await client.approvalList(scope)
  const interactions = await client.interactionList(scope)
  const review = await createReviewCenterAdapter(client).load(scope)

  return {
    surface: 'desktop-product-shell-view-model',
    status: 'ready',
    project,
    projects: projectList.projects,
    thread,
    threads: threadList.threads,
    rail,
    runtime: {
      runId,
      transcript,
      runtimeFactsStatus,
      runtimeFacts,
      runtimeScorecard,
      structuredOutputArtifacts,
      drilldown,
      ...(runtimeFactsError ? { runtimeFactsError } : {}),
      ...(runtimeScorecardError ? { runtimeScorecardError } : {}),
      ...(structuredOutputArtifactsError ? { structuredOutputArtifactsError } : {}),
    },
    approvals,
    interactions,
    review,
    providerEvalReport,
    modelComparison,
    warnings: [],
  }
}

type ProviderEvalReportMaybeUnavailable =
  | AppServerProviderEvalReportReadResult
  | {
      unavailable: true
      message?: string
    }
  | null
  | undefined

export function buildDesktopModelComparisonPanel(
  result: ProviderEvalReportMaybeUnavailable,
): DesktopModelComparisonPanel {
  if (!result) {
    return emptyDesktopModelComparisonPanel(
      'provider eval report unavailable',
    )
  }
  if (isProviderEvalUnavailable(result)) {
    return emptyDesktopModelComparisonPanel(
      result.message || 'provider eval report unavailable',
    )
  }

  const report = result.report
  const recordCount = report.recordCount
  return {
    surface: 'model-comparison-panel',
    status: recordCount > 0 ? 'ready' : 'empty',
    sourceMethod: 'benchmark/providerEvalReport/read',
    recordPath: result.recordPath,
    recordCount,
    providerModelCount: report.providerModelCount,
    caseCount: report.caseCount,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    localOnly: true,
    trainingUse: 'not_collected',
    summary: report.summary,
    leaderboard: report.leaderboard.map(item => ({
      providerId: item.providerId,
      modelId: item.modelId,
      providerModel: `${item.providerId}/${item.modelId}`,
      runCount: item.runCount,
      passedCount: item.passedCount,
      failedCount: item.failedCount,
      passRate: item.passRate,
      passRatePercent: Math.round(item.passRate * 100),
      averageScore: item.averageScore,
      totalTokens: item.totalTokens,
      totalCostUsd: item.totalCostUsd,
      averageDurationMs: item.averageDurationMs,
      verdict: item.verdict,
    })),
    cases: report.caseMatrix.map(item => ({
      caseId: item.caseId,
      providerId: item.providerId,
      modelId: item.modelId,
      providerModel: `${item.providerId}/${item.modelId}`,
      passed: item.passed,
      score: item.score,
      verdict: item.verdict,
      antiCheat: item.antiCheat,
      totalTokens: item.totalTokens,
      costUsd: item.costUsd,
      durationMs: item.durationMs,
      evidenceRefCount: item.evidenceRefCount,
      ...(item.error ? { error: item.error } : {}),
    })),
    markdownAvailable: result.markdown.trim().length > 0,
  }
}

function isProviderEvalUnavailable(
  result: ProviderEvalReportMaybeUnavailable,
): result is { unavailable: true; message?: string } {
  return Boolean(result && 'unavailable' in result && result.unavailable === true)
}

function emptyDesktopModelComparisonPanel(reason: string): DesktopModelComparisonPanel {
  return {
    surface: 'model-comparison-panel',
    status: 'unavailable',
    sourceMethod: 'benchmark/providerEvalReport/read',
    recordCount: 0,
    providerModelCount: 0,
    caseCount: 0,
    passedCount: 0,
    failedCount: 0,
    localOnly: true,
    trainingUse: 'not_collected',
    summary: reason,
    leaderboard: [],
    cases: [],
    markdownAvailable: false,
    unavailableReason: reason,
  }
}

export function latestRunIdFromDesktopTranscript(transcript: RuntimeTranscriptResult | null | undefined): string | null {
  const items = transcript?.items ?? []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if ('runtime' in item && item.runtime?.runId) return item.runtime.runId
  }
  return null
}

function selectProject(projects: ProjectSummary[], projectId: string | undefined): ProjectSummary | null {
  if (!projectId) return projects[0] ?? null
  return projects.find(project => project.id === projectId) ?? null
}

function selectThread(threads: AppServerThread[], threadId: string | undefined): AppServerThread | null {
  if (!threadId) return threads[0] ?? null
  return threads.find(thread => thread.id === threadId) ?? null
}

async function loadRuntimeFacts(
  client: AppServerClient,
  scope: { projectId: string; threadId: string },
  runId: string | null,
): Promise<{
  status: DesktopRuntimeFactsStatus
  facts: AppServerRuntimeFactsReadResult | null
  error?: string
}> {
  if (!runId) return { status: 'missing_run_id', facts: null }
  try {
    return {
      status: 'ready',
      facts: await client.runtimeFactsRead({ ...scope, runId }),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      facts: null,
      error: error instanceof Error ? error.message : 'runtime facts unavailable',
    }
  }
}

async function loadRuntimeScorecard(
  client: AppServerClient,
  scope: { projectId: string; threadId: string },
  facts: AppServerRuntimeFactsReadResult | null,
  runId: string | null,
): Promise<{
  scorecard: AppServerRuntimeScorecardReadResult | null
  error?: string
}> {
  if (!runId || !facts) return { scorecard: null }
  try {
    return {
      scorecard: await client.runtimeScorecardRead({ ...scope, runId }),
    }
  } catch (error) {
    return {
      scorecard: null,
      error: error instanceof Error ? error.message : 'runtime scorecard unavailable',
    }
  }
}

async function loadStructuredOutputArtifacts(
  client: AppServerClient,
  scope: { projectId: string; threadId: string },
  facts: AppServerRuntimeFactsReadResult | null,
  runId: string | null,
): Promise<{
  artifacts: AppServerStructuredOutputArtifactsReadResult | null
  error?: string
}> {
  if (!runId || !facts) return { artifacts: null }
  try {
    return {
      artifacts: await client.structuredOutputArtifactsRead({ ...scope, runId }),
    }
  } catch (error) {
    return {
      artifacts: null,
      error: error instanceof Error ? error.message : 'structured output artifacts unavailable',
    }
  }
}

async function optionalRead<T>(reader: () => Promise<T>): Promise<T | null> {
  try {
    return await reader()
  } catch {
    return null
  }
}

function emptyDesktopProductShellViewModel(
  status: DesktopProductShellViewModelStatus,
  projects: ProjectSummary[],
): DesktopProductShellViewModel {
  return {
    surface: 'desktop-product-shell-view-model',
    status,
    project: null,
    projects,
    thread: null,
    threads: [],
    rail: null,
    runtime: {
      runId: null,
      transcript: null,
      runtimeFactsStatus: 'missing_run_id',
      runtimeFacts: null,
      runtimeScorecard: null,
      structuredOutputArtifacts: null,
      drilldown: null,
    },
    approvals: null,
    interactions: null,
    review: null,
    providerEvalReport: null,
    modelComparison: emptyDesktopModelComparisonPanel('provider eval report unavailable'),
    warnings: [],
  }
}
