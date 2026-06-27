import type { AppServerEvent } from './event-stream.js'
import {
  createDesktopRuntimeState,
  reduceDesktopRuntimeEvent,
  type DesktopRuntimeScope,
  type DesktopRuntimeState,
} from './desktop-runtime-reducer.js'

export const DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES: Array<AppServerEvent['type']> = [
  'turn.started',
  'assistant.delta',
  'command.started',
  'command.outputDelta',
  'command.completed',
  'diff.started',
  'diff.completed',
  'tool.started',
  'tool.delta',
  'tool.completed',
  'turn.interrupted',
  'thread.updated',
  'approval.requested',
  'approval.resolved',
  'interaction.requested',
  'interaction.resolved',
  'proof.appended',
  'gate.confirmed',
  'review.batchCompleted',
  'review.statusUpdated',
  'turn.completed',
  'turn.failed',
  'runtimeRail.updated',
]

export interface DesktopProductShellLiveSnapshot {
  surface: 'desktop-product-shell-live-events'
  runtime: DesktopRuntimeState
  eventCount: number
  lastEvent: AppServerEvent | null
  refreshNeeded: boolean
  refreshReasons: string[]
}

export interface DesktopProductShellLiveAdapterOptions {
  scope?: DesktopRuntimeScope
  initialRuntime?: DesktopRuntimeState
}

export interface DesktopProductShellLiveAdapter {
  handleEvent(event: AppServerEvent): DesktopProductShellLiveSnapshot
  getSnapshot(): DesktopProductShellLiveSnapshot
  resetRefresh(): DesktopProductShellLiveSnapshot
}

export interface DesktopProductShellServerEventLike {
  data: string
}

export interface DesktopProductShellEventSourceLike {
  addEventListener(type: string, listener: (event: DesktopProductShellServerEventLike) => void): void
  close(): void
}

export interface DesktopProductShellLiveConnectionOptions extends DesktopProductShellLiveAdapterOptions {
  baseUrl: string
  eventSourceFactory: (url: string) => DesktopProductShellEventSourceLike
  adapter?: DesktopProductShellLiveAdapter
  onEvent?: (event: AppServerEvent) => void
  onSnapshot?: (snapshot: DesktopProductShellLiveSnapshot) => void
  onError?: (error: Error, eventType: string, rawEvent: DesktopProductShellServerEventLike) => void
}

export interface DesktopProductShellLiveConnection {
  adapter: DesktopProductShellLiveAdapter
  eventSource: DesktopProductShellEventSourceLike
  eventTypes: Array<AppServerEvent['type']>
  close(): void
}

const REFRESH_EVENT_TYPES = new Set<AppServerEvent['type']>([
  'turn.interrupted',
  'thread.updated',
  'approval.requested',
  'approval.resolved',
  'interaction.requested',
  'interaction.resolved',
  'proof.appended',
  'gate.confirmed',
  'review.batchCompleted',
  'review.statusUpdated',
  'turn.completed',
  'turn.failed',
  'runtimeRail.updated',
])

export function createDesktopProductShellLiveAdapter(
  options: DesktopProductShellLiveAdapterOptions = {},
): DesktopProductShellLiveAdapter {
  const scope = options.scope ?? {}
  let runtime = options.initialRuntime ?? createDesktopRuntimeState()
  let eventCount = 0
  let lastEvent: AppServerEvent | null = null
  let refreshNeeded = false
  let refreshReasons: string[] = []

  return {
    handleEvent(event) {
      if (!appServerEventInScope(event, scope)) return snapshot()
      eventCount += 1
      lastEvent = event
      runtime = reduceDesktopRuntimeEvent(runtime, event, scope)
      if (REFRESH_EVENT_TYPES.has(event.type)) {
        refreshNeeded = true
        if (!refreshReasons.includes(event.type)) refreshReasons = [...refreshReasons, event.type]
      }
      return snapshot()
    },
    getSnapshot: snapshot,
    resetRefresh() {
      refreshNeeded = false
      refreshReasons = []
      return snapshot()
    },
  }

  function snapshot(): DesktopProductShellLiveSnapshot {
    return {
      surface: 'desktop-product-shell-live-events',
      runtime,
      eventCount,
      lastEvent,
      refreshNeeded,
      refreshReasons,
    }
  }
}

export function connectDesktopProductShellLiveEvents(
  options: DesktopProductShellLiveConnectionOptions,
): DesktopProductShellLiveConnection {
  const adapter = options.adapter ?? createDesktopProductShellLiveAdapter({
    scope: options.scope,
    initialRuntime: options.initialRuntime,
  })
  const eventSource = options.eventSourceFactory(`${options.baseUrl.replace(/\/+$/, '')}/events`)
  for (const eventType of DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES) {
    eventSource.addEventListener(eventType, rawEvent => {
      try {
        const event = parseDesktopProductShellServerEvent(rawEvent)
        options.onEvent?.(event)
        options.onSnapshot?.(adapter.handleEvent(event))
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
          eventType,
          rawEvent,
        )
      }
    })
  }

  return {
    adapter,
    eventSource,
    eventTypes: [...DESKTOP_PRODUCT_SHELL_LIVE_EVENT_TYPES],
    close() {
      eventSource.close()
    },
  }
}

export function parseDesktopProductShellServerEvent(event: DesktopProductShellServerEventLike): AppServerEvent {
  try {
    const parsed = JSON.parse(event.data) as unknown
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      throw new Error('missing event type')
    }
    return parsed as AppServerEvent
  } catch (error) {
    throw new Error(`Invalid App Server event payload: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function appServerEventInScope(event: AppServerEvent, scope: DesktopRuntimeScope): boolean {
  if (scope.projectId && event.projectId !== scope.projectId) return false
  if (scope.threadId && 'threadId' in event && event.threadId !== scope.threadId) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
