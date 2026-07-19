import type {
  AppServerEventSubscription,
  AppServerTurnStartInput,
} from './client.js'
import {
  bootstrapDesktopProductShell,
  type DesktopProductShellBootstrapOptions,
  type DesktopProductShellBootstrapResult,
} from './desktop-product-shell.js'
import {
  loadDesktopProductShellViewModel,
  type DesktopProductShellViewModel,
  type DesktopProductShellViewModelParams,
} from './desktop-product-shell-view-model.js'
import type { ReviewBatchActionResult } from './review-action-service.js'
import type { AppServerTurnRecoverResult, AppServerTurnStatusResult } from './turn-status-service.js'
import type { TurnStartResult } from './thread-service.js'

export interface DesktopProductShellSmokeOptions extends DesktopProductShellBootstrapOptions, DesktopProductShellViewModelParams {
  taskInput?: string
  reviewAction?: 'apply' | 'revert' | 'none'
  reviewDiffIds?: string[]
  recoverStaleTurn?: boolean
}

export interface DesktopProductShellSmokeDebugBoundary {
  productShellImport: 'owlcoda/desktop'
  productShellUsesDebugOnlyMethods: false
  debugRendererPath: '/desktop'
  debugRendererBoundary: 'operator-debug-harness'
  debugRendererMayUseDebugOnlyMethods: true
  forbiddenProductMethods: string[]
}

export interface DesktopProductShellSmokeChecks {
  bootstrap: boolean
  viewModel: boolean
  liveEvents: boolean
  submitTask: boolean
  reviewTransaction: boolean
  statusRecovery: boolean
  readOnlyRunKitRail: boolean
  debugBoundary: boolean
}

export interface DesktopProductShellSmokeResult {
  surface: 'desktop-product-shell-smoke'
  boundary: 'external-product-shell'
  ready: boolean
  projectId?: string
  threadId?: string
  bootstrap: Omit<DesktopProductShellBootstrapResult, 'client' | 'protocol'>
  viewModel: DesktopProductShellViewModel | null
  eventSubscription: AppServerEventSubscription | null
  submittedTurn: TurnStartResult | null
  reviewBatch: ReviewBatchActionResult | null
  turnStatus: AppServerTurnStatusResult | null
  recovery: AppServerTurnRecoverResult | null
  checks: DesktopProductShellSmokeChecks
  debugBoundary: DesktopProductShellSmokeDebugBoundary
  errors: string[]
  warnings: string[]
}

export async function runDesktopProductShellSmoke(
  options: DesktopProductShellSmokeOptions,
): Promise<DesktopProductShellSmokeResult> {
  const bootstrap = await bootstrapDesktopProductShell(options)
  const debugBoundary = desktopSmokeDebugBoundary(bootstrap.debugOnlyMethods)
  const errors: string[] = [...bootstrap.errors]
  const warnings: string[] = [...bootstrap.warnings]
  let viewModel: DesktopProductShellViewModel | null = null
  let eventSubscription: AppServerEventSubscription | null = null
  let submittedTurn: TurnStartResult | null = null
  let reviewBatch: ReviewBatchActionResult | null = null
  let turnStatus: AppServerTurnStatusResult | null = null
  let recovery: AppServerTurnRecoverResult | null = null

  if (bootstrap.ready) {
    viewModel = await loadDesktopProductShellViewModel(bootstrap.client, {
      projectId: options.projectId,
      threadId: options.threadId,
      threadLimit: options.threadLimit,
    })
    const projectId = viewModel.project?.id ?? options.projectId
    const threadId = viewModel.thread?.id ?? options.threadId
    eventSubscription = await bootstrap.client.eventSubscribe()

    if (projectId && threadId && options.taskInput) {
      const turnInput: AppServerTurnStartInput = {
        projectId,
        threadId,
        input: options.taskInput,
      }
      submittedTurn = await bootstrap.client.turnStart(turnInput)
    }

    const reviewDiffIds = options.reviewDiffIds ?? viewModel.review?.diffIds ?? []
    const reviewAction = options.reviewAction ?? 'none'
    if (projectId && threadId && reviewAction !== 'none' && reviewDiffIds.length > 0) {
      const params = { projectId, threadId, diffIds: reviewDiffIds }
      reviewBatch = reviewAction === 'apply'
        ? await bootstrap.client.reviewBatchApply(params)
        : await bootstrap.client.reviewBatchRevert(params)
    }

    if (projectId && threadId) {
      turnStatus = await bootstrap.client.turnStatus({ projectId, threadId })
      if (options.recoverStaleTurn && (turnStatus.status === 'stale' || turnStatus.status === 'saved_only')) {
        recovery = await bootstrap.client.turnRecover({
          projectId,
          threadId,
          action: 'mark_recovered',
          note: 'desktop product shell smoke',
        })
      }
    }

  }

  const projectId = viewModel?.project?.id ?? options.projectId
  const threadId = viewModel?.thread?.id ?? options.threadId
  const exposedMethods = new Set<string>([
    ...bootstrap.stableMethods,
    ...bootstrap.experimentalMethods,
  ])
  const checks = {
    bootstrap: bootstrap.ready,
    viewModel: viewModel?.status === 'ready',
    liveEvents: eventSubscription?.transport === 'sse' && eventSubscription.events.includes('review.batchCompleted'),
    submitTask: options.taskInput ? submittedTurn?.status === 'accepted' : true,
    reviewTransaction: (options.reviewAction ?? 'none') === 'none'
      ? true
      : Boolean(reviewBatch?.transaction?.transactionId && reviewBatch.proof?.kind === 'review_batch_transaction'),
    statusRecovery: Boolean(turnStatus && (!options.recoverStaleTurn || recovery || (turnStatus.status !== 'stale' && turnStatus.status !== 'saved_only'))),
    readOnlyRunKitRail: Boolean(viewModel?.rail)
      && !exposedMethods.has('proof/append')
      && !exposedMethods.has('gate/confirm'),
    debugBoundary: debugBoundary.productShellUsesDebugOnlyMethods === false,
  }

  return {
    surface: 'desktop-product-shell-smoke',
    boundary: 'external-product-shell',
    ready: Object.values(checks).every(Boolean) && errors.length === 0,
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
    bootstrap: {
      productSurface: bootstrap.productSurface,
      boundary: bootstrap.boundary,
      ready: bootstrap.ready,
      protocolVersion: bootstrap.protocolVersion,
      capabilityGate: bootstrap.capabilityGate,
      stableMethods: bootstrap.stableMethods,
      experimentalMethods: bootstrap.experimentalMethods,
      debugOnlyMethods: bootstrap.debugOnlyMethods,
      errors: bootstrap.errors,
      warnings: bootstrap.warnings,
    },
    viewModel,
    eventSubscription,
    submittedTurn,
    reviewBatch,
    turnStatus,
    recovery,
    checks,
    debugBoundary,
    errors,
    warnings,
  }
}

function desktopSmokeDebugBoundary(debugOnlyMethods: string[]): DesktopProductShellSmokeDebugBoundary {
  return {
    productShellImport: 'owlcoda/desktop',
    productShellUsesDebugOnlyMethods: false,
    debugRendererPath: '/desktop',
    debugRendererBoundary: 'operator-debug-harness',
    debugRendererMayUseDebugOnlyMethods: true,
    forbiddenProductMethods: [...debugOnlyMethods].sort(),
  }
}
