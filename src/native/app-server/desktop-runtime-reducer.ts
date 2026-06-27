import type { AppServerEvent } from './event-stream.js'

export type DesktopRuntimeItemStatus = 'streaming' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface DesktopRuntimeState {
  activeTurnIndex?: number
  items: DesktopRuntimeItem[]
}

export type DesktopRuntimeItem =
  | DesktopRuntimeAssistantItem
  | DesktopRuntimeToolItem
  | DesktopRuntimeCommandItem
  | DesktopRuntimeCommandOutputItem
  | DesktopRuntimeCommandResultItem
  | DesktopRuntimeDiffItem
  | DesktopRuntimeDiffResultItem

export interface DesktopRuntimeAssistantItem {
  id: string
  kind: 'assistant'
  status: Extract<DesktopRuntimeItemStatus, 'streaming' | 'completed' | 'failed' | 'interrupted'>
  text: string
  projectId: string
  threadId: string
  turnIndex?: number
}

export interface DesktopRuntimeToolItem {
  id: string
  kind: 'tool'
  status: Extract<DesktopRuntimeItemStatus, 'running' | 'completed' | 'failed'>
  toolName: string
  input: Record<string, unknown>
  projectId: string
  threadId: string
  result?: string
  output?: string
  isError?: boolean
  durationMs?: number
  totalLines?: number
  totalBytes?: number
  elapsedMs?: number
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeCommandItem {
  id: string
  kind: 'command'
  status: Extract<DesktopRuntimeItemStatus, 'running' | 'failed'>
  commandId: string
  command: string
  projectId: string
  threadId: string
  cwd?: string
  commandRef?: string
  statusRef?: string
  outputRef?: string
  sourceRefs?: Extract<AppServerEvent, { type: 'command.started' }>['sourceRefs']
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeCommandOutputItem {
  id: string
  kind: 'command_output'
  status: Extract<DesktopRuntimeItemStatus, 'running' | 'failed'>
  commandId: string
  output: string
  projectId: string
  threadId: string
  totalLines?: number
  totalBytes?: number
  elapsedMs?: number
  statusRef?: string
  outputRef?: string
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeCommandResultItem {
  id: string
  kind: 'command_result'
  status: Extract<DesktopRuntimeItemStatus, 'completed' | 'failed'>
  commandId: string
  result: string
  projectId: string
  threadId: string
  isError: boolean
  durationMs: number
  exitCode?: number
  commandRef?: string
  statusRef?: string
  outputRef?: string
  sourceRefs?: Extract<AppServerEvent, { type: 'command.completed' }>['sourceRefs']
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeDiffItem {
  id: string
  kind: 'diff'
  status: Extract<DesktopRuntimeItemStatus, 'running' | 'failed'>
  diffId: string
  toolName: string
  input: Record<string, unknown>
  projectId: string
  threadId: string
  path?: string
  operation: string
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeDiffResultItem {
  id: string
  kind: 'diff_result'
  status: Extract<DesktopRuntimeItemStatus, 'completed' | 'failed'>
  diffId: string
  toolName: string
  projectId: string
  threadId: string
  result: string
  isError: boolean
  durationMs: number
  path?: string
  operation: string
  preview?: Extract<AppServerEvent, { type: 'diff.completed' }>['preview']
  toolUseId?: string
  itemId?: string
  runtimeTurnId?: string
}

export interface DesktopRuntimeScope {
  projectId?: string
  threadId?: string
}

export function createDesktopRuntimeState(): DesktopRuntimeState {
  return { items: [] }
}

export function reduceDesktopRuntimeEvent(
  state: DesktopRuntimeState,
  event: AppServerEvent,
  scope: DesktopRuntimeScope = {},
): DesktopRuntimeState {
  if (!desktopRuntimeEventInScope(event, scope)) return state

  switch (event.type) {
    case 'turn.started':
      return {
        ...state,
        activeTurnIndex: event.turnIndex,
      }
    case 'assistant.delta': {
      const turnIndex = state.activeTurnIndex
      const id = assistantItemId(event.threadId, turnIndex)
      const existing = state.items.find(item => item.id === id)
      const nextItem: DesktopRuntimeAssistantItem = existing && existing.kind === 'assistant'
        ? {
            ...existing,
            status: 'streaming',
            text: existing.text + event.text,
          }
        : {
            id,
            kind: 'assistant',
            status: 'streaming',
            text: event.text,
            projectId: event.projectId,
            threadId: event.threadId,
            ...(turnIndex !== undefined ? { turnIndex } : {}),
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'command.started': {
      const id = commandItemId(event.commandId)
      const existing = state.items.find(item => item.id === id)
      const nextItem: DesktopRuntimeCommandItem = existing && existing.kind === 'command'
        ? {
            ...existing,
            status: 'running',
            command: event.command,
            cwd: event.cwd,
            commandRef: event.commandRef,
            statusRef: event.statusRef,
            outputRef: event.outputRef,
            sourceRefs: event.sourceRefs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'command',
            status: 'running',
            commandId: event.commandId,
            command: event.command,
            projectId: event.projectId,
            threadId: event.threadId,
            cwd: event.cwd,
            commandRef: event.commandRef,
            statusRef: event.statusRef,
            outputRef: event.outputRef,
            sourceRefs: event.sourceRefs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'command.outputDelta': {
      const id = commandOutputItemId(event.commandId)
      const existing = state.items.find(item => item.id === id)
      const delta = event.delta || event.lines.join('\n')
      const nextOutput = appendOutputDelta(
        existing && existing.kind === 'command_output' ? existing.output : undefined,
        delta,
      )
      const nextItem: DesktopRuntimeCommandOutputItem = existing && existing.kind === 'command_output'
        ? {
            ...existing,
            status: 'running',
            output: nextOutput,
            totalLines: event.totalLines,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
            statusRef: event.statusRef,
            outputRef: event.outputRef,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'command_output',
            status: 'running',
            commandId: event.commandId,
            output: nextOutput,
            projectId: event.projectId,
            threadId: event.threadId,
            totalLines: event.totalLines,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
            statusRef: event.statusRef,
            outputRef: event.outputRef,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'command.completed': {
      const nextItem: DesktopRuntimeCommandResultItem = {
        id: commandResultItemId(event.commandId),
        kind: 'command_result',
        status: event.isError ? 'failed' : 'completed',
        commandId: event.commandId,
        result: event.result,
        projectId: event.projectId,
        threadId: event.threadId,
        isError: event.isError,
        durationMs: event.durationMs,
        exitCode: event.exitCode,
        commandRef: event.commandRef,
        statusRef: event.statusRef,
        outputRef: event.outputRef,
        sourceRefs: event.sourceRefs,
        toolUseId: event.toolUseId,
        itemId: event.itemId,
        runtimeTurnId: event.runtimeTurnId,
      }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'diff.started': {
      const id = diffItemId(event.diffId)
      const existing = state.items.find(item => item.id === id)
      const nextItem: DesktopRuntimeDiffItem = existing && existing.kind === 'diff'
        ? {
            ...existing,
            status: 'running',
            toolName: event.toolName,
            input: event.input,
            path: event.path,
            operation: event.operation,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'diff',
            status: 'running',
            diffId: event.diffId,
            toolName: event.toolName,
            input: event.input,
            projectId: event.projectId,
            threadId: event.threadId,
            path: event.path,
            operation: event.operation,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'diff.completed': {
      const nextItem: DesktopRuntimeDiffResultItem = {
        id: diffResultItemId(event.diffId),
        kind: 'diff_result',
        status: event.isError ? 'failed' : 'completed',
        diffId: event.diffId,
        toolName: event.toolName,
        projectId: event.projectId,
        threadId: event.threadId,
        result: event.result,
        isError: event.isError,
        durationMs: event.durationMs,
        path: event.path,
        operation: event.operation,
        preview: event.preview,
        toolUseId: event.toolUseId,
        itemId: event.itemId,
        runtimeTurnId: event.runtimeTurnId,
      }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'tool.started': {
      const id = toolItemId(event)
      const existing = state.items.find(item => item.id === id)
      const nextItem: DesktopRuntimeToolItem = existing && existing.kind === 'tool'
        ? {
            ...existing,
            status: 'running',
            toolName: event.toolName,
            input: event.input,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'tool',
            status: 'running',
            toolName: event.toolName,
            input: event.input,
            projectId: event.projectId,
            threadId: event.threadId,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'tool.completed': {
      const id = toolItemId(event)
      const existing = state.items.find(item => item.id === id)
      const nextItem: DesktopRuntimeToolItem = existing && existing.kind === 'tool'
        ? {
            ...existing,
            status: event.isError ? 'failed' : 'completed',
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            durationMs: event.durationMs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'tool',
            status: event.isError ? 'failed' : 'completed',
            toolName: event.toolName,
            input: {},
            projectId: event.projectId,
            threadId: event.threadId,
            result: event.result,
            isError: event.isError,
            durationMs: event.durationMs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'tool.delta': {
      const id = toolItemId(event)
      const existing = state.items.find(item => item.id === id)
      const nextOutput = appendOutputDelta(
        existing && existing.kind === 'tool' ? existing.output : undefined,
        event.delta,
      )
      const nextItem: DesktopRuntimeToolItem = existing && existing.kind === 'tool'
        ? {
            ...existing,
            status: 'running',
            toolName: event.toolName,
            output: nextOutput,
            totalLines: event.totalLines,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
        : {
            id,
            kind: 'tool',
            status: 'running',
            toolName: event.toolName,
            input: {},
            projectId: event.projectId,
            threadId: event.threadId,
            output: nextOutput,
            totalLines: event.totalLines,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
            toolUseId: event.toolUseId,
            itemId: event.itemId,
            runtimeTurnId: event.runtimeTurnId,
          }
      return upsertDesktopRuntimeItem(state, nextItem)
    }
    case 'turn.completed':
      return {
        ...state,
        items: state.items.map(item => {
          if (item.threadId !== event.threadId) return item
          if (item.kind === 'assistant' && item.status === 'streaming') {
            return {
              ...item,
              status: 'completed',
              text: item.text || event.finalText,
            }
          }
          return item
        }),
      }
    case 'turn.failed':
      return markThreadItems(state, event.threadId, 'failed')
    case 'turn.interrupted':
      return markThreadItems(state, event.threadId, 'interrupted')
    default:
      return state
  }
}

function desktopRuntimeEventInScope(event: AppServerEvent, scope: DesktopRuntimeScope): boolean {
  if (scope.projectId && event.projectId !== scope.projectId) return false
  const threadId = eventThreadId(event)
  if (scope.threadId && threadId !== scope.threadId) return false
  return true
}

function eventThreadId(event: AppServerEvent): string | undefined {
  return 'threadId' in event ? event.threadId : undefined
}

function assistantItemId(threadId: string, turnIndex: number | undefined): string {
  return `live-assistant:${threadId}:${turnIndex ?? 'current'}`
}

function commandItemId(commandId: string): string {
  return `live-command:${commandId}`
}

function commandOutputItemId(commandId: string): string {
  return `live-command-output:${commandId}`
}

function commandResultItemId(commandId: string): string {
  return `live-command-result:${commandId}`
}

function diffItemId(diffId: string): string {
  return `live-diff:${diffId}`
}

function diffResultItemId(diffId: string): string {
  return `live-diff-result:${diffId}`
}

function toolItemId(event: Extract<AppServerEvent, { type: 'tool.started' | 'tool.delta' | 'tool.completed' }>): string {
  return `live-tool:${event.itemId || event.toolUseId || event.toolName}`
}

function appendOutputDelta(output: string | undefined, delta: string): string {
  if (!delta) return output ?? ''
  if (!output) return delta
  return `${output}\n${delta}`
}

function upsertDesktopRuntimeItem(
  state: DesktopRuntimeState,
  item: DesktopRuntimeItem,
): DesktopRuntimeState {
  const index = state.items.findIndex(current => current.id === item.id)
  if (index === -1) {
    return {
      ...state,
      items: [...state.items, item],
    }
  }
  return {
    ...state,
    items: [
      ...state.items.slice(0, index),
      item,
      ...state.items.slice(index + 1),
    ],
  }
}

function markThreadItems(
  state: DesktopRuntimeState,
  threadId: string,
  status: 'failed' | 'interrupted',
): DesktopRuntimeState {
  return {
    ...state,
    items: state.items.map(item => {
      if (item.threadId !== threadId) return item
      if (item.kind !== 'assistant') {
        return {
          ...item,
          status: 'failed',
        }
      }
      return {
        ...item,
        status,
      }
    }),
  }
}
