import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Upstream Ink fork — ScrollBox, viewport culling, native scroll
import { render as inkRender, Box, Static, Text, useApp, useInput, type Instance as InkInstance } from '../ink.js'

import { loadConfig, resolveModelContextWindow } from '../config.js'
import { VERSION, buildTag } from '../version.js'
import { SubmissionGuard } from './submission-guard.js'
import { SubmissionQueue } from './submission-queue.js'
import { isInteractiveChatModelName } from '../model-registry.js'
import { usesLowChurnTerminalMode } from '../ink/terminal.js'
import { isInputLatencyTraceEnabled, traceInputLatencyCheckpoint } from '../ink/input-latency-trace.js'
import {
  createConversation,
  resolveDefaultMaxOutputTokens,
  addUserMessage,
  runConversationLoop,
  shouldShowNoResponseFallback,
  type ConversationRuntimeFailure,
  type ConversationCallbacks,
  type ConversationLoopOptions,
  isContextLimitError,
} from './conversation.js'
import { ToolDispatcher } from './dispatch.js'
import {
  formatBanner,
  formatError,
  formatStopReason,
} from './display.js'
import {
  countDiffStats,
  formatChangeBlockResult,
  renderChangeBlockLines,
  renderFileCreateLines,
  buildFilePickerItems,
  ComposerInputChrome,
  ComposerPanel,
  computeTranscriptHeight,
  parseInputAttachments,
  formatMarker,
  formatWelcomeMarker,
  readWelcomeMarkerOptions,
} from './tui/index.js'
import {
  createPasteStore,
  resetPasteStore,
  detectPasteInsert,
  shouldCollapse,
  collapsePaste,
  expandPlaceholders,
  pruneStaleTokens,
  createBurstState,
  tryBurstCollapse,
} from './tui/paste-collapse.js'
import { themeToInkHex } from './ink-theme.js'
import { InkPicker } from './ink-picker.js'
import { StreamingMarkdownRenderer } from './markdown.js'
import { MCPManager } from './mcp/manager.js'
import { loadPermissions, addGlobalPermission } from './permissions.js'
import { decideTuiTaskScopeApproval, decideTuiToolApproval } from './tui-approval.js'
import { classifyBashCommand } from './bash-risk.js'
import type { Conversation } from './protocol/types.js'
import { validateAndRepairConversation } from './protocol/request.js'
import {
  buildInlineStatusLine,
  buildSlashPickerItems,
  resolveSlashPickerRawSubmit,
  decideExitInterruptAction,
  decideFailedContinuationSubmitAction,
  drainAssistantStreamBoundary,
  composeAssistantChunk,
  countInterruptsInInput,
  estimateWrappedLineCount,
  formatContinuationRetryStatus,
  formatExpensiveFailureGuidance,
  formatRepeatedContinuationRetryGuidance,
  formatResumeCommand,
  isExpensiveFailedContinuationFailure,
  isRetryEligibleContinuationFailure,
  conversationEndsAwaitingAssistant,
  decideEscapeKeyAction,
  recoverGuardRejectedSubmission,
  preflightCheck,
  scrubPseudoToolCall,
  shouldDrainQueuedInputAfterTurn,
  shouldQueueSubmitBehindRunningTask,
  shouldScheduleRuntimeAutoRetry,
  SLASH_COMMANDS_REQUIRING_ARGS,
  splitTranscriptAppendText,
  splitTranscriptForScrollback,
  EXIT_CONFIRM_WINDOW_MS,
  MAX_VISIBLE_ITEMS_CAP,
  type AnchorTier,
  type ComposeState,
  type TranscriptItem,
} from './repl-shared.js'
import { ScrollableTranscript, type ScrollHandle } from './ink-fullscreen-layout.js'
import { getTranscriptInteractionCapability } from './repl-compat.js'
import {
  interruptTraceStack,
  summarizeInterruptInput,
  summarizeKeyForInterruptTrace,
  summarizeTaskForInterruptTrace,
  traceInterruptEvent,
} from './interrupt-trace.js'
import { traceRenderEvent, traceRenderFrame } from './render-trace.js'
import {
  routeConversationNotice,
  summarizeLoopNoise,
  type LoopNoiseState,
} from './loop-noise.js'

// Upstream TextInput chain
import UpstreamTextInput from '../components/TextInput.js'
import {
  createReplRuntimeState,
  finishReplTask,
  interruptReplTask,
  resetReplToIdle,
  setReplTaskPhase,
  startReplTask,
  canWriteTaskOutput,
  type ReplRuntimeState,
  type ReplTaskState,
} from './repl-state.js'
import {
  handleSlashCommand,
  parseApiError,
  SLASH_COMMANDS,
  type ApproveState,
  type ReplOptions,
  type SlashCommandOutput,
  type SlashCommandSideEffect,
  type ThinkingState,
} from './slash-commands.js'
import { updateLiveReplClientSession } from '../repl-lease.js'
import { saveSession, loadSession, listSessions, restoreConversation } from './session.js'
import {
  recordRuntimeAutoRetrySuppressionEvent,
  type RuntimeAutoRetrySuppressionReason,
} from './runtime-events.js'
import { buildSystemPrompt } from './system-prompt.js'
import {
  markTaskBlocked,
  shouldTreatTaskRunStatusAsFailure,
} from './task-state.js'
import { buildNativeToolDefs, canonicalToolName } from './tool-defs.js'
import { createAgentTool } from './tools/agent.js'
import { createConfigTool } from './tools/config.js'
import { createEnterPlanModeTool, type PlanModeState } from './tools/enter-plan-mode.js'
import { createExitPlanModeTool } from './tools/exit-plan-mode.js'
import { createProbePlanTool } from './tools/probe-plan.js'
import { ensureOperatingModeState, initializeOperatingModeState, isModesEnabled, MODE_SUMMARIES, resolveInitialAutoApprove, resolveModeCycleKey } from './modes.js'
import {
  ToolResultCollector,
  formatFooterOnlyToolEnd,
  formatFooterOnlyToolStart,
  formatToolGroup,
  formatUserMessage,
  renderComposerRail,
  shouldRouteToolEndFooterOnly,
  shouldRouteToolStartFooterOnly,
} from './tui/message.js'
import { dumpRenderIncident, recordFullToolOutput, recordRawMdChunk, renderNarration, renderNotice, renderTurnFooter } from './tui/chrome.js'
import { stripAnsi } from './tui/colors.js'
import {
  renderBashPermission,
  detectDestructiveCommand,
  renderFilePermission,
  renderInlinePermission,
  renderWebPermission,
  PERMISSION_CHOICES,
} from './tui/permission.js'
import { PermissionCard, type PermissionCardProps } from './tui/permission-card.js'
// OWL_VERBS/SPINNER_GLYPHS no longer used directly — inline status
// is built via buildInlineStatusLine in repl-shared.ts
import {
  THEME_NAMES,
  dim,
  getThemeName,
  setTheme,
  sgr,
  themeColor,
  type ThemeName,
} from './tui/colors.js'
import { estimateConversationTokens, UsageTracker } from './usage.js'
import type { PickerItem } from './tui/picker.js'
import { registerPickerIsolation } from './tui/picker.js'
import { runEditorSession } from './editor-session.js'

const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt()
const SAFE_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ListMcpResources',
  'ReadMcpResource',
  'ToolSearch',
  'TodoRead',
])
const LIVE_RESPONSE_MAX_LINES = 10
// Watermark-v2: how many transcript items the app-visible window
// holds. Older items commit to terminal-native scrollback via
// <Static>. Terminal.app wheel / tmux copy-mode reveal the committed
// history; 20 visible is enough to see current context without
// scroll-tracking overhead.
const RECENT_VISIBLE_ITEMS = 20
const QUEUED_INPUT_DRAIN_AFTER_INTERRUPT_MS = 900
const DEFAULT_REPL_RUNTIME_AUTO_RETRY_LIMIT = 1
const DEFAULT_REPL_RUNTIME_AUTO_RETRY_DELAY_MS = 1000
const MAX_REPL_RUNTIME_AUTO_RETRY_DELAY_MS = 30_000
type OverlayState =
  | {
      type: 'slash'
      title: string
      items: PickerItem<string>[]
      initialQuery?: string
    }
  | {
      type: 'model'
      title: string
      items: PickerItem<string>[]
      initialQuery?: string
    }
  | {
      type: 'theme'
      title: string
      items: PickerItem<string>[]
      initialQuery?: string
    }
  | {
      type: 'file'
      title: string
      items: PickerItem<string>[]
      prefix: string
      initialQuery?: string
    }

type PermissionPrompt = {
  toolName: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

/**
 * Active AskUserQuestion tool request. Renders the question into the
 * transcript (once, on arrival) and routes the next handleSubmit to
 * `resolve(answer)` instead of starting a new conversation turn.
 * Ctrl+C resolves with empty string = cancelled. options/multiSelect
 * are forwarded so the composer footer can show an appropriate hint.
 */
type QuestionPrompt = {
  toolName: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  resolve: (answer: string) => void
}

type SpinnerState =
  | { mode: 'busy'; message: string }
  | { mode: 'model'; message?: string }
  | { mode: 'tool'; toolName: string; message?: string }

type NativeReplAppProps = {
  conversation: Conversation
  dispatcher: ToolDispatcher
  mcpManager: MCPManager
  opts: ReplOptions
  usage: UsageTracker
  preflightOk: boolean
  isResumed: boolean
}

/**
 * Picker isolation is now capability-driven: the picker itself (showPicker)
 * calls the isolation hooks we register here. Every call to showPicker from
 * anywhere in the app — slash commands, workbench, future surfaces — gets
 * alt-screen isolation automatically, no whitelist to maintain.
 *
 * The previous approach (PICKER_SLASH_COMMANDS hardcoded set + needsAltScreen
 * heuristic around handleSlashCommand) had two failure modes:
 *   (a) new picker-using commands slipped through the whitelist
 *   (b) over-broad wrap enveloped text-only commands unnecessarily
 * Driving off showPicker itself removes both.
 *
 * The ink instance is still module-scoped (published by startInkRepl) because
 * registerPickerIsolation is called from within the rendered component.
 */
let inkAppForSlashCommands: InkInstance | null = null

/**
 * Module-level live pointer to the active REPL's `approveState`. Published
 * when the React component mounts so non-REPL surfaces (the Config tool,
 * future programmatic toggles) can read or flip yolo without going through
 * `/yolo`. Hostile-QA against 0.13.38 hit "I can read the rail but I can't
 * toggle yolo from a tool call" and had to skip the entire group; this
 * module-level handle is the missing channel.
 *
 * Singleton-by-design: there is one REPL per process, the same way
 * `inkAppForSlashCommands` is already module-scoped.
 */
let liveApproveState: { autoApprove: boolean; autoDeny?: boolean } | null = null
export function getLiveApproveState(): { autoApprove: boolean; autoDeny?: boolean } | null {
  return liveApproveState
}

// Construct a minimal in-memory failure stub when we hydrate from a resumed
// session. The stub is enough for the UI layer (status format + guidance
// format + eligibility check). We don't persist the full diagnostic across
// restarts — just the attempt counter — because the original provider
// diagnostic is stale by the time the user resumes anyway.
function resolveReplRuntimeAutoRetryLimit(): number {
  const raw = (process.env['OWLCODA_REPL_RUNTIME_AUTO_RETRY_LIMIT'] ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_REPL_RUNTIME_AUTO_RETRY_LIMIT
  if (raw === 'unlimited' || raw === 'infinite' || raw === 'inf') return Number.POSITIVE_INFINITY
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REPL_RUNTIME_AUTO_RETRY_LIMIT
  return parsed
}

function resolveReplRuntimeAutoRetryDelayMs(attempt: number): number {
  const raw = process.env['OWLCODA_REPL_RUNTIME_AUTO_RETRY_DELAY_MS']
  const base = raw !== undefined && raw !== ''
    ? Number.parseInt(raw, 10)
    : DEFAULT_REPL_RUNTIME_AUTO_RETRY_DELAY_MS
  const safeBase = Number.isFinite(base) && base >= 0 ? base : DEFAULT_REPL_RUNTIME_AUTO_RETRY_DELAY_MS
  return Math.min(safeBase * Math.max(1, 2 ** (attempt - 1)), MAX_REPL_RUNTIME_AUTO_RETRY_DELAY_MS)
}

function formatRetryLimit(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : 'unlimited'
}

function hydrateRetryFailureStub(): ConversationRuntimeFailure {
  return {
    kind: 'pre_first_token_stream_close',
    phase: 'request',
    message: 'Last request failed before producing any output. Use /retry to force a resend, or send a smaller batched request.',
    retryable: true,
  }
}

function classifyRuntimeAutoRetrySuppression(input: {
  runtimeFailure: ConversationRuntimeFailure | null
  taskAborted: boolean
  clearEpochUnchanged: boolean
  currentRetryCount: number
  retryLimit: number
  hasQueuedInput: boolean
  recentRetryKinds: readonly string[]
}): RuntimeAutoRetrySuppressionReason | null {
  const failure = input.runtimeFailure
  if (failure === null) return null
  if (failure.retryable !== true) return 'non_retryable_failure'
  if (
    failure.kind === 'timeout'
    || failure.kind === 'pre_first_token_stream_close'
    || failure.kind === 'empty_provider_response'
  ) {
    return 'failure_kind_suppressed'
  }
  if (input.taskAborted) return 'task_aborted'
  if (!input.clearEpochUnchanged) return 'clear_epoch_changed'
  if (input.currentRetryCount >= input.retryLimit) return 'retry_limit_exhausted'
  if (input.hasQueuedInput) return 'queued_input_present'
  const tail = input.recentRetryKinds.slice(-2)
  if (tail.length >= 2 && tail.every((kind) => kind === failure.kind)) {
    return 'same_kind_retry_window'
  }
  return null
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeCapturedOutput(text: string): string {
  return text
    .replace(/\r\x1b\[K/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function renderUserTurn(text: string): string {
  return formatUserMessage(text)
}

/**
 * Map a successful edit/write tool result's metadata to a rendered change
 * block. Returns null when the metadata shape isn't recognized, letting the
 * caller fall back to the default tree-bracket tool result.
 *
 * Supported shapes (see src/native/tools/edit.ts, write.ts):
 * - edit             → { oldContext, newContext, contextStartLine, path }
 * - write create     → { created: true,  newContent, path }
 * - write overwrite  → { created: false, oldContent, newContent, path }
 */
function buildChangeBlockFromMetadata(
  name: string,
  durationMs: number,
  metadata: Record<string, unknown> | undefined,
): string | null {
  if (!metadata) return null
  const path = typeof metadata['path'] === 'string' ? (metadata['path'] as string) : null
  if (!path) return null
  const toolName = name === 'edit' || name === 'write' ? name : null
  if (!toolName) return null

  const changeKind = metadata['changeKind']

  if (toolName === 'edit' && changeKind === 'update') {
    const oldCtx = typeof metadata['oldContext'] === 'string' ? (metadata['oldContext'] as string) : null
    const newCtx = typeof metadata['newContext'] === 'string' ? (metadata['newContext'] as string) : null
    if (oldCtx === null || newCtx === null) return null
    const startLine = typeof metadata['contextStartLine'] === 'number'
      ? (metadata['contextStartLine'] as number)
      : 1
    const bodyLines = renderChangeBlockLines(oldCtx, newCtx, { startLine })
    const { added, removed } = countDiffStats(oldCtx, newCtx)
    return formatChangeBlockResult({
      toolName, action: 'update', path, added, removed, durationMs, bodyLines,
    })
  }

  if (toolName === 'write' && changeKind === 'create') {
    const newContent = typeof metadata['newContent'] === 'string' ? (metadata['newContent'] as string) : null
    if (newContent === null) return null
    const bodyLines = renderFileCreateLines(newContent)
    const added = newContent.length > 0 ? newContent.split('\n').length : 0
    return formatChangeBlockResult({
      toolName, action: 'create', path, added, removed: 0, durationMs, bodyLines,
    })
  }

  if (toolName === 'write' && changeKind === 'overwrite') {
    const oldContent = typeof metadata['oldContent'] === 'string' ? (metadata['oldContent'] as string) : null
    const newContent = typeof metadata['newContent'] === 'string' ? (metadata['newContent'] as string) : null
    if (oldContent === null || newContent === null) return null
    const bodyLines = renderChangeBlockLines(oldContent, newContent, { startLine: 1 })
    const { added, removed } = countDiffStats(oldContent, newContent)
    return formatChangeBlockResult({
      toolName, action: 'overwrite', path, added, removed, durationMs, bodyLines,
    })
  }

  return null
}

function clipLiveResponse(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= LIVE_RESPONSE_MAX_LINES) return text
  return lines.slice(-LIVE_RESPONSE_MAX_LINES).join('\n')
}

// selectVisibleTranscriptItems and estimateWrappedLineCount moved to repl-shared.ts

async function captureTerminalOutput<T>(
  fn: (output: SlashCommandOutput) => Promise<T>,
): Promise<{ result: T; text: string }> {
  const chunks: Array<{ text: string; transient: boolean }> = []
  const push = (value: unknown, options?: { transient?: boolean }): void => {
    if (typeof value === 'string') {
      chunks.push({ text: value, transient: options?.transient === true })
      return
    }
    if (Buffer.isBuffer(value)) {
      chunks.push({ text: value.toString('utf8'), transient: options?.transient === true })
      return
    }
    chunks.push({ text: String(value), transient: options?.transient === true })
  }

  const output: SlashCommandOutput = {
    write(text, options) {
      push(text, options)
    },
    clearTransient() {
      while (chunks.length > 0 && chunks[chunks.length - 1]?.transient) {
        chunks.pop()
      }
    },
  }

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  console.log = (...args: unknown[]) => {
    push(args.map((arg) => String(arg)).join(' ') + '\n')
  }
  console.warn = (...args: unknown[]) => {
    push(args.map((arg) => String(arg)).join(' ') + '\n')
  }
  console.error = (...args: unknown[]) => {
    push(args.map((arg) => String(arg)).join(' ') + '\n')
  }

  try {
    const result = await fn(output)
    return { result, text: normalizeCapturedOutput(chunks.map((chunk) => chunk.text).join('')) }
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }
}

function buildPermissionDialog(
  toolName: string,
  input: Record<string, unknown>,
  selectedIndex: number,
): string {
  switch (toolName) {
    case 'bash':
      return renderBashPermission(
        String(input['command'] ?? ''),
        typeof input['cwd'] === 'string' ? String(input['cwd']) : process.cwd(),
        selectedIndex,
      )
    case 'read':
      return renderFilePermission(String(input['path'] ?? ''), 'read', selectedIndex)
    case 'write':
      return renderFilePermission(String(input['path'] ?? ''), 'write', selectedIndex)
    case 'TaskContract':
      return renderInlinePermission(
        'Task contract',
        `Expand write scope: ${String(input['path'] ?? '')}`,
        selectedIndex,
      )
    case 'edit':
    case 'NotebookEdit':
      return renderFilePermission(String(input['path'] ?? ''), 'edit', selectedIndex)
    case 'WebFetch':
      return renderWebPermission(
        String(input['url'] ?? ''),
        typeof input['method'] === 'string' ? String(input['method']) : 'GET',
        selectedIndex,
      )
    default:
      return renderInlinePermission(toolName, JSON.stringify(input), selectedIndex)
  }
}

function buildPermissionCardProps(
  toolName: string,
  input: Record<string, unknown>,
  selectedIndex: number,
  columns: number,
): PermissionCardProps {
  const choices = PERMISSION_CHOICES.map((choice) => ({
    key: choice.key,
    label: choice.label,
    primary: choice.decision === 'deny',
  }))
  const base = {
    choices,
    selectedIndex,
    columns: Math.max(24, columns - 2),
  }

  switch (toolName) {
    case 'TaskContract':
      return {
        ...base,
        kind: 'write',
        action: 'Expand task contract write scope',
        target: String(input['path'] ?? ''),
        risk: 'This adds one path to the current task contract, then retries the blocked write.',
      }
    case 'bash': {
      const command = String(input['command'] ?? '')
      const risk = detectDestructiveCommand(command) ?? undefined
      return {
        ...base,
        kind: risk ? 'danger' : 'exec',
        action: 'Execute shell command',
        target: command,
        risk,
      }
    }
    case 'read':
      return {
        ...base,
        kind: 'read',
        action: 'Read file',
        target: String(input['path'] ?? ''),
      }
    case 'write':
      return {
        ...base,
        kind: 'write',
        action: 'Write file',
        target: String(input['path'] ?? ''),
      }
    case 'edit':
    case 'NotebookEdit':
      return {
        ...base,
        kind: 'write',
        action: 'Edit file',
        target: String(input['path'] ?? ''),
      }
    case 'WebFetch':
      return {
        ...base,
        kind: 'web',
        action: `${typeof input['method'] === 'string' ? String(input['method']) : 'GET'} request`,
        target: String(input['url'] ?? ''),
        risk: 'External network request',
      }
    default:
      return {
        ...base,
        kind: 'exec',
        action: toolName,
        target: JSON.stringify(input),
      }
  }
}

function countPermissionCardRows(props: PermissionCardProps): number {
  return 3 + (props.target ? 1 : 0) + (props.risk ? 1 : 0)
}

async function fetchModelPickerItems(
  opts: ReplOptions,
  currentModel: string,
): Promise<PickerItem<string>[]> {
  const res = await fetch(`${opts.apiBaseUrl}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    throw new Error(`Model list request failed: ${res.status}`)
  }
  const data = await res.json() as {
    data?: Array<{ id: string; display_name?: string; availability?: string }>
  }
  const models = (data.data ?? []).map((item) => ({
    id: item.id,
    availability: item.availability,
    displayName: item.display_name,
  }))
  const interactiveModels = models.filter((model) => isInteractiveChatModelName(model.id))
  const sourceModels = interactiveModels.length > 0 ? interactiveModels : models
  const usable = sourceModels.filter((model) => model.availability !== 'unavailable')
  const unavailable = sourceModels.filter((model) => model.availability === 'unavailable')

  // Per the design's model picker grid (oc-picker-item.model), each row
  // surfaces three signals: label, secondary descriptor (meta), and a
  // categorical pill (tag). For the proxy-fed model list we don't always
  // know ctx-window or per-token cost, so:
  //   - meta: `${availability}` (e.g. "available", "preview"), or empty
  //   - tag:  "current" for the active model, otherwise omit
  // When proxy responses start carrying ctx/cost we can backfill meta
  // here without touching the renderer.
  return [
    ...usable.map((model) => ({
      label: model.displayName ?? model.id,
      description: model.id !== model.displayName ? model.id : undefined,
      meta: model.availability ?? '',
      tag: model.id === currentModel ? 'current' : '',
      value: model.id,
    })),
    ...unavailable.map((model) => ({
      label: model.displayName ?? model.id,
      description: model.id !== model.displayName ? model.id : undefined,
      meta: 'unavailable',
      tag: '',
      value: model.id,
    })),
  ]
}

function buildThemePickerItems(): PickerItem<string>[] {
  const current = getThemeName()
  const descriptions: Record<string, string> = {
    dark: 'Night vision',
    light: 'Day palette',
    'ansi-dark': 'Terminal-safe dark',
    'ansi-light': 'Terminal-safe light',
    'dark-daltonized': 'Colorblind-friendly dark',
    'light-daltonized': 'Colorblind-friendly light',
  }

  return THEME_NAMES.map((name) => ({
    label: name,
    description: name === current ? `(active) ${descriptions[name] ?? ''}`.trim() : descriptions[name],
    value: name,
  }))
}

function useSpinnerFrame(active: boolean, intervalMs: number): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => {
      setFrame((current) => current + 1)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])

  return frame
}

function buildWelcomeEntries(
  conversation: Conversation,
  preflightOk: boolean,
  columns: number,
): TranscriptItem[] {
  const interactionCapability = getTranscriptInteractionCapability()
  const recentSessions = listSessions()
  const isFirstRun = recentSessions.length === 0
  const items: TranscriptItem[] = [
    {
      id: nextId('banner'),
      text: formatBanner({
        version: `${VERSION} (${buildTag()})`,
        model: conversation.model,
        mode: 'native',
        sessionId: conversation.id,
        cwd: process.cwd(),
        columns,
        isFirstRun,
      }),
    },
  ]

  if (!preflightOk) {
    items.push({
      id: nextId('preflight'),
      text: `${themeColor('warning')}⚠ Cannot reach proxy at ${process.env['OWLCODA_API_BASE_URL'] ?? ''}${sgr.reset}\n${dim('  Requests may fail until the proxy is reachable.')}`,
    })
  }

  items.push({
    id: nextId('welcome-marker'),
    text: formatWelcomeMarker(readWelcomeMarkerOptions(process.cwd())),
  })

  if (interactionCapability.startupNotice) {
    items.push({
      id: nextId('interaction'),
      text: `${themeColor('warning')}⚠ ${interactionCapability.startupNotice}${sgr.reset}`,
    })
  }

  return items
}

function buildResumedTranscriptEntries(conversation: Conversation): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const turn of conversation.turns) {
    for (const block of turn.content) {
      const b = block as unknown as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const textValue = b.text
        // Injected system nudges (e.g. tool-only-turn reminders) are synthetic
        // text blocks we add to user-role turns to guide the model. They are
        // NOT user input. Rendering them as user blocks makes past sessions
        // look like the user typed system instructions to themselves.
        if (isSystemNudgeText(textValue)) {
          items.push({
            id: nextId('resumed-system'),
            text: `  ${dim('[system hint]')} ${dim(textValue.replace(/^\[System:\s*/, '').replace(/\]$/, ''))}`,
          })
          continue
        }
        if (turn.role === 'user') {
          items.push({ id: nextId('resumed'), text: formatUserMessage(textValue) })
        } else {
          const prefix = dim('⎿ ')
          const indent = '  '
          const lines = textValue.split('\n')
          const formatted = lines.map((line, i) => i === 0 ? prefix + line : indent + line).join('\n')
          items.push({ id: nextId('resumed'), text: formatted })
        }
      }
    }
  }
  if (items.length > 0) {
    items.unshift({ id: nextId('resumed'), text: dim(`  ── Resumed session (${conversation.turns.length} turns) ──`) })
  }
  return items
}

function isSystemNudgeText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('[System:') && trimmed.endsWith(']')
}

const EMPTY_LOOP_NOISE_STATE: LoopNoiseState = {
  trimCount: 0,
  nudgeCount: 0,
  repairCount: 0,
  summaryGateCount: 0,
  compactionCount: 0,
  targetedCheckCount: 0,
  synthesisCount: 0,
  fallbackSynthesisCount: 0,
  hardStopCount: 0,
  constrainedContinuationCount: 0,
}

// Factory rather than a constant because ComposeState carries a mutable Set —
// sharing one Set across init + reset would cross-contaminate turns. Parallel
// to EMPTY_LOOP_NOISE_STATE for shape-consistency discipline: two call sites
// (useRef init + finally reset) go through this single factory so the shape
// cannot drift between them.
const freshComposeState = (): ComposeState => ({
  seenAnchors: new Set<AnchorTier>(),
  leftover: '',
})

function useLazyRef<T>(factory: () => T): React.MutableRefObject<T> {
  const ref = useRef<T | null>(null)
  if (ref.current === null) {
    ref.current = factory()
  }
  return ref as React.MutableRefObject<T>
}

function NativeReplApp({
  conversation,
  dispatcher,
  mcpManager,
  opts,
  isResumed,
  usage,
  preflightOk,
}: NativeReplAppProps): React.ReactElement {
  const traceInputLatency = isInputLatencyTraceEnabled()
  if (traceInputLatency) traceInputLatencyCheckpoint('native-repl-render-start')
  const { exit } = useApp()
  const stdout = process.stdout
  const initialTranscriptCols = Math.max(1, (stdout.columns || 80) - 2)

  const runtimeRef = useLazyRef<ReplRuntimeState>(createReplRuntimeState)
  const configRef = useLazyRef(loadConfig)
  const lowChurnTerminalMode = useMemo(() => usesLowChurnTerminalMode(), [])
  const activeAbortRef = useRef<AbortController | null>(null)
  // Git branch read once at mount (cwd doesn't change for the REPL's
  // lifetime). The rail's `branch` cell drops when the value is null,
  // so cwds that aren't git repos render the rail without that slot.
  const gitBranchRef = useLazyRef<string | null>(() => readWelcomeMarkerOptions().branch ?? null)
  const thinkingStateRef = useRef<ThinkingState>({ mode: 'collapsed', lastThinking: '' })
  // Default SAFE: destructive tools (bash, write, edit, …) prompt for
  // confirmation the first time they fire. User flagged the old behavior
  // — OwlCoda was silently executing every tool call with no prompt —
  // as "never asks me anything", which matches the code: `autoApprove`
  // used to default to `true`, making every call bypass the permission
  // dialog via the short-circuit in requestToolApproval.
  //
  // Opt out for supervised/CI use via OWLCODA_AUTO_APPROVE=1 (or "yolo",
  // "yes", "true"). `/approve on` still flips it at runtime. SAFE_TOOLS
  // (read-only ops like read / glob / grep) always auto-pass regardless
  // of this flag, so normal exploration stays friction-free.
  const approveStateRef = useRef<ApproveState>({
    // Reconcile the mirror with the initial mode: `--mode yolo` must auto-approve
    // from the first turn, not just after the user re-toggles it (startup desync).
    autoApprove: resolveInitialAutoApprove(opts.mode, process.env['OWLCODA_AUTO_APPROVE']),
  })
  const pendingSlashSideEffectRef = useRef<SlashCommandSideEffect | null>(null)
  // Stable ref that always points to the current handleSubmit. Used by
  // runCapturedSlashCommand to call handleSubmit without creating a
  // forward-reference cycle (handleSubmit is defined later in the same
  // component but depends on runCapturedSlashCommand via handleSlashSubmit).
  const handleSubmitRef = useRef<((value: string) => Promise<void>) | null>(null)
  // Publish the ref's current object so the Config tool (and any future
  // headless surface) can flip `autoApprove` programmatically. Mutating
  // this object directly is fine — useRef hands back the same reference
  // every render — and the rail re-reads it via the `uiVersion`-keyed
  // useMemo, which gets bumped on every tool-end and slash-command return.
  liveApproveState = approveStateRef.current
  const batchApproveAllRef = useRef(false)
  const perToolApproveRef = useRef<Set<string>>(conversation.options?.alwaysApprove ?? new Set<string>())
  const liveResponseRef = useRef('')
  const hasShownAssistantHeaderRef = useRef(false)
  // Tool input stashed at onToolStart so the merged action+result group can
  // render the command summary on completion (chrome spec S2).
  const pendingToolInputRef = useRef(new Map<string, Record<string, unknown>>())
  const toolCollectorRef = useRef(new ToolResultCollector())
  const mdRendererRef = useRef(new StreamingMarkdownRenderer())
  const lastExitAttemptRef = useRef(0)
  const taskStartMsRef = useRef(0)
  // Wall-clock of the last concrete progress event — tokens arriving,
  // tool progress ticks, tool start/end, response finalized, retry
  // scheduled. Drives the inline status line's "idle Xs" suffix so the
  // user can tell whether the loop is still actively producing output
  // (fresh timestamp, no suffix) or silently waiting (old timestamp,
  // suffix grows). Re-rendered by the existing spinner-frame interval;
  // no dedicated timer.
  const lastProgressAtRef = useRef(0)
  // Signature of the last tool-progress payload so we can distinguish
  // a real stdout/stderr advance from bash's 250ms heartbeat tick.
  // Bash's onProgress fires every 250ms regardless of activity (so
  // callers can animate spinners etc.); treating every tick as real
  // progress hides genuine stalls — a silent `sleep 60` would keep
  // resetting lastProgressAtRef every 250ms and never accumulate idle.
  const lastToolProgressSigRef = useRef('')
  const isMountedRef = useRef(true)
  // 0.14.0: single-slot queuedInputRef replaced by typed-buffer SubmissionQueue
  // (4-slot FIFO, ring-buffer overflow). Pre-0.14.0 single-slot semantics
  // dropped the FIRST queued prompt silently when a second arrived while
  // the turn was running. New: up to 4 pending submissions; on 5th, OLDEST
  // is dropped + footer signal. See submission-queue.ts for full contract.
  const submissionQueueRef = useRef(new SubmissionQueue())
  // Held-notice gate: once we've told the user "your queued input is held
  // pending failure recovery", don't re-spam on each subsequent failure.
  // Cleared when queue actually drains or /clear discards.
  const queueHeldNoticeShownRef = useRef<boolean>(false)
  const clearEpochRef = useRef(0)
  // Refs are initialized from conversation.options.pendingRetry on FIRST
  // render only (useRef's initial value is captured once per mount — the
  // previous version ran a hydrate block on every render, which did nothing
  // after the first pass but cost a reference comparison + options read per
  // render, multiplied by every keystroke and spinner tick. Lazy init here
  // runs exactly once.)
  const retryEligibleContinuationFailureRef = useRef<ConversationRuntimeFailure | null>(
    conversation.options?.pendingRetry ? hydrateRetryFailureStub() : null,
  )
  const retryingFailedContinuationRef = useRef(false)
  const failedContinuationAttemptCountRef = useRef(
    conversation.options?.pendingRetry?.attemptCount ?? 0,
  )
  const runtimeAutoRetryCountRef = useRef(0)
  // 0.13.63 (C): rolling window of recent auto-retry failure kinds.
  // shouldScheduleRuntimeAutoRetry uses this to short-circuit the 3rd
  // consecutive same-kind retry (e.g. 3 timeouts in a row → stop, ask
  // user). Reset alongside runtimeAutoRetryCountRef.
  const recentRetryKindsRef = useRef<string[]>([])
  const scheduledAutoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 0.13.99: SubmissionGuard. Three-state interlock (idle / dispatching /
  // running) + generation counter, co-existing with isLoading (UI state),
  // runtimeRef.activeTask (task execution detail), and outputGateToken
  // (stream-write race). Guard is the single source of truth for "is a
  // turn lifecycle slot owned right now and by which generation".
  // runConversationTurn entry calls tryStart, finally calls end(gen);
  // /clear and Ctrl+C call forceEnd. See submission-guard.ts for the
  // full contract and rationale.
  const submissionGuardRef = useRef(new SubmissionGuard())
  // Resume continuation (resume bug fix). A session restored from disk that
  // ends with an unanswered user turn — the "interrupted a tool loop, typed a
  // message, quit before the assistant replied" shape — used to resume silent.
  // The mount effect auto-continues it once; this ref guards against a double
  // fire (StrictMode remount / effect re-run).
  const resumeContinuationFiredRef = useRef(false)
  const loopNoiseStateRef = useRef<LoopNoiseState>({ ...EMPTY_LOOP_NOISE_STATE })
  const pseudoToolCallElidedRef = useRef({ elided: false })
  const composeStateRef = useRef<ComposeState>(freshComposeState())

  if (!conversation.options) {
    conversation.options = {}
  }
  conversation.options.alwaysApprove = perToolApproveRef.current
  // Note: loadPermissions() used to run here on every render. On a fast
  // spinner / streaming assistant it fired 10-60 times/sec, each call
  // doing readFileSync + JSON.parse on ~/.owlcoda/permissions.json. That
  // was a major contributor to "OwlCoda feels sluggish". Moved into a
  // mount-only useEffect below (hooks initializer runs only at mount).

  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>(() => {
    const welcome = buildWelcomeEntries(conversation, preflightOk, initialTranscriptCols)
    if (isResumed && conversation.turns.length > 0) {
      return [...welcome, ...buildResumedTranscriptEntries(conversation)]
    }
    return welcome
  })
  const [inputValue, setInputValue] = useState('')
  const pasteStoreRef = useRef(createPasteStore())
  const pasteBurstRef = useRef(createBurstState())
  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1) // -1 = not browsing history
  const draftRef = useRef('') // preserves unsent draft while browsing history
  const [overlay, setOverlayRaw] = useState<OverlayState | null>(null)

  // Wrapped setOverlay that also clears input when opening an overlay
  const setOverlay = useCallback((next: OverlayState | null) => {
    setOverlayRaw(next)
  }, [])
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPrompt | null>(null)
  // Highlighted option in the permission dialog. Default to Deny (index 1)
  // rather than Allow — safer "Enter alone just confirms Deny". User
  // explicitly changes via ↑/↓ or 1/2/3 before hitting Enter. Y/N/A
  // letter keys also work as immediate-decide shortcuts (no arrow-key
  // dance needed for the common case).
  const [permissionChoiceIndex, setPermissionChoiceIndex] = useState(1)
  const [questionPrompt, setQuestionPrompt] = useState<QuestionPrompt | null>(null)
  const [liveResponseText, setLiveResponseText] = useState('')
  const [spinnerState, setSpinnerState] = useState<SpinnerState | null>(null)
  const [footerNotice, setFooterNotice] = useState<string | null>(null)
  const [workflowPhase, setWorkflowPhase] = useState<
    'targeted_check' | 'synthesizing' | 'fallback_synthesizing' | 'hard_stop' | null
  >(null)
  const [isLoading, setIsLoading] = useState(false)
  const scrollRef = useRef<ScrollHandle>(null)
  const [cursorOffset, setCursorOffset] = useState(0)
  // setUiVersion forces a re-render from async paths. Most consumers only
  // need the bump effect, but cells whose source-of-truth lives in a ref
  // (e.g. the rail's YOLO indicator from approveStateRef) read uiVersion
  // through a useMemo dep so the cell re-renders when state outside React
  // is mutated by a slash command.
  const [uiVersion, setUiVersion] = useState(0)
  const spinnerFrame = useSpinnerFrame(isLoading, lowChurnTerminalMode ? 1000 : 250)
  if (traceInputLatency) {
    traceInputLatencyCheckpoint('native-repl-after-state-hooks', {
      inputLength: inputValue.length,
      transcriptItems: transcriptItems.length,
      isLoading,
    })
  }

  const appendTranscript = useCallback((
    text: string,
    options: { overflowAnchor?: TranscriptItem['overflowAnchor'] } = {},
  ): void => {
    // Collapse 3+ consecutive newlines into 2 (a single blank line).
    // Models that over-format their prose — extra paragraph breaks, stacked
    // blank lines between list items, trailing empty rows before the closing
    // sentence — push the transcript apart vertically and waste visible
    // viewport budget. One blank line is plenty of paragraph break.
    // Uses only \n run-lengths, not content — markdown paragraph semantics
    // are preserved (every logical paragraph still gets exactly one blank
    // row between it and the next).
    const collapsed = text.replace(/\n{3,}/g, '\n\n')
    const normalized = collapsed.trimEnd()
    if (!normalized) return
    const appendWidth = Math.max(1, stdout.columns || 80)
    const chunks = splitTranscriptAppendText(normalized, options.overflowAnchor, appendWidth)
    setTranscriptItems((items) => [
      ...items,
      ...chunks.map((chunk) => ({
        id: nextId('log'),
        text: chunk.text,
        overflowAnchor: chunk.overflowAnchor,
      })),
    ])
    // ScrollableTranscript auto-follows when sticky (at live position).
    // No manual scroll management needed here.
  }, [])

  // safeRender variant that persists first-hand evidence when the markdown
  // render path throws: the silent fallback prints RAW markdown, which is
  // exactly the corruption users report — make it leave a trace.
  const safeRenderWithIncident = useCallback((fn: () => string, fallback = ''): string => {
    try {
      return fn()
    } catch (err) {
      const incidentPath = dumpRenderIncident(err)
      if (incidentPath) {
        appendTranscript(renderNotice(`markdown render error — incident saved: ${incidentPath}`, 'warning'))
      }
      return fallback
    }
  }, [appendTranscript])

  const flushLiveResponse = useCallback((): void => {
    const buffered = liveResponseRef.current.trimEnd()
    if (!buffered) return
    liveResponseRef.current = ''
    hasShownAssistantHeaderRef.current = false
    setLiveResponseText('')
    appendTranscript(buffered, { overflowAnchor: 'tail' })
  }, [appendTranscript])

  const appendRenderedLiveResponse = useCallback((rendered: string): void => {
    if (!rendered) return
    // Chrome spec S2: narration gets the ● gutter (⎿ is reserved for tool
    // output) and the chrome layer wraps with a hanging indent so terminal
    // hard-wrap never lands continuations at col 0.
    const narrated = renderNarration(rendered, {
      firstBlock: !hasShownAssistantHeaderRef.current,
      columns: Math.max(1, stdout.columns || 80),
    })
    if (/\S/.test(stripAnsi(narrated))) hasShownAssistantHeaderRef.current = true
    liveResponseRef.current += narrated
  }, [])

  const flushBufferedAssistantResponse = useCallback((): void => {
    drainAssistantStreamBoundary({
      composeState: composeStateRef.current,
      renderer: mdRendererRef.current,
      appendRendered: appendRenderedLiveResponse,
      safeRender: safeRenderWithIncident,
    })
    flushLiveResponse()
  }, [appendRenderedLiveResponse, flushLiveResponse, safeRenderWithIncident])

  const syncPendingRetry = useCallback((
    canRetry: boolean,
    attemptCount: number,
  ): void => {
    if (!conversation.options) conversation.options = {}
    if (canRetry) {
      conversation.options.pendingRetry = { attemptCount }
    } else {
      delete conversation.options.pendingRetry
    }
  }, [conversation])

  const clearScheduledAutoRetry = useCallback((): void => {
    if (scheduledAutoRetryTimerRef.current) {
      clearTimeout(scheduledAutoRetryTimerRef.current)
      scheduledAutoRetryTimerRef.current = null
    }
  }, [])

  const clearRetryContinuationState = useCallback((): void => {
    retryEligibleContinuationFailureRef.current = null
    failedContinuationAttemptCountRef.current = 0
    runtimeAutoRetryCountRef.current = 0
    recentRetryKindsRef.current = []
    syncPendingRetry(false, 0)
  }, [syncPendingRetry])

  useEffect(() => {
    return () => {
      clearScheduledAutoRetry()
      isMountedRef.current = false
    }
  }, [clearScheduledAutoRetry])

  // Load the persisted "always-approved tools" list ONCE at mount — not on
  // every render. Previous version called loadPermissions() synchronously
  // in the function body (see removed block above), which hit the disk on
  // every keystroke / spinner tick / transcript append, orders of magnitude
  // more than necessary.
  useEffect(() => {
    for (const toolName of loadPermissions()) {
      perToolApproveRef.current.add(toolName)
    }
  }, [])

  // Wire capability-driven picker isolation. Any call to showPicker (from
  // slash commands, workbench, or future surfaces) now automatically pauses
  // Ink, takes alt-screen, and hands the frame back on exit. The previous
  // whitelist approach (PICKER_SLASH_COMMANDS) is retired.
  useEffect(() => {
    const app = inkAppForSlashCommands
    if (!app) return
    registerPickerIsolation({
      enter: () => app.enterAlternateScreen(),
      exit: () => app.exitAlternateScreen(),
    })
    return () => { registerPickerIsolation(null) }
  }, [])

  // Mouse stays terminal-native in the main REPL so transcript selection
  // and copy work across terminals without app-side mouse tracking.

  useEffect(() => {
    let cancelled = false
    void mcpManager.connectAll().then((states) => {
      if (cancelled || !isMountedRef.current) return
      const connected = states.filter((state) => state.status === 'connected')
      if (connected.length > 0) {
        const names = connected.map((state) => state.name).join(', ')
        const toolCount = connected.reduce((count, state) => count + state.tools.length, 0)
        appendTranscript(`  ${themeColor('success')}✓ MCP: ${connected.length} server${connected.length > 1 ? 's' : ''} connected (${toolCount} tools) — ${names}${sgr.reset}`)
      }
      for (const state of states.filter((item) => item.status === 'error')) {
        appendTranscript(`  ${themeColor('warning')}⚠ MCP "${state.name}": ${state.error?.split('\n')[0] ?? 'failed'}${sgr.reset}`)
      }
    }).catch((err) => {
      // MCP-level failure (not a per-server error — whole connectAll threw).
      // Previously swallowed; now surface so the user knows MCP integration
      // is broken rather than "seems disabled for some reason".
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      appendTranscript(`  ${themeColor('warning')}⚠ MCP: connectAll failed — ${msg}${sgr.reset}`)
    })
    return () => {
      cancelled = true
    }
  }, [appendTranscript, mcpManager])

  useEffect(() => {
    if (!footerNotice) return
    const timer = setTimeout(() => {
      setFooterNotice((current) => (current === footerNotice ? null : current))
    }, 1800)
    return () => clearTimeout(timer)
  }, [footerNotice])

  // Spinner state drives the inline status line in the transcript area.

  const requestToolApproval = useCallback(async (toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    const decision = decideTuiToolApproval({
      toolName,
      input,
      autoApprove: approveStateRef.current.autoApprove,
      batchApproveAll: batchApproveAllRef.current,
      perToolApprove: perToolApproveRef.current,
      safeTools: SAFE_TOOLS,
    })
    if (decision.action === 'allow') return true

    // autoDeny short-circuits the prompt to a structured deny without
    // awaiting user input. Useful for autonomous QA flows that need to
    // verify dangerous commands actually go through the safety gate
    // (the tool result will be "Tool execution denied by user." rather
    // than silent execution). Mutually exclusive with autoApprove —
    // autoApprove already short-circuited above when it was on.
    if (approveStateRef.current.autoDeny) {
      const echo = `  ${dim(`↳ Denied (autoDeny on): ${toolName}`)}`
      appendTranscript(echo)
      return false
    }

    return await new Promise<boolean>((resolve) => {
      // Fresh prompt always opens with Deny (index 1) highlighted — user
      // must explicitly move to Allow before confirming. Previously the
      // highlight persisted across prompts which meant if you used
      // Arrow-Up-Enter to allow a previous call, the next call opened
      // pre-highlighted on Allow too. Re-prime defensively.
      setPermissionChoiceIndex(1)
      setPermissionPrompt({ toolName, input, resolve })
    })
  }, [])

  const requestTaskScopeApproval = useCallback(async (request: {
    toolName: string
    input: Record<string, unknown>
    attemptedPath: string
    attemptedPaths: string[]
    allowedPaths: string[]
    message: string
  }): Promise<boolean> => {
    const scopeDecision = decideTuiTaskScopeApproval({
      autoApprove: approveStateRef.current.autoApprove,
      batchApproveAll: batchApproveAllRef.current,
    })
    if (scopeDecision.action === 'allow') {
      return true
    }
    if (approveStateRef.current.autoDeny) {
      appendTranscript(`  ${dim(`↳ Denied (autoDeny on): TaskContract`)}`)
      return false
    }
    return await new Promise<boolean>((resolve) => {
      setPermissionChoiceIndex(1)
      setPermissionPrompt({
        toolName: 'TaskContract',
        input: {
          path: request.attemptedPath,
          paths: request.attemptedPaths,
          toolName: request.toolName,
          allowedPaths: request.allowedPaths,
        },
        resolve,
      })
    })
  }, [])

  /**
   * Host-side implementation of ConversationCallbacks.onUserQuestion.
   * Renders the question into the transcript once (so it's part of
   * permanent history) and sets questionPrompt state — handleSubmit
   * routes the next Enter-submit to resolve(answer) instead of a new
   * conversation turn. Ctrl+C while a question is active resolves
   * with empty string (= cancelled, matched in ask-user.ts).
   *
   * INVARIANT: this callback writes to transcript via appendTranscript
   * (React state update), not process.stdout.write — keeps the
   * per-frame single-stdout-write contract intact.
   */
  const requestUserQuestion = useCallback(async (
    toolName: string,
    question: string,
    opts?: { options?: Array<{ label: string; description?: string }>; multiSelect?: boolean },
  ): Promise<string> => {
    const options = opts?.options
    const multiSelect = opts?.multiSelect ?? false
    const lines: string[] = [`${themeColor('info')}📋 ${question}${sgr.reset}`]
    if (options && options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        const o = options[i]!
        lines.push(`  ${themeColor('owl')}${i + 1})${sgr.reset} ${o.label}`)
        if (o.description) lines.push(`     ${dim(o.description)}`)
      }
      lines.push(dim(multiSelect
        ? '  Type a number, numbers separated by commas, or a free-form answer.'
        : '  Type a number or a free-form answer.'))
    } else {
      lines.push(dim('  Type your answer and press Enter.'))
    }
    appendTranscript(lines.join('\n'))
    return await new Promise<string>((resolve) => {
      setQuestionPrompt({ toolName, options, multiSelect, resolve })
    })
  }, [appendTranscript])

  const callbacksRef = useRef<ConversationCallbacks | null>(null)
  if (!callbacksRef.current) {
    const prefixResponse = (rendered: string): string => {
      if (!rendered) return ''
      // Chrome spec S2: narration ● gutter + hanging-indent wrap (see
      // appendRenderedLiveResponse — same vocabulary, same state).
      const narrated = renderNarration(rendered, {
        firstBlock: !hasShownAssistantHeaderRef.current,
        columns: Math.max(1, stdout.columns || 80),
      })
      if (/\S/.test(stripAnsi(narrated))) hasShownAssistantHeaderRef.current = true
      return narrated
    }

    const bumpProgress = (): void => {
      lastProgressAtRef.current = Date.now()
    }

    callbacksRef.current = {
      onText(text) {
        const scrubbed = scrubPseudoToolCall(text, pseudoToolCallElidedRef.current)
        if (!scrubbed.trim()) return
        bumpProgress()
        if (toolCollectorRef.current.pending > 0) {
          appendTranscript(toolCollectorRef.current.flush())
        }
        setSpinnerState(null)
        const composed = composeAssistantChunk(scrubbed, composeStateRef.current)
        // Render incident capture: keep the raw chunk so a render-path throw
        // (which falls back to printing RAW markdown) leaves first-hand
        // evidence instead of a silent visual mess.
        recordRawMdChunk(composed)
        const rendered = safeRenderWithIncident(() => mdRendererRef.current.push(composed), composed)
        if (!rendered) return
        // Streaming progressive commit. mdRenderer.push returns only complete
        // \n-terminated logical lines (the partial in-progress line stays
        // buffered inside the renderer). Commit those directly to the
        // scrollable transcript so the user sees the answer grow line by
        // line. Previously this accumulated into liveResponseRef, was
        // clipped to LIVE_RESPONSE_MAX_LINES (=10) for the live preview,
        // and only commit-as-a-whole on response end — so long answers
        // were invisible mid-stream and dumped all at once at completion.
        // Composer leftover (trailing partial sentence with no \n) is drained
        // at tool and turn boundaries by flushBufferedAssistantResponse.
        const prefixed = prefixResponse(rendered)
        if (prefixed) appendTranscript(prefixed, { overflowAnchor: 'tail' })
      },
      onToolStart(name, input) {
        bumpProgress()
        lastToolProgressSigRef.current = ''
        // A tool call is a logical boundary in the assistant stream. Drain the
        // no-newline tail here so post-tool narration cannot glue onto it and
        // flush out of order at turn end.
        flushBufferedAssistantResponse()
        if (!toolCollectorRef.current.isCollapsible(name) && toolCollectorRef.current.pending > 0) {
          appendTranscript(toolCollectorRef.current.flush())
        }
        if (shouldRouteToolStartFooterOnly(name)) {
          setFooterNotice(formatFooterOnlyToolStart(name))
          setSpinnerState({ mode: 'tool', toolName: name, message: 'Running…' })
          return
        }
        // Chrome spec S2: the action row commits MERGED with its result on
        // completion (formatToolGroup in onToolEnd). While running, the live
        // region's spinner carries the tool identity — no premature commit.
        pendingToolInputRef.current.set(name, input)
        setSpinnerState({ mode: 'tool', toolName: name, message: 'Running…' })
      },
      onToolEnd(name, result, isError, durationMs, metadata) {
        bumpProgress()
        setSpinnerState(null)
        // Chrome spec S1: record the full output before any collapse so
        // /expand can always recall what the fold line hid.
        if (result.length > 0) recordFullToolOutput(name, result, isError)
        const changeBlock = !isError ? buildChangeBlockFromMetadata(name, durationMs, metadata) : null
        if (changeBlock) {
          appendTranscript(changeBlock)
          return
        }
        if (shouldRouteToolEndFooterOnly(name, isError)) {
          setFooterNotice(formatFooterOnlyToolEnd(name, durationMs))
          return
        }
        const pendingInput = pendingToolInputRef.current.get(name) ?? {}
        pendingToolInputRef.current.delete(name)
        if (toolCollectorRef.current.isCollapsible(name) && !isError) {
          toolCollectorRef.current.add({ name, input: pendingInput, output: result, isError, durationMs })
          return
        }
        // Chrome spec S2: action + result commit as ONE group (▸ verb arg
        // ✓ dur header + ⎿ body). Errors are the same shape with ✗ — the
        // ╴╴╴ box family stays retired.
        appendTranscript(formatToolGroup(name, pendingInput, result, isError, durationMs))
      },
      onToolProgress(name, event) {
        // Heartbeat vs real advance: bash fires onProgress every 250ms
        // even when the child is silent. Only count it as progress
        // (bumping the idle clock) when the output signature actually
        // moves — otherwise a quiet `sleep 60` would perpetually reset
        // the idle suffix and hide the stall from the user.
        const signature = `${event.totalLines}:${event.totalBytes}`
        if (signature !== lastToolProgressSigRef.current) {
          lastToolProgressSigRef.current = signature
          bumpProgress()
        }
        const lastLine = event.lines.length > 0 ? event.lines[event.lines.length - 1] : 'Running…'
        setSpinnerState({
          mode: 'tool',
          toolName: name,
          message: `${lastLine} (${event.totalLines} lines)`,
        })
      },
      onError(error) {
        setSpinnerState(null)
        appendTranscript(formatError(parseApiError(error)))
      },
      onNotice(message) {
        const routed = routeConversationNotice(message, loopNoiseStateRef.current)
        loopNoiseStateRef.current = routed.nextState
        if (routed.transcriptEntry !== null) appendTranscript(routed.transcriptEntry)
        if (routed.footerNotice !== null) setFooterNotice(routed.footerNotice)
        if (routed.workflowPhase !== undefined) setWorkflowPhase(routed.workflowPhase)
      },
      onRetry(info) {
        bumpProgress()
        setSpinnerState({ mode: 'busy', message: `Retrying in ${Math.ceil(info.delayMs / 1000)}s…` })
      },
      onThinking(event, text) {
        if (event === 'start') {
          thinkingStateRef.current.lastThinking = ''
          return
        }
        if (event === 'delta' && text) {
          bumpProgress()
          thinkingStateRef.current.lastThinking += text
        }
      },
      onToolApproval: requestToolApproval,
      onTaskScopeApproval: requestTaskScopeApproval,
      onUserQuestion: requestUserQuestion,
    }
  }

  const handlePermissionDecision = useCallback((decision: 'allow' | 'deny' | 'always' | 'all') => {
    if (!permissionPrompt) return
    const toolDisplay = permissionPrompt.toolName
    // Persist/compare under the canonical name so a wrong-case "Bash" [A]lways
    // grant matches the canonicalized read side (decideTuiToolApproval) in the
    // same session — not only after a disk reload via loadPermissions.
    const canonName = canonicalToolName(permissionPrompt.toolName)

    // Demote `[A] Always` and `[A] All` to `[Y] Allow once` when the
    // current prompt is for a dangerous bash/TaskCreate command. The
    // dangerous-override at decideTuiToolApproval re-prompts on every
    // dangerous call regardless of perToolApprove membership, so promoting
    // bash to globalApprove via this prompt is functionally a no-op for
    // safety — but it's a real footgun: a user who hits [A] on a
    // `rm -rf /` prompt thinks they've globally approved bash, when in
    // practice the next dangerous call will re-prompt anyway. Hostile-QA
    // against 0.13.40 saw exactly this confusion (every dangerous bash
    // showed `↳ Allowed (always for this tool): bash` because operators
    // hit Always thinking that's the "make it stop asking" option).
    let effectiveDecision: 'allow' | 'deny' | 'always' | 'all' = decision
    if ((decision === 'always' || decision === 'all')
        && (canonName === 'bash' || canonName === 'TaskCreate')) {
      const cmd = permissionPrompt.input?.['command']
      if (typeof cmd === 'string' && cmd.length > 0) {
        const verdict = classifyBashCommand(cmd)
        if (verdict.level === 'dangerous') {
          effectiveDecision = 'allow'
        }
      }
    }

    if (permissionPrompt.toolName === 'TaskContract') {
      permissionPrompt.resolve(effectiveDecision !== 'deny')
    } else if (effectiveDecision === 'always') {
      perToolApproveRef.current.add(canonName)
      addGlobalPermission(canonName)
      permissionPrompt.resolve(true)
    } else if (effectiveDecision === 'all') {
      batchApproveAllRef.current = true
      permissionPrompt.resolve(true)
    } else {
      permissionPrompt.resolve(effectiveDecision === 'allow')
    }
    setPermissionPrompt(null)
    setPermissionChoiceIndex(1)
    setUiVersion((value) => value + 1)
    const downgraded = effectiveDecision !== decision
    const verb = permissionPrompt.toolName === 'TaskContract' && effectiveDecision === 'always' ? 'Allowed'
      : effectiveDecision === 'allow'
        ? (downgraded ? 'Allowed once (Always demoted: dangerous command)' : 'Allowed')
      : effectiveDecision === 'deny' ? 'Denied'
      : effectiveDecision === 'always' ? 'Allowed (always for this tool)'
      : 'Allowed (rest of this turn)'
    setFooterNotice(dim(`↳ ${verb}: ${toolDisplay}`))
  }, [permissionPrompt])

  const withTaskCallbacks = useCallback((
    base: ConversationCallbacks,
    runtime: ReplRuntimeState,
    task: ReplTaskState,
  ): ConversationCallbacks => {
    const canWrite = (): boolean => canWriteTaskOutput(runtime, task)

    return {
      onText(text) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'awaiting_model')
        base.onText?.(text)
        setUiVersion((value) => value + 1)
      },
      onToolStart(toolName, input) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'tool_execution', toolName)
        base.onToolStart?.(toolName, input)
        setUiVersion((value) => value + 1)
      },
      onToolEnd(toolName, result, isError, durationMs, metadata) {
        if (!canWrite()) return
        base.onToolEnd?.(toolName, result, isError, durationMs, metadata)
        if (!task.aborted) {
          setReplTaskPhase(runtime, task, 'awaiting_model')
        }
        setUiVersion((value) => value + 1)
      },
      onToolProgress(toolName, event) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'tool_execution', toolName)
        base.onToolProgress?.(toolName, event)
      },
      onResponse(response) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'awaiting_model')
        base.onResponse?.(response)
      },
      onError(error) {
        if (!canWrite() && task.aborted) return
        base.onError?.(error)
      },
      onNotice(message) {
        if (!canWrite()) return
        base.onNotice?.(message)
      },
      onUsage(tokens) {
        if (!canWrite()) return
        base.onUsage?.(tokens)
      },
      onRetry(info) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'awaiting_model')
        base.onRetry?.(info)
      },
      onToolApproval: async (toolName, input) => {
        if (!canWrite()) return false
        setReplTaskPhase(runtime, task, 'tool_execution', toolName)
        return await (base.onToolApproval ? base.onToolApproval(toolName, input) : Promise.resolve(true))
      },
      onTaskScopeApproval: async (request) => {
        if (!canWrite()) return false
        setReplTaskPhase(runtime, task, 'tool_execution', request.toolName)
        return await (base.onTaskScopeApproval ? base.onTaskScopeApproval(request) : Promise.resolve(false))
      },
      onUserQuestion: async (toolName, question, opts) => {
        if (!canWrite()) return ''
        setReplTaskPhase(runtime, task, 'tool_execution', toolName)
        return await (base.onUserQuestion
          ? base.onUserQuestion(toolName, question, opts)
          : Promise.resolve(''))
      },
      onThinking(event, text) {
        if (!canWrite()) return
        setReplTaskPhase(runtime, task, 'awaiting_model')
        base.onThinking?.(event, text)
      },
      onAutoCompact(info) {
        if (!canWrite()) return
        base.onAutoCompact?.(info)
      },
    }
  }, [])

  const runConversationTurn = useCallback(async (
    request: { kind: 'user_turn'; input: string } | {
      kind: 'retry_failed_continuation'
      failure: ConversationRuntimeFailure
    } | { kind: 'resume_continuation' },
  ): Promise<boolean> => {
    // 0.13.99 SubmissionGuard: atomic check-and-set "is a turn lifecycle
    // slot free right now?". Returns null when another turn is already
    // running (auto-retry timer racing user submit; queued drain racing
    // a still-finishing turn; concurrent tryStart). Reject this invocation
    // cleanly with no side effects. Defense-in-depth — the existing
    // isLoading-gated handleSubmit path SHOULD route most user submits
    // through the queue branch before reaching here, but timer-scheduled
    // entry paths (line ~1842 setTimeout for auto-retry, line ~1872 for
    // queued drain) bypass that gate.
    const turnGen = submissionGuardRef.current.tryStart()
    if (turnGen === null) {
      // No spinner change, no transcript noise — the owner of the running
      // turn produces all UI output. Returning false (not silence) lets
      // user-facing call sites recover the submission: pre-fix, a fresh
      // submit losing this race left the typed text stuck in the composer
      // with zero feedback, and the drain path lost its already-dequeued
      // message outright.
      return false
    }
    clearScheduledAutoRetry()
    const isContinuationRetry = request.kind === 'retry_failed_continuation'
    const isResumeContinuation = request.kind === 'resume_continuation'
    const input = request.kind === 'user_turn' ? request.input : ''

    // Repair any dangling tool sequences before starting a new turn.
    // Cheap when history is clean; guards against corrupted sessions loaded from disk.
    const { turns: repairedTurns, repaired, warnings } = validateAndRepairConversation(conversation.turns)
    if (repaired) {
      conversation.turns = repairedTurns
      for (const warning of warnings) {
        const routed = routeConversationNotice(warning, loopNoiseStateRef.current)
        loopNoiseStateRef.current = routed.nextState
        if (routed.transcriptEntry !== null) appendTranscript(routed.transcriptEntry)
        if (routed.footerNotice !== null) setFooterNotice(routed.footerNotice)
        if (routed.workflowPhase !== undefined) setWorkflowPhase(routed.workflowPhase)
      }
    }

    if (isContinuationRetry) {
      retryingFailedContinuationRef.current = true
      appendTranscript(`${themeColor('info')}↻ ${formatContinuationRetryStatus(request.failure)}${sgr.reset}`)
    } else if (isResumeContinuation) {
      // Resume continuation: the pending user turn(s) already live in history.
      // Run the loop over them without echoing or adding a new user message —
      // validateAndRepairConversation (above) has already merged any trailing
      // consecutive user turns into a single well-formed request.
      clearRetryContinuationState()
      appendTranscript(`${themeColor('info')}↻ Continuing this resumed session…${sgr.reset}`)
    } else {
      clearRetryContinuationState()
      addUserMessage(conversation, input)
      // History already recorded in handleSubmit — skip duplicate.
      // Scrub pseudo tool-call markers from the visible echo so a user
      // typing `[TOOL_CALL]{...}[/TOOL_CALL]` (adversarial or otherwise)
      // doesn't leave raw marker + JSON body in the transcript. The
      // ORIGINAL input still goes to the model via addUserMessage above
      // — only the visible echo is scrubbed. Fresh scrub state per turn:
      // user turns are independent of assistant streaming state.
      const echoText = scrubPseudoToolCall(input, { elided: false })
      appendTranscript(renderUserTurn(echoText))
    }
    setInputValue('')
    batchApproveAllRef.current = false
    taskStartMsRef.current = Date.now()
    lastProgressAtRef.current = Date.now()
    setIsLoading(true)
    setOverlay(null)
    setPermissionPrompt(null)
    setFooterNotice(null)
    setSpinnerState({ mode: 'model' })
    liveResponseRef.current = ''
    hasShownAssistantHeaderRef.current = false
    setLiveResponseText('')

    const runtime = runtimeRef.current
    const task = startReplTask(runtime)
    const taskCallbacks = withTaskCallbacks(callbacksRef.current!, runtime, task)
    const abortController = new AbortController()
    activeAbortRef.current = abortController
    const turnClearEpoch = clearEpochRef.current
    const requestStartMs = Date.now()
    let taskFailed = false
    let autoRetryFailure: ConversationRuntimeFailure | null = null
    let runtimeRetrySuppressionFailure: ConversationRuntimeFailure | null = null
    const contextWindow = resolveModelContextWindow(configRef.current, conversation.model)

    try {
      const { finalText, iterations, stopReason, usage: apiUsage, runtimeFailure } = await runConversationLoop(
        conversation,
        dispatcher,
        {
          apiBaseUrl: opts.apiBaseUrl,
          apiKey: opts.apiKey,
          callbacks: taskCallbacks,
          signal: abortController.signal,
          contextWindow,
          // 0.13.98 Batch B: pass middleware compaction config through to
          // tryCompact. compactionModel undefined → conversation.model
          // (resolved inside tryCompact). compactionInputMaxTokens undefined
          // → DEFAULT_COMPACTION_INPUT_MAX_TOKENS (8000) inside the helper.
          compactionModel: configRef.current.middleware?.compactionModel,
          compactionInputMaxTokens: configRef.current.middleware?.compactionInputMaxTokens,
        } satisfies ConversationLoopOptions,
      )
      taskFailed = !task.aborted && runtimeFailure !== null

      if (!task.aborted) {
        if (isRetryEligibleContinuationFailure(runtimeFailure)) {
          // Same "last request failed again" signal regardless of phase: if we
          // were already retrying when this failure hit, bump the counter;
          // otherwise this is a fresh failure — reset to 1. The older
          // model+phase keyed dedupe was removed because retry eligibility
          // no longer depends on phase, so a key comparison adds no safety.
          retryEligibleContinuationFailureRef.current = runtimeFailure
          failedContinuationAttemptCountRef.current = isContinuationRetry
            ? failedContinuationAttemptCountRef.current + 1
            : 1
          if (isExpensiveFailedContinuationFailure(runtimeFailure)) {
            const guidance = formatExpensiveFailureGuidance(runtimeFailure)
            appendTranscript(`${themeColor('warning')}⚠ ${guidance}${sgr.reset}`)
            setFooterNotice(dim(guidance))
            syncPendingRetry(false, failedContinuationAttemptCountRef.current)
            runtimeRetrySuppressionFailure = runtimeFailure
          } else if (failedContinuationAttemptCountRef.current >= 2) {
            appendTranscript(
              `${themeColor('warning')}⚠ ${formatRepeatedContinuationRetryGuidance(
                runtimeFailure,
                failedContinuationAttemptCountRef.current,
              )}${sgr.reset}`,
            )
            syncPendingRetry(true, failedContinuationAttemptCountRef.current)
            autoRetryFailure = runtimeFailure
          } else {
            syncPendingRetry(true, failedContinuationAttemptCountRef.current)
            autoRetryFailure = runtimeFailure
          }
        } else {
          clearRetryContinuationState()
        }
        if (apiUsage.inputTokens > 0 || apiUsage.outputTokens > 0) {
          usage.recordUsage(apiUsage)
        } else {
          usage.recordEstimated(input, finalText)
        }

        // Normal completion must drain the composer BEFORE the stats/footer
        // transcript entries are appended. Otherwise a final partial line
        // (commonly the conclusion sentence) gets stranded until `finally`,
        // rendering after `(N iterations)` / usage and looking like a copied
        // tail block.
        flushBufferedAssistantResponse()

        if (toolCollectorRef.current.pending > 0) {
          appendTranscript(toolCollectorRef.current.flush())
        }

        if (shouldShowNoResponseFallback({
          finalText,
          stopReason,
          runtimeFailure,
          aborted: abortController.signal.aborted,
        })) {
          const parts: string[] = [`(No response from ${conversation.model})`]
          if (stopReason && stopReason !== 'end_turn') {
            parts.push(`stop_reason: ${stopReason}`)
          }
          if (apiUsage.outputTokens === 0 && apiUsage.inputTokens === 0) {
            parts.push('No tokens reported')
          }
          appendTranscript(dim(parts.join(' · ')))
        }

        const stopDisplay = formatStopReason(stopReason)
        if (stopDisplay) appendTranscript(stopDisplay)
        // Chrome spec S3: one quiet progress line per turn instead of the
        // stacked "(N iterations)" + "[X in / Y out — Z total] · 12.3s" pair.
        const turnFooter = renderTurnFooter({
          iterations,
          inputTokens: apiUsage.inputTokens,
          outputTokens: apiUsage.outputTokens,
          elapsedSeconds: (Date.now() - requestStartMs) / 1000,
        })
        if (turnFooter) appendTranscript(turnFooter)

        saveSession(conversation)
        if (!runtimeFailure) {
          runtimeAutoRetryCountRef.current = 0
          recentRetryKindsRef.current = []
        }
      }
    } catch (error) {
      taskFailed = !task.aborted
      clearRetryContinuationState()
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('abort') && !message.includes('cancel')) {
        const parsed = parseApiError(message)
        const isExhausted = /exhaust|overload|no models|unavailable|all.*fail/i.test(message)
        const isContextLimit = isContextLimitError(message)
        const hint = isExhausted
          ? '  Backend overloaded. /model to switch, or /retry after wait.'
          : isContextLimit
          ? '  Context limit hit. Conversation was compacted — /retry to continue.'
          : '  /retry to resend, or /model to switch models.'
        appendTranscript(`${themeColor('error')}✗ ${parsed}${sgr.reset}\n${dim(hint)}`)
      }
    } finally {
      if (task.aborted) {
        clearRetryContinuationState()
      }
      retryingFailedContinuationRef.current = false
      const finalTaskRunStatus = conversation.options?.taskState?.run.status
      const finalTaskPhase = task.aborted
        ? 'interrupted'
        : taskFailed || shouldTreatTaskRunStatusAsFailure(finalTaskRunStatus)
          ? 'failed'
          : 'completed'
      traceInterruptEvent('ink-repl.finish-task.call', {
        finalTaskPhase,
        taskFailed,
        finalTaskRunStatus,
        ...summarizeTaskForInterruptTrace(task),
      })
      finishReplTask(runtime, task, finalTaskPhase)
      if (activeAbortRef.current === abortController) {
        activeAbortRef.current = null
      }

      // 0.13.99 SubmissionGuard: ownership check. end(turnGen) returns
      // false when a newer turn (or forced /clear / Ctrl+C reset) has
      // taken over the lifecycle slot. In that case ALL the shared-state
      // writes below would clobber the new owner's state (setIsLoading,
      // setSpinnerState, scheduling auto-retry timers, queue drain).
      // Skip everything; the new owner — or the forceEnd caller —
      // already owns these surfaces. Per-turn local resources
      // (finishReplTask + activeAbortRef clear above) DID run because
      // those are scoped to this task and don't conflict.
      if (!submissionGuardRef.current.end(turnGen)) {
        return true
      }

      if (turnClearEpoch !== clearEpochRef.current) {
        toolCollectorRef.current = new ToolResultCollector()
        mdRendererRef.current.reset()
        loopNoiseStateRef.current = { ...EMPTY_LOOP_NOISE_STATE }
        pseudoToolCallElidedRef.current = { elided: false }
        composeStateRef.current = freshComposeState()
        setFooterNotice(null)
        setSpinnerState(null)
        setWorkflowPhase(null)
        setIsLoading(false)
        traceInterruptEvent('ink-repl.reset-idle.call', {
          source: 'clear-epoch-changed',
          turnClearEpoch,
          currentClearEpoch: clearEpochRef.current,
          ...summarizeTaskForInterruptTrace(runtime.activeTask),
        })
        resetReplToIdle(runtime)
        setUiVersion((value) => value + 1)
        return true
      }

      // Error/interrupt fallback: normal completion drains this before
      // appending stats. Keep the finally drain so partial turns still keep
      // their trailing line when an error path exits before the normal flush.
      flushBufferedAssistantResponse()
      if (toolCollectorRef.current.pending > 0) {
        appendTranscript(toolCollectorRef.current.flush())
      }

      // Flush per-turn loop-noise summary into transcript, then reset state
      // and clear workflowPhase. Placed AFTER the partial-response + tool
      // flush so the recap reads as a trailing turn summary, not an
      // interstitial that would split a mid-stream assistant response on
      // interrupt / error paths. Runs for all exit paths (completed,
      // interrupted, failed) so the user always sees the recap.
      //
      // Coalesce N summary lines into ONE transcript item (newline-joined)
      // so the task-end batch appends exactly ONE new item rather than
      // N. Under the watermark-v2 Static split, each new visible item
      // that exceeds RECENT_VISIBLE_ITEMS pushes one older item into
      // <Static>; N appends = N scrollback commits racing the dynamic
      // frame paint — the documented source of cross-row smears
      // ("loopsmpted the model to produce…" in real-machine QA).
      // One appended item = at most one scrollback commit per batch.
      const loopNoiseSummary = summarizeLoopNoise(loopNoiseStateRef.current)
      if (loopNoiseSummary.length > 0) {
        appendTranscript(loopNoiseSummary.join('\n'))
      }
      loopNoiseStateRef.current = { ...EMPTY_LOOP_NOISE_STATE }
      pseudoToolCallElidedRef.current = { elided: false }
      composeStateRef.current = freshComposeState()

      mdRendererRef.current.reset()
      // Clear all transient chrome state in the same React batch as
      // the transcript growth. Without the explicit footerNotice(null),
      // the mid-turn footer lingers until a 1800ms async timer fires
      // (see effect above) — that's a second render pass the user sees
      // as "footer text stuck on screen for a moment after the task
      // ends," and on switching tasks the old footer can race the new
      // summary line into the same terminal row.
      // 0.14.0: peek next queued item (FIFO head). Drain path below pops
      // it; held path leaves it for the next turn to retry. Single
      // dequeue per turn-finally keeps serialization invariant — exactly
      // one runConversationTurn fires per drain, queue empties one item
      // per pass.
      const queuedPeek = submissionQueueRef.current.peek()
      const queued = queuedPeek?.text ?? null
      const autoRetryLimit = resolveReplRuntimeAutoRetryLimit()
      const schedulableAutoRetryFailure = autoRetryFailure as ConversationRuntimeFailure | null
      const runtimeRetryFailure = (schedulableAutoRetryFailure ?? runtimeRetrySuppressionFailure) as ConversationRuntimeFailure | null
      const shouldAutoRetry = shouldScheduleRuntimeAutoRetry({
        runtimeFailure: schedulableAutoRetryFailure,
        taskAborted: task.aborted,
        clearEpochUnchanged: turnClearEpoch === clearEpochRef.current,
        currentRetryCount: runtimeAutoRetryCountRef.current,
        retryLimit: autoRetryLimit,
        hasQueuedInput: Boolean(queued),
        recentRetryKinds: recentRetryKindsRef.current,
      })
      const autoRetryAttempt = shouldAutoRetry ? runtimeAutoRetryCountRef.current + 1 : runtimeAutoRetryCountRef.current
      const autoRetryDelayMs = shouldAutoRetry ? resolveReplRuntimeAutoRetryDelayMs(autoRetryAttempt) : 0
      const autoRetrySuppressionReason = !shouldAutoRetry
        ? classifyRuntimeAutoRetrySuppression({
          runtimeFailure: runtimeRetryFailure,
          taskAborted: task.aborted,
          clearEpochUnchanged: turnClearEpoch === clearEpochRef.current,
          currentRetryCount: runtimeAutoRetryCountRef.current,
          retryLimit: autoRetryLimit,
          hasQueuedInput: Boolean(queued),
          recentRetryKinds: recentRetryKindsRef.current,
        })
        : null
      if (runtimeRetryFailure && autoRetrySuppressionReason) {
        recordRuntimeAutoRetrySuppressionEvent(conversation, {
          surface: 'interactive_repl_auto_retry',
          runtimeFailure: runtimeRetryFailure,
          suppressionReason: autoRetrySuppressionReason,
          runtimeRetries: runtimeAutoRetryCountRef.current,
          retryLimit: autoRetryLimit,
          suppressedAutoResumeKind: autoRetrySuppressionReason === 'failure_kind_suppressed'
            ? runtimeRetryFailure.kind
            : null,
          hasQueuedInput: Boolean(queued),
          taskAborted: task.aborted,
          clearEpochUnchanged: turnClearEpoch === clearEpochRef.current,
          recentRetryKinds: recentRetryKindsRef.current,
        })
        try {
          saveSession(conversation)
        } catch { /* non-fatal */ }
      }
      if (shouldAutoRetry) {
        runtimeAutoRetryCountRef.current = autoRetryAttempt
        // 0.13.63 (C): record this failure's kind into the rolling
        // window so the next iteration of shouldScheduleRuntimeAutoRetry
        // can see "we've now had K consecutive same-kind failures."
        if (schedulableAutoRetryFailure) {
          const kinds = recentRetryKindsRef.current
          kinds.push(schedulableAutoRetryFailure.kind)
          // Cap to last 5 to keep memory tiny.
          if (kinds.length > 5) kinds.splice(0, kinds.length - 5)
        }
        const retryLine = `Runtime auto-continue: retryable failure, resuming task (${autoRetryAttempt}/${formatRetryLimit(autoRetryLimit)})${autoRetryDelayMs > 0 ? ` after ${autoRetryDelayMs}ms` : ''}…`
        appendTranscript(`${themeColor('info')}↻ ${retryLine}${sgr.reset}`)
        setFooterNotice(dim(retryLine))
        lastProgressAtRef.current = Date.now()
      } else if (queued && schedulableAutoRetryFailure) {
        clearRetryContinuationState()
        setFooterNotice(dim('Queued message superseded failed-request auto-continue.'))
      } else if (schedulableAutoRetryFailure && runtimeAutoRetryCountRef.current >= autoRetryLimit) {
        const exhaustedLine = `Runtime auto-continue stopped after ${formatRetryLimit(autoRetryLimit)} attempts. Use /model to switch, or /retry to force another resend.`
        appendTranscript(`${themeColor('warning')}⚠ ${exhaustedLine}${sgr.reset}`)
        setFooterNotice(dim(exhaustedLine))
        if (conversation.options?.taskState) {
          markTaskBlocked(
            conversation.options.taskState,
            exhaustedLine,
            conversation.options.taskState.run.currentFocus,
          )
          saveSession(conversation)
        }
      } else if (
        schedulableAutoRetryFailure !== null
        && runtimeAutoRetryCountRef.current >= 2
        && (() => {
          const k = schedulableAutoRetryFailure.kind
          const tail = recentRetryKindsRef.current.slice(-2)
          return tail.length >= 2 && tail.every((x) => x === k)
        })()
      ) {
        // 0.13.63 (C): same-kind 3-strike. Auto-retry refused before
        // hitting retryLimit because the last 2 attempts all hit the
        // same kind (e.g. timeout × 2 → don't try a 3rd). Without
        // this branch the user would just see footer go silent —
        // worse UX than the limit-reached branch above.
        const failureKind = schedulableAutoRetryFailure.kind
        const sameKindLine = `Runtime auto-continue stopped: ${runtimeAutoRetryCountRef.current} consecutive ${failureKind} failure(s) suggest the upstream is stuck — re-running the same request is unlikely to help. Use /model to switch, or /retry to force another resend.`
        appendTranscript(`${themeColor('warning')}⚠ ${sameKindLine}${sgr.reset}`)
        setFooterNotice(dim(sameKindLine))
        if (conversation.options?.taskState) {
          markTaskBlocked(
            conversation.options.taskState,
            sameKindLine,
            conversation.options.taskState.run.currentFocus,
          )
          saveSession(conversation)
        }
      } else {
        setFooterNotice(null)
      }
      setSpinnerState(null)
      setWorkflowPhase(null)
      setIsLoading(false)
      traceInterruptEvent('ink-repl.reset-idle.call', {
        source: 'turn-finally',
        taskFailed,
        hasAutoRetryFailure: schedulableAutoRetryFailure !== null,
        shouldAutoRetry,
        ...summarizeTaskForInterruptTrace(runtime.activeTask),
      })
      resetReplToIdle(runtime)
      setUiVersion((value) => value + 1)

      if (shouldAutoRetry && schedulableAutoRetryFailure) {
        const failure: ConversationRuntimeFailure = schedulableAutoRetryFailure
        scheduledAutoRetryTimerRef.current = setTimeout(() => {
          scheduledAutoRetryTimerRef.current = null
          void runConversationTurn({ kind: 'retry_failed_continuation', failure })
        }, autoRetryDelayMs)
        return true
      }

      // Drain queued input — auto-send if user submitted while task was running.
      //
      // Do not drain after an explicit interrupt: Ctrl+C means the user
      // intentionally stopped the active task, so queued text should wait
      // for a deliberate next submit instead of auto-running behind the abort.
      // Non-aborted failures only drain when runtime auto-retry remains eligible.
      if (shouldDrainQueuedInputAfterTurn({
        hasQueuedInput: Boolean(queued),
        taskFailed,
        autoRetryFailure: schedulableAutoRetryFailure,
        taskAborted: task.aborted,
      }) && queued) {
        // 0.14.0: dequeue the head item we're about to run. Keeps tail
        // items in the queue for the next drain pass.
        const drainItem = submissionQueueRef.current.dequeue()
        queueHeldNoticeShownRef.current = false
        setInputValue('')
        const drainDelayMs = task.aborted ? QUEUED_INPUT_DRAIN_AFTER_INTERRUPT_MS : 0
        const remaining = submissionQueueRef.current.size
        if (task.aborted) {
          const remHint = remaining > 0 ? ` (${remaining} more queued)` : ''
          setFooterNotice(dim(`Cancelled. Running queued message next${remHint}...`))
        }
        // Schedule after React state settles. On interrupt, keep one stable
        // ready frame visible before auto-draining the queue; otherwise
        // users and black-box PTY polling see "Ctrl+C" jump straight back
        // into busy without an observable cancellation boundary.
        setTimeout(() => {
          void runConversationTurn({ kind: 'user_turn', input: queued }).then((started) => {
            // The item was dequeued BEFORE this ran. If the guard rejected
            // (another turn grabbed the slot in the drain-delay window),
            // re-enqueue it — pre-fix the message was silently lost here.
            if (!started && drainItem) {
              setFooterNotice(dim(recoverGuardRejectedSubmission(submissionQueueRef.current, drainItem)))
            }
          })
        }, drainDelayMs)
      } else if (queued) {
        // shouldDrain=false (taskFailed AND not auto-retry-eligible).
        // Preserve user's queued input rather than silently dropping it
        // into the post-failure void. Source-mode invariant: input the
        // user submitted must not disappear without notice. Hold the
        // text in queuedInputRef; the next successful turn's drain
        // check (taskFailed=false branch in shouldDrainQueuedInputAfterTurn)
        // releases it naturally. /clear discards it explicitly.
        // queueHeldNoticeShownRef gates the transcript notice so repeated
        // non-drainable failures don't re-spam the warning every turn —
        // the queue is already held; one announcement is enough until
        // it's actually drained or cleared.
        if (!queueHeldNoticeShownRef.current) {
          const preview = queued.length > 60 ? `${queued.slice(0, 60)}…` : queued
          appendTranscript(`${themeColor('warning')}⚠ Queued input held: "${preview}"${sgr.reset}`)
          appendTranscript(dim('   Use /retry to resend the failed turn (queue drains after success), or /clear to discard.'))
          queueHeldNoticeShownRef.current = true
        }
        // Footer is transient (1.8s auto-clear) so it's safe to refresh
        // every turn — keeps the indicator visible across activity.
        setFooterNotice(dim('Queued input held — pending failure recovery'))
        // 0.14.0: queue NOT cleared — held items wait for next successful
        // turn's drain path (taskFailed=false branch above).
      } else {
        // Empty (or no draining needed) — clear any stale held-notice
        // state. Queue is already empty in this branch (no held items).
        queueHeldNoticeShownRef.current = false
      }
    }
    return true
  }, [appendTranscript, clearRetryContinuationState, clearScheduledAutoRetry, conversation, dispatcher, flushBufferedAssistantResponse, opts, syncPendingRetry, usage, withTaskCallbacks])

  const runCapturedSlashCommand = useCallback(async (command: string) => {
    const isClear = command.trim() === '/clear'

    // Alt-screen isolation is now picker-driven (see registerPickerIsolation
    // wiring in useEffect below). No per-command whitelist here.
    const { result, text } = await captureTerminalOutput<boolean>(async (output) => await handleSlashCommand(
      command,
      conversation,
      usage,
      opts,
      approveStateRef.current,
      dispatcher,
      undefined,
      undefined,
      undefined,
      mcpManager,
      thinkingStateRef.current,
      output,
      { onSideEffect: (effect) => { pendingSlashSideEffectRef.current = effect } },
    ))

    // /clear wipes the visible transcript too. handleSlashCommand
    // already emitted nuclear ANSI + tmux clear-history, but the
    // React transcriptItems state survived — on the next Ink render
    // the same <Static> items would re-paint into the fresh terminal
    // and re-populate tmux pane history. Reset the transcript state
    // here so the next render produces an empty scrollback layer +
    // empty visible viewport (aside from the "Conversation cleared."
    // confirmation appended below). <Static>'s items.length === 0
    // reset signal (Static.tsx) drops committedCountRef to 0 so
    // subsequent new items commit cleanly.
    if (isClear) {
      setTranscriptItems([])
      liveResponseRef.current = ''
      setLiveResponseText('')
      hasShownAssistantHeaderRef.current = false
      // Match the loading-path /clear — discard any held queue too.
      // Without this, a /clear after a non-drainable failure leaves
      // held input in the queue; the next successful turn would auto-
      // drain it, violating "clear = full reset".
      submissionQueueRef.current.clear()
      queueHeldNoticeShownRef.current = false
    }

    if (text) {
      appendTranscript(text)
    }
    setUiVersion((value) => value + 1)
    setTimeout(() => {
      if (isMountedRef.current) {
        setUiVersion((value) => value + 1)
      }
    }, 0)

    const sideEffect = pendingSlashSideEffectRef.current
    pendingSlashSideEffectRef.current = null
    if (sideEffect?.kind === 'open_editor') {
      const app = inkAppForSlashCommands
      app?.enterAlternateScreen()
      let editorResult: ReturnType<typeof runEditorSession> | undefined
      try {
        editorResult = runEditorSession(sideEffect.initialContent)
      } finally {
        // Mandatory: reclaim + repaint even if the editor crashed, so the REPL
        // never strands the user in a half-released terminal.
        app?.exitAlternateScreen()
      }
      if (
        editorResult?.ok &&
        editorResult.content != null &&
        editorResult.content.trim() !== '' &&
        editorResult.content !== sideEffect.initialContent
      ) {
        setInputValue(editorResult.content)
      }
    }
    if (sideEffect?.kind === 'force_resubmit_failed_turn') {
      // Consume runtimeFailure BEFORE re-entering handleSubmit. Two reasons:
      //   1. /retry is the explicit user act of consuming the failure; the
      //      matrix invariant says force_resubmit_failed_turn clears the
      //      failure ref, not preserves it.
      //   2. Without this, handleSubmit's classifier sees the failure ref
      //      still set and may re-route the resubmit:
      //        - If the prior user text is short_recovery-shaped (e.g.
      //          "为什么超时了"), classifier returns block_with_local_guidance
      //          and the resubmit is silently swallowed — conversation
      //          turns are already popped, so the user lands in a half-broken
      //          state with no retry actually fired.
      //        - For post_token_stream_close failures the ref was never
      //          populated (isRetryEligibleContinuationFailure excludes it),
      //          which is fine; clearing again is a no-op.
      // Re-submit the prior user turn through the regular submit path.
      // Use handleSubmitRef to avoid a circular useCallback dependency:
      // handleSubmit → handleSlashSubmit → runCapturedSlashCommand → handleSubmit.
      clearRetryContinuationState()
      void handleSubmitRef.current?.(sideEffect.text)
    }

    return result
  }, [appendTranscript, conversation, dispatcher, mcpManager, opts, usage])

  const handleExit = useCallback((source = 'unknown') => {
    traceInterruptEvent('ink-repl.handle-exit', {
      source,
      turns: conversation.turns.length,
      stack: interruptTraceStack('handleExit'),
    })
    if (conversation.turns.length > 0) {
      saveSession(conversation)
    }
    exit()
  }, [conversation, exit])

  const handleSlashSubmit = useCallback(async (command: string) => {
    const trimmed = command.trim()
    setInputValue('')

    if (trimmed === '/quit' || trimmed === '/exit') {
      handleExit('slash-exit')
      return
    }

    if (trimmed === '/') {
      setOverlay({
        type: 'slash',
        title: 'slash commands',
        items: buildSlashPickerItems(),
      })
      return
    }

    if (trimmed === '/model') {
      setSpinnerState({ mode: 'busy', message: 'Loading models…' })
      try {
        const items = await fetchModelPickerItems(opts, conversation.model)
        setOverlay({
          type: 'model',
          title: 'select model',
          items,
        })
        if (items.length === 0) {
          appendTranscript(`${sgr.bold}Current model:${sgr.reset} ${themeColor('owl')}${conversation.model}${sgr.reset}\n${dim('No models available from proxy. Use /model <name> to set manually.')}`)
          setOverlay(null)
        }
      } catch {
        appendTranscript(`${sgr.bold}Current model:${sgr.reset} ${themeColor('owl')}${conversation.model}${sgr.reset}\n${dim('No models available from proxy. Use /model <name> to set manually.')}`)
      } finally {
        setSpinnerState(null)
      }
      return
    }

    if (trimmed === '/theme' || trimmed === '/themes') {
      setOverlay({
        type: 'theme',
        title: 'select theme',
        items: buildThemePickerItems(),
      })
      return
    }

    if (trimmed.startsWith('/editor')) {
      appendTranscript(`${themeColor('info')}Built-in multi-line input is active.${sgr.reset}\n${dim('Use Shift+Enter to keep writing, then Enter to send.')}`)
      setUiVersion((value) => value + 1)
      return
    }

    await runCapturedSlashCommand(trimmed)
  }, [appendTranscript, conversation.model, handleExit, opts, runCapturedSlashCommand])

  const handleSubmit = useCallback(async (value: string) => {
    if (lastExitAttemptRef.current > 0) {
      traceInterruptEvent('ink-repl.exit-arm-cleared', { source: 'submit' })
      lastExitAttemptRef.current = 0
    }

    // Expand any paste-collapse placeholders back to their raw content
    // before the conversation layer sees the message. The visible
    // composer draft keeps placeholders for layout; the submitted text
    // is always the full original.
    const expanded = expandPlaceholders(value, pasteStoreRef.current)
    resetPasteStore(pasteStoreRef.current)
    value = expanded
    const trimmed = value.trim()
    if (!trimmed) return

    // AskUserQuestion tool waiting for an answer — Enter-submit
    // resolves the tool's Promise with the typed answer instead of
    // starting a new conversation turn. The tool runs inside the
    // current (still-loading) task, so isLoading=true is expected.
    // Echo the answer to transcript so the user can see what they
    // sent (transcript entry, not footer — becomes permanent history).
    if (questionPrompt) {
      setInputValue('')
      appendTranscript(`  ${dim('→ ' + trimmed)}`)
      questionPrompt.resolve(trimmed)
      setQuestionPrompt(null)
      return
    }

    const failedContinuationAction = decideFailedContinuationSubmitAction({
      text: trimmed,
      runtimeFailure: retryEligibleContinuationFailureRef.current,
      isRetryingFailedContinuation: retryingFailedContinuationRef.current,
      failedContinuationAttemptCount: failedContinuationAttemptCountRef.current,
    })
    if (failedContinuationAction === 'retry_failed_continuation') {
      const failure = retryEligibleContinuationFailureRef.current
      if (failure && isRetryEligibleContinuationFailure(failure)) {
        const started = await runConversationTurn({ kind: 'retry_failed_continuation', failure })
        if (!started) {
          // Guard race lost — a turn is already in flight. Mirror the
          // dedupe branch: clear the trigger text, tell the user.
          setInputValue('')
          setFooterNotice(dim('Already retrying failed continuation...'))
        }
        return
      }
    }
    if (failedContinuationAction === 'dedupe_retry_failed_continuation') {
      setInputValue('')
      appendTranscript(`${themeColor('info')}↻ Already retrying failed continuation...${sgr.reset}`)
      setFooterNotice(dim('Already retrying failed continuation...'))
      return
    }
    if (failedContinuationAction === 'guide_after_repeated_failed_continuation') {
      const failure = retryEligibleContinuationFailureRef.current
      setInputValue('')
      if (failure && isRetryEligibleContinuationFailure(failure)) {
        const guidance = formatRepeatedContinuationRetryGuidance(
          failure,
          failedContinuationAttemptCountRef.current,
        )
        appendTranscript(`${themeColor('warning')}⚠ ${guidance}${sgr.reset}`)
        setFooterNotice(dim(guidance))
      }
      return
    }
    if (failedContinuationAction === 'guide_after_expensive_failure') {
      const failure = retryEligibleContinuationFailureRef.current
      setInputValue('')
      if (failure && isExpensiveFailedContinuationFailure(failure)) {
        const guidance = formatExpensiveFailureGuidance(failure)
        appendTranscript(`${themeColor('warning')}⚠ ${guidance}${sgr.reset}`)
        setFooterNotice(dim(guidance))
      }
      return
    }

    // Always record in history immediately on submit (even when queuing)
    if (trimmed && !trimmed.startsWith('/')) {
      inputHistoryRef.current.push(value)
      historyIndexRef.current = -1
      draftRef.current = ''
    }

    if (isLoading && trimmed === '/clear') {
      submissionQueueRef.current.clear()
      clearEpochRef.current += 1
      setInputValue('')
      const activeTask = runtimeRef.current.activeTask
      if (activeTask && !activeTask.completed && !activeTask.aborted) {
        traceInterruptEvent('ink-repl.clear.interrupt-active-task', {
          ...summarizeTaskForInterruptTrace(activeTask),
          abortSignalAlreadyAborted: activeAbortRef.current?.signal.aborted ?? null,
          stack: interruptTraceStack('clear.interrupt-active-task'),
        })
        interruptReplTask(runtimeRef.current)
        traceInterruptEvent('ink-repl.abort-controller.abort', {
          source: 'clear-active-task',
          abortSignalAlreadyAborted: activeAbortRef.current?.signal.aborted ?? null,
          stack: interruptTraceStack('clear.abort-controller.abort'),
        })
        activeAbortRef.current?.abort()
      }
      traceInterruptEvent('ink-repl.reset-idle.call', {
        source: 'clear-command',
        ...summarizeTaskForInterruptTrace(runtimeRef.current.activeTask),
      })
      resetReplToIdle(runtimeRef.current)
      // 0.13.99: forceEnd bumps the guard generation so the cancelled
      // turn's eventual finally call to end(staleGen) returns false and
      // skips its shared-state writes — they'd clobber the post-clear
      // idle state otherwise.
      submissionGuardRef.current.forceEnd()
      setIsLoading(false)
      setSpinnerState(null)
      setWorkflowPhase(null)
      await runCapturedSlashCommand(trimmed)
      setFooterNotice(dim('Conversation cleared.'))
      return
    }

    if (isLoading) {
      // Queue input — will auto-send when the current task completes
      const hasActiveTask = Boolean(runtimeRef.current.activeTask && !runtimeRef.current.activeTask.completed)
      const hasScheduledAutoRetry = scheduledAutoRetryTimerRef.current !== null
      if (!shouldQueueSubmitBehindRunningTask({ isLoading, hasActiveTask, hasScheduledAutoRetry })) {
        clearScheduledAutoRetry()
        clearRetryContinuationState()
      } else {
        // 0.13.87: don't queue slash commands. Their semantics rely on the
        // current REPL state (e.g. /retry pops conversation.turns; /clear
        // wipes; /model swaps), not on being delivered as a literal user
        // message to the model on drain. Pre-fix, queuing '/retry' here
        // dropped through to runConversationTurn({ kind: 'user_turn',
        // input: '/retry' }), so the model received the literal '/retry'
        // string instead of a force-resubmit. Slash commands while loading
        // require explicit interruption — refuse with guidance.
        if (trimmed.startsWith('/')) {
          setInputValue('')
          appendTranscript(`${themeColor('warning')}⚠ Slash commands cannot be queued while a task is running.${sgr.reset}`)
          appendTranscript(dim('   Press Ctrl+C to abort the current task first, then re-issue the slash command.'))
          setFooterNotice(dim('Slash command refused — abort current task first'))
          return
        }
        // 0.14.0: enqueue into typed buffer (max 4 slots). Over cap →
        // OLDEST dropped + overflow signal surfaced to footer so user
        // knows their queue is dropping work.
        const queueOk = submissionQueueRef.current.enqueue({
          kind: 'user_turn',
          text: value,
          submittedAt: Date.now(),
          origin: 'user',
        })
        // Clear the composer the moment the submission is safely queued. The
        // text now lives in the queue (and input history), and every other
        // submit branch clears too. Without this, queued text stayed visible
        // in the composer and only cleared on drain (the turn-completion path):
        // a turn that never completes (e.g. a hung upstream) left the text
        // stuck on-screen, reading as "my input is stuck and nothing runs".
        setInputValue('')
        const sz = submissionQueueRef.current.size
        if (!queueOk) {
          setFooterNotice(dim(`Queue full — oldest dropped. (${sz} pending; new on top)`))
        } else {
          setFooterNotice(dim(`Queued (${sz} pending) — will send after current task completes.`))
        }
        return
      }
    }

    if (!isLoading && scheduledAutoRetryTimerRef.current) {
      clearScheduledAutoRetry()
      clearRetryContinuationState()
      setFooterNotice(dim('Previous auto-continue cancelled. Running new request...'))
    }

    if (trimmed.startsWith('/')) {
      // Only intercept recognized slash commands. Unrecognized /-prefixed text
      // (like /mes/outsource/page?current=1&size=2) is sent as literal chat.
      const slashToken = trimmed.split(/\s/)[0]!.toLowerCase()
      const isKnownSlash = slashToken === '/' || SLASH_COMMANDS.includes(slashToken)
      if (isKnownSlash) {
        await handleSlashSubmit(trimmed)
        return
      }
    }

    const started = await runConversationTurn({ kind: 'user_turn', input: value })
    if (!started) {
      // Guard race lost (isLoading was false at submit time but another
      // entry path — queued drain / auto-retry timer — grabbed the slot
      // first). Pre-fix this was a silent swallow: the typed text stayed
      // stuck in the composer with no feedback. Recover with the same
      // semantics as the isLoading queue branch: message into the queue,
      // composer cleared, footer notice.
      const notice = recoverGuardRejectedSubmission(submissionQueueRef.current, {
        kind: 'user_turn',
        text: value,
        submittedAt: Date.now(),
        origin: 'user',
      })
      setInputValue('')
      setFooterNotice(dim(notice))
    }
  }, [appendTranscript, clearRetryContinuationState, clearScheduledAutoRetry, handleSlashSubmit, isLoading, questionPrompt, runCapturedSlashCommand, runConversationTurn])
  // Keep the ref in sync so runCapturedSlashCommand can call handleSubmit
  // without a circular useCallback dependency.
  handleSubmitRef.current = handleSubmit

  // Resume continuation (resume bug fix): auto-continue a restored session that
  // ended with an unanswered user turn — the "interrupted a tool loop, typed a
  // message, quit before the assistant replied" shape. It used to resume silent
  // (the pending tool_result / instructions were never picked up, so the agent
  // sat idle). Fire one continuation turn on mount so the agent acts on what was
  // already said; it is announced and fully abortable (Ctrl+C). Mount-only
  // (empty deps run it exactly once); the ref guards a StrictMode double-invoke.
  useEffect(() => {
    if (resumeContinuationFiredRef.current) return
    if (!isResumed) return
    if (!conversationEndsAwaitingAssistant(conversation.turns)) return
    resumeContinuationFiredRef.current = true
    appendTranscript(
      `${themeColor('info')}↻ Resuming — continuing from the last unanswered message. ` +
        `Press Ctrl+C to stop.${sgr.reset}`,
    )
    void runConversationTurn({ kind: 'resume_continuation' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleOverlaySelect = useCallback(async (item: PickerItem<string>) => {
    const currentOverlay = overlay
    setOverlay(null)
    if (!currentOverlay) return

    if (currentOverlay.type === 'slash') {
      if (SLASH_COMMANDS_REQUIRING_ARGS.has(item.value)) {
        setInputValue(`${item.value} `)
        return
      }
      await handleSlashSubmit(item.value)
      return
    }

    if (currentOverlay.type === 'model') {
      conversation.model = item.value
      appendTranscript(renderNotice(`Switched to: ${item.value}`, 'success'))
      setUiVersion((value) => value + 1)
      return
    }

    if (currentOverlay.type === 'theme') {
      setTheme(item.value as ThemeName)
      appendTranscript(`${themeColor('success')}✓ Theme set to ${item.value}${sgr.reset}`)
      setUiVersion((value) => value + 1)
      return
    }

    if (currentOverlay.type === 'file') {
      const value = `${currentOverlay.prefix}@${item.value} `
      setInputValue(value)
      setCursorOffset(value.length)
    }
  }, [appendTranscript, conversation, handleSlashSubmit, overlay])

  // Enter-fallback for the slash picker: a known command typed with an argument
  // ("mode normal") fuzzy-matches no item, so Enter would otherwise dead-end.
  // Submit it as a real command instead. Returns true when it handled the Enter.
  const handleSlashRawSubmit = useCallback((query: string): boolean => {
    const command = resolveSlashPickerRawSubmit(query, SLASH_COMMANDS)
    if (!command) return false
    setOverlay(null)
    void handleSlashSubmit(command)
    return true
  }, [handleSlashSubmit, setOverlay])

  const handleInterrupt = useCallback((interruptsInInput = 1) => {
    traceInterruptEvent('ink-repl.handle-interrupt.enter', {
      permissionPrompt: Boolean(permissionPrompt),
      questionPrompt: Boolean(questionPrompt),
      overlayType: overlay?.type ?? null,
      isLoading,
      inputValueLength: inputValue.length,
      hasScheduledAutoRetry: scheduledAutoRetryTimerRef.current !== null,
      interruptsInInput,
      ...summarizeTaskForInterruptTrace(runtimeRef.current.activeTask),
      stack: interruptTraceStack('handleInterrupt.enter'),
    })

    if (permissionPrompt) {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', { branch: 'permission-deny' })
      handlePermissionDecision('deny')
      return
    }

    if (questionPrompt) {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', { branch: 'question-cancel' })
      // Ctrl+C on an active AskUserQuestion resolves with empty string.
      // ask-user.ts treats empty = cancelled and returns a non-error
      // ToolResult with metadata.cancelled=true, so the model learns
      // the user didn't answer without the tool itself erroring out.
      questionPrompt.resolve('')
      setQuestionPrompt(null)
      setFooterNotice(dim('Question cancelled.'))
      setInputValue('')
      return
    }

    if (overlay) {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', { branch: 'overlay-close', overlayType: overlay.type })
      setOverlay(null)
      setSpinnerState(null)
      return
    }

    const activeTask = runtimeRef.current.activeTask
    if (activeTask && !activeTask.completed) {
      // Already cancelling? Re-pressing Ctrl+C does nothing useful;
      // surface an ephemeral footer only so the transcript doesn't
      // accumulate ⚡/Cancelling lines while the abort propagates.
      if (activeTask.aborted) {
        traceInterruptEvent('ink-repl.handle-interrupt.branch', {
          branch: 'active-task-already-aborted',
          ...summarizeTaskForInterruptTrace(activeTask),
        })
        setFooterNotice(dim('Already cancelling…'))
        return
      }
      traceInterruptEvent('ink-repl.handle-interrupt.branch', {
        branch: 'active-task-interrupt',
        ...summarizeTaskForInterruptTrace(activeTask),
      })
      if (interruptReplTask(runtimeRef.current)) {
        traceInterruptEvent('ink-repl.abort-controller.abort', {
          source: 'handle-interrupt-active-task',
          abortSignalAlreadyAborted: activeAbortRef.current?.signal.aborted ?? null,
          stack: interruptTraceStack('handleInterrupt.abort-controller.abort'),
        })
        activeAbortRef.current?.abort()
        setSpinnerState(null)
        // Keep queued submissions, but do not auto-drain them after a user
        // interrupt. The user can press Enter again when they want to resume.
        const queuedSize = submissionQueueRef.current.size
        const queuedHint = queuedSize > 0
          ? `\n${dim(`  ${queuedSize} queued message${queuedSize > 1 ? 's are' : ' is'} paused after cancel completes.`)}`
          : ''
        setFooterNotice(`${themeColor('warning')}⚡ Interrupt requested${sgr.reset}`)
        // Lifecycle event → marker (em-dash gutter). Caps in the body are
        // a deliberate caller choice for label-style events — formatMarker
        // no longer transforms text, so paths/identifiers stay legible
        // when other call sites pass raw data.
        appendTranscript(`${formatMarker('↯ INTERRUPT REQUESTED · CANCELLING CURRENT TASK', 'warn')}${queuedHint}`)
        setUiVersion((value) => value + 1)
      }
      return
    }

    if (scheduledAutoRetryTimerRef.current) {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', { branch: 'scheduled-auto-retry-cancel' })
      clearScheduledAutoRetry()
      clearRetryContinuationState()
      setFooterNotice(dim('Runtime auto-continue cancelled.'))
      return
    }

    if (inputValue.length > 0) {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', {
        branch: 'draft-clear',
        inputValueLength: inputValue.length,
      })
      setInputValue('')
      setFooterNotice(dim('Draft cleared.'))
      return
    }

    const now = Date.now()
    const exitDecision = decideExitInterruptAction({
      nowMs: now,
      lastExitAttemptMs: lastExitAttemptRef.current,
      interruptsInInput,
      confirmWindowMs: EXIT_CONFIRM_WINDOW_MS,
    })
    if (exitDecision === 'confirm') {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', {
        branch: 'exit-confirmed',
        elapsedMs: now - lastExitAttemptRef.current,
      })
      handleExit('ctrl-c-confirmed')
      return
    }
    if (exitDecision === 'ignore_duplicate') {
      traceInterruptEvent('ink-repl.handle-interrupt.branch', {
        branch: 'exit-duplicate-ignored',
        elapsedMs: now - lastExitAttemptRef.current,
      })
      setFooterNotice(dim('Ctrl+C again to exit.'))
      return
    }
    lastExitAttemptRef.current = now
    traceInterruptEvent('ink-repl.handle-interrupt.branch', { branch: 'exit-arm' })
    setFooterNotice(dim('Ctrl+C again to exit.'))
  }, [clearRetryContinuationState, clearScheduledAutoRetry, handleExit, handlePermissionDecision, inputValue, isLoading, overlay, permissionPrompt, questionPrompt])

  useInput((input, key) => {
    if (permissionPrompt) {
      const answer = input.trim()

      // Escape = immediate deny
      if (key.escape) { handlePermissionDecision('deny'); return }

      // Direct-letter shortcuts — shift+A is the session-wide "allow all"
      // batch toggle (distinct from lowercase 'a' = always-this-tool) so
      // we check the raw `input` (case-preserved) for 'A' before lowering.
      if (input === 'A') { handlePermissionDecision('all'); return }

      const lower = answer.toLowerCase()
      if (lower === 'y') { handlePermissionDecision('allow'); return }
      if (lower === 'n') { handlePermissionDecision('deny'); return }
      if (lower === 'a') { handlePermissionDecision('always'); return }

      // Number-key shortcuts 1/2/3 → directly decide (no extra Enter).
      // Matches mainstream TUI menus where a number press IS the choice.
      if (answer === '1') { handlePermissionDecision('allow'); return }
      if (answer === '2') { handlePermissionDecision('deny'); return }
      if (answer === '3') { handlePermissionDecision('always'); return }

      // Arrow keys navigate the highlighted option; wrap around.
      if (key.upArrow) {
        setPermissionChoiceIndex((i) => (i + 2) % 3)
        return
      }
      if (key.downArrow) {
        setPermissionChoiceIndex((i) => (i + 1) % 3)
        return
      }

      // Enter confirms the currently-highlighted option. Previously
      // `answer === ''` (which is what Enter + arrow keys + many other
      // non-character key presses all produce) defaulted to 'allow' —
      // a silent auto-approve on every arrow keypress. Now Enter maps
      // to the highlighted choice and every other unknown key is ignored.
      if (key.return) {
        const decision = permissionChoiceIndex === 0 ? 'allow'
          : permissionChoiceIndex === 2 ? 'always'
          : 'deny'
        handlePermissionDecision(decision)
        return
      }
      return
    }

    // Shift+Tab cycles the operating mode (normal → auto → plan → normal), like
    // external coding-assistant. yolo is excluded from the casual cycle (enter it explicitly).
    // useTextInput treats tab as a no-op, so there's no double-handling.
    if (isModesEnabled()) {
      const nextMode = resolveModeCycleKey(
        key,
        conversation.options?.operatingModeState?.mode ?? 'normal',
      )
      if (nextMode) {
        ensureOperatingModeState(conversation, opts.mode ?? 'normal').mode = nextMode
        approveStateRef.current.autoApprove = nextMode === 'yolo' // keep the mirror synced
        setUiVersion((value) => value + 1)
        setFooterNotice(dim(`Mode → ${nextMode} (${MODE_SUMMARIES[nextMode]})`))
        return
      }
    }

    const interruptsInInput = countInterruptsInInput(input, key)
    if (interruptsInInput > 0) {
      traceInterruptEvent('ink-repl.use-input.interrupt-match', {
        matchBranch: input.includes('\u0003') ? 'etx-include' : 'ctrl-c',
        interruptsInInput,
        ...summarizeInterruptInput(input),
        ...summarizeKeyForInterruptTrace(key),
        ...summarizeTaskForInterruptTrace(runtimeRef.current.activeTask),
        stack: interruptTraceStack('useInput.interrupt-match'),
      })
      handleInterrupt(Math.max(1, interruptsInInput))
      return
    }

    if (lastExitAttemptRef.current > 0 && input.length > 0) {
      traceInterruptEvent('ink-repl.exit-arm-cleared', {
        source: 'non-interrupt-input',
        ...summarizeInterruptInput(input),
        ...summarizeKeyForInterruptTrace(key),
      })
      lastExitAttemptRef.current = 0
    }

    // Escape while answering an AskUserQuestion cancels the prompt and
    // keeps the task running. Ctrl+C still aborts the whole task.
    if (key.escape && questionPrompt) {
      questionPrompt.resolve('')
      setQuestionPrompt(null)
      setFooterNotice(dim('Question cancelled.'))
      setInputValue('')
      return
    }

    // Escape with a queued message (and no permission/question prompt open)
    // cancels the queue. The composer advertises "esc to cancel" next to the
    // QUEUED NEXT chip, but Escape was never wired to the queue — only /clear
    // could drop it, and /clear wipes the whole conversation. When a task is
    // wedged (e.g. a hung upstream that never unwinds to drain the queue),
    // this is the only non-destructive way to drop the pending message.
    if (
      key.escape &&
      decideEscapeKeyAction({
        hasPermissionPrompt: Boolean(permissionPrompt),
        hasQuestionPrompt: Boolean(questionPrompt),
        queuedSize: submissionQueueRef.current.size,
      }) === 'cancel_queue'
    ) {
      submissionQueueRef.current.clear()
      queueHeldNoticeShownRef.current = false
      setFooterNotice(dim('Queued message cancelled.'))
      setUiVersion((value) => value + 1)
      return
    }

    // Transcript scroll via line-based transcript owner.
    // Mouse stays terminal-native; app-side transcript scrolling is keyboard-only.
    // scrollBy(negative) = older history/up, scrollBy(positive) = back toward live/down.
    if (!overlay && scrollRef.current) {
      const halfPage = Math.max(3, Math.floor((stdout.rows || 24) / 2))

      if (key.pageUp || (key.ctrl && key.upArrow)) {
        scrollRef.current.scrollBy(-halfPage)
        return
      }
      if (key.pageDown) {
        scrollRef.current.scrollBy(halfPage)
        return
      }
      if ((key.ctrl && key.downArrow) || input === '\x1b[F' || input === '\x1bOF') {
        scrollRef.current.scrollToBottom()
        return
      }
      if (input === '\x1b[H' || input === '\x1bOH') {
        scrollRef.current.scrollTo(Number.MAX_SAFE_INTEGER)
        return
      }
    }
  })

  // Intercept input changes to detect bare '/' for slash command picker.
  // ONLY bare '/' opens the picker. Multi-character input like '/mes/outsource'
  // or '/usr/bin' is treated as literal text — not a slash command prefix.
  const handleInputChange = useCallback((value: string) => {
    traceRenderEvent('input-change', {
      prevLength: inputValue.length,
      nextLength: value.length,
      delta: value.length - inputValue.length,
      overlay: overlay?.type ?? null,
      isLoading,
      permissionPrompt: Boolean(permissionPrompt),
    })
    if (value === '/' && !isLoading && !overlay && !permissionPrompt) {
      setInputValue('')
      setOverlay({
        type: 'slash',
        title: 'slash commands',
        items: buildSlashPickerItems(),
      })
      return
    }
    const fileRefMatch = value.match(/(^|\s)@([^\s]*)$/)
    if (fileRefMatch && !isLoading && !overlay && !permissionPrompt) {
      const prefix = value.slice(0, fileRefMatch.index! + fileRefMatch[1]!.length)
      setInputValue(prefix)
      setCursorOffset(prefix.length)
      setOverlay({
        type: 'file',
        title: '@ file reference',
        items: buildFilePickerItems({ limit: 120 }),
        prefix,
        initialQuery: fileRefMatch[2],
      })
      return
    }
    // Paste-collapse: detect a large single-change insert relative to
    // the previous value and collapse it to a placeholder. Raw content
    // is restashed in pasteStoreRef and re-expanded at submit time.
    const prev = inputValue
    // 0.13.72: try the burst-collapse path FIRST. It captures
    // chunked pastes (no working bracketed-paste sequence; SSH/tmux
    // strips CSI 200/201; slow stdin) where each individual onChange
    // delta is small but the cumulative growth within a 50ms window
    // crosses the collapse threshold. Falls through to the per-event
    // path when no burst is in progress.
    const burst = tryBurstCollapse(pasteBurstRef.current, pasteStoreRef.current, prev, value)
    if (burst) {
      pruneStaleTokens(pasteStoreRef.current, burst.value)
      setInputValue(burst.value)
      setCursorOffset(burst.cursor)
      return
    }
    const insert = detectPasteInsert(prev, value)
    if (insert && shouldCollapse(insert.inserted)) {
      const { value: collapsed, cursor } = collapsePaste(pasteStoreRef.current, prev, insert)
      pruneStaleTokens(pasteStoreRef.current, collapsed)
      setInputValue(collapsed)
      setCursorOffset(cursor)
      return
    }
    pruneStaleTokens(pasteStoreRef.current, value)
    setInputValue(value)
  }, [inputValue, isLoading, overlay, permissionPrompt, setOverlay])

  const liveResponsePreview = liveResponseText ? clipLiveResponse(liveResponseText) : ''
  const rows = stdout.rows || 24
  const cols = stdout.columns || 80
  const composerMode = isLoading ? 'act' : 'plan'
  const inputMaxVisibleLines = Math.max(4, Math.min(8, Math.floor(rows / 3)))

  // Elapsed seconds drives color and animation intensity — spinner frame keeps re-renders coming.
  const elapsedSeconds = isLoading ? Math.max(0, Math.floor((Date.now() - taskStartMsRef.current) / 1000)) : 0

  // inputMaxVisibleLines used by TextInput for viewport height
  void inputMaxVisibleLines

  // Inline status: dim during first 5 s, accent-colored afterward
  const inlinePhase = spinnerState?.mode === 'tool' ? 'tool_execution' as const
    : spinnerState?.mode === 'busy' ? 'busy' as const
    : 'awaiting_model' as const
  const phaseDetail =
    workflowPhase === 'targeted_check' ? 'Targeted verification'
    : workflowPhase === 'synthesizing' ? 'Synthesizing final answer'
    : workflowPhase === 'fallback_synthesizing' ? 'Retrying synthesis (fallback)'
    : workflowPhase === 'hard_stop' ? 'Hard stop — see transcript'
    : undefined
  const inlineDetail = phaseDetail
    ?? (!spinnerState ? 'Receiving response…' : spinnerState.message)
  const inlineStatusDim = elapsedSeconds < 5
  const inlineStatusColor = !inlineStatusDim && inlinePhase === 'awaiting_model' && !liveResponsePreview
    ? themeToInkHex('owl')
    : undefined
  const transcriptCols = Math.max(1, cols - 2)
  // Gap since the last concrete progress event drives the "idle Xs"
  // suffix in the inline status line. Only computed during loading;
  // before the task starts (lastProgressAtRef=0) we suppress the
  // suffix by passing 0. Recomputed on the spinner-frame tick; the tick is
  // intentionally modest so long transcripts do not fight queued typing.
  const stallMs = isLoading && lastProgressAtRef.current > 0
    ? Math.max(0, Date.now() - lastProgressAtRef.current)
    : 0
  const transcriptTailText = liveResponsePreview
    ? liveResponsePreview
    : isLoading
      ? `  ⎿  ${buildInlineStatusLine({
          frame: spinnerFrame,
          elapsedSeconds,
          model: conversation.model,
          phase: inlinePhase,
          activeToolName: spinnerState?.mode === 'tool' ? spinnerState.toolName : undefined,
          detail: inlineDetail,
          stallMs,
        })}`
      : ''
  const transcriptTail = useMemo(() => (
    liveResponsePreview ? (
      <Text wrap="wrap">{liveResponsePreview}</Text>
    ) : isLoading ? (
      <Text dimColor={inlineStatusDim} color={inlineStatusColor}>
        {transcriptTailText}
      </Text>
    ) : null
  ), [inlineStatusColor, inlineStatusDim, isLoading, liveResponsePreview, transcriptTailText])
  // Truncate-end (single-row) footer. wrap="wrap" previously let long
  // loop-noise strings ("Runtime summary gate: batched 4 exploratory
  // tools, waiting for a recap before more read/search") span two
  // terminal rows; when the footer content changed mid-frame, Ink's
  // row-level clear sometimes missed the second wrapped row, leaving
  // a half-sentence residue. Keeping it to one row forces a clean
  // single-line diff path.
  const transcriptFooter = useMemo(
    () => footerNotice ? <Text wrap="truncate-end">{footerNotice}</Text> : null,
    [footerNotice],
  )
  const transcriptTailLines = transcriptTailText
    ? estimateWrappedLineCount(transcriptTailText, transcriptCols)
    : 0
  const transcriptFooterLines = footerNotice ? 1 : 0
  const pickerVisibleCount = Math.max(3, Math.min(10, rows - 10))
  const permissionCardProps = permissionPrompt
    ? buildPermissionCardProps(permissionPrompt.toolName, permissionPrompt.input, permissionChoiceIndex, cols)
    : null
  // 0.14.0: peek HEAD of queue for footer/composer preview. Multi-item
  // queue: we display just the first item plus a "(N pending)" count.
  // queuedDraft remains a single-string projection to keep downstream
  // call sites (line 2722, 2748, 2760, 2854) backward-compatible — they
  // already treat queued as "is there anything queued, here's a hint"
  // not "render everything".
  const queuedDraft = submissionQueueRef.current.peek()?.text ?? null
  const inputDisplayText = inputValue || ' '
  const inputBottomWrapColumns = Math.max(10, cols - 10)
  const inputPanelWrapColumns = Math.max(10, cols - 2)
  const inputBottomWrappedLines = useMemo(
    () => estimateWrappedLineCount(inputDisplayText, inputBottomWrapColumns),
    [inputDisplayText, inputBottomWrapColumns],
  )
  const inputPanelWrappedLines = useMemo(
    () => estimateWrappedLineCount(inputDisplayText, inputPanelWrapColumns),
    [inputDisplayText, inputPanelWrapColumns],
  )
  const inputAttachments = useMemo(
    () => parseInputAttachments(inputValue),
    [inputValue],
  )
  const usageSnapshot = usage.getSnapshot()
  // CTX is active conversation pressure. UsageTracker is cumulative spend and
  // can legitimately exceed the model window over a long multi-request task.
  // Keep this off uiVersion/input/spinner churn: scanning a huge conversation
  // on every render makes cmux typing visibly laggy. The rail can trail during
  // an active turn and refresh at turn-count/loading boundaries.
  const contextTokens = useMemo(
    () => estimateConversationTokens(conversation).totalTokens,
    [conversation.system, conversation.turns.length, isLoading],
  )
  const contextMax = resolveModelContextWindow(configRef.current, conversation.model)
  const mcpConnected = mcpManager.summary().connected
  // Keep the rail entirely off the draft hot path. The input itself is the
  // authoritative draft surface; repainting a "DRAFT" rail cell while typing
  // adds terminal churn with almost no user value.
  const railDraftChars = 0
  const railHintContext = overlay
    ? (overlay.type === 'file' ? 'at' : overlay.type)
    : permissionPrompt
      ? 'approval'
      : isLoading
        ? 'busy'
        : 'idle'
  const railActiveToolName = spinnerState?.mode === 'tool' ? spinnerState.toolName : undefined
  const railInterruptRequested = runtimeRef.current.activeTask?.aborted ?? false
  const composerRail = useMemo(
    () => renderComposerRail({
      model: conversation.model,
      mode: composerMode,
      busy: isLoading,
      queued: queuedDraft ? 1 : 0,
      contextTokens,
      contextMax,
      draftChars: railDraftChars,
      draftCellMode: 'hidden',
      interruptRequested: railInterruptRequested,
      columns: cols,
      approval: Boolean(permissionPrompt),
      activeToolName: railActiveToolName,
      cost: usageSnapshot.estimatedCostUsd,
      branch: gitBranchRef.current,
      mcpConnected,
      hintContext: railHintContext,
      yolo: approveStateRef.current.autoApprove,
      // Live operating mode — re-read each render; /mode bumps uiVersion
      // (slash-command return), which is in the dep list below.
      operatingMode: isModesEnabled()
        ? (conversation.options?.operatingModeState?.mode ?? 'normal')
        : undefined,
    }),
    [
      cols,
      composerMode,
      contextMax,
      contextTokens,
      conversation.model,
      isLoading,
      lowChurnTerminalMode,
      mcpConnected,
      uiVersion,
      permissionPrompt,
      queuedDraft,
      railActiveToolName,
      railHintContext,
      railInterruptRequested,
      usageSnapshot.estimatedCostUsd,
    ],
  )
  const bottomBodyLines = permissionPrompt
    ? countPermissionCardRows(permissionCardProps!)
    : overlay
      ? 8 + pickerVisibleCount
      : Math.max(1, Math.min(inputMaxVisibleLines, inputBottomWrappedLines))
        + (queuedDraft ? 1 : 0)
  const transcriptHeight = computeTranscriptHeight(rows, bottomBodyLines)
  if (traceInputLatency) {
    traceInputLatencyCheckpoint('native-repl-after-layout-calcs', {
      inputLength: inputValue.length,
      bottomBodyLines,
      transcriptHeight,
      overlay: overlay?.type ?? null,
      permissionPrompt: Boolean(permissionPrompt),
    })
  }

  // ── Upstream layout: ScrollBox (top, grows) + fixed bottom ──
  // Watermark-v2 split: older items go to <Static> scrollback sink;
  // only recent RECENT_VISIBLE_ITEMS items render in the dynamic
  // viewport. The split is append-only: transcriptItems.length only
  // grows, so scrollback prefix is stable across re-renders — <Static>
  // sees a lengthening tail and enqueues only the delta each render.
  const { scrollback: scrollbackItems, visible: visibleItems } = useMemo(
    () => splitTranscriptForScrollback(
      transcriptItems,
      Math.min(RECENT_VISIBLE_ITEMS, MAX_VISIBLE_ITEMS_CAP),
    ),
    [transcriptItems],
  )

  // <Static> consumes the rendered text of each item — not the item object.
  // The committed rows land in terminal scrollback; the app-visible
  // ScrollableTranscript only sees visibleItems.
  const scrollbackTexts = useMemo(
    () => scrollbackItems.map((item) => item.text),
    [scrollbackItems],
  )
  if (traceInputLatency) {
    traceInputLatencyCheckpoint('native-repl-before-return', {
      visibleItems: visibleItems.length,
      scrollbackItems: scrollbackItems.length,
      inputLength: inputValue.length,
    })
  }
  return (
    <>
      <Static items={scrollbackTexts} />
      <Box flexDirection="column" height={rows}>
      <ScrollableTranscript
        items={visibleItems}
        tail={transcriptTail}
        footer={transcriptFooter}
        height={transcriptHeight}
        cols={cols}
        tailLines={transcriptTailLines}
        footerLines={transcriptFooterLines}
        isLoading={isLoading}
        scrollRef={scrollRef}
      />
      {/* Fixed bottom: composer panel (shared frame + rail).
       *
       * bodyLines drives the authoring band's minHeight and MUST only
       * be passed when the TextInput body is active. Overlay (slash
       * picker) and permission-prompt modes render their own content
       * with its own intrinsic height — passing bodyLines in those
       * modes would force an oversized empty bg slab to appear
       * beneath the overlay. The conditional below mirrors the child
       * branch so the two are bound together by construction. */}
      <ComposerPanel
        bodyLines={permissionPrompt || overlay
          ? undefined
          : Math.max(1, Math.min(
              inputMaxVisibleLines,
              inputPanelWrappedLines,
            ))}
        rail={composerRail}
      >
        {permissionPrompt && permissionCardProps ? (
          <PermissionCard {...permissionCardProps} />
        ) : overlay ? (
          <InkPicker
            title={overlay.title}
            items={overlay.items}
            variant={overlay.type === 'file' ? 'at' : overlay.type === 'slash' ? 'slash' : overlay.type === 'model' ? 'model' : 'generic'}
            initialQuery={overlay.initialQuery}
            queryPrefix={overlay.type === 'slash' ? '/' : overlay.type === 'file' ? '@' : undefined}
            submitLabel={overlay.type === 'slash' ? 'run' : overlay.type === 'file' ? 'attach' : 'select'}
            onSelect={(item: any) => {
              void handleOverlaySelect(item)
            }}
            onCancel={() => {
              setOverlay(null)
              setSpinnerState(null)
            }}
            onSubmitRaw={overlay.type === 'slash' ? handleSlashRawSubmit : undefined}
          />
        ) : (
          <ComposerInputChrome
            mode={composerMode}
            queued={queuedDraft}
            columns={cols}
            attachments={inputAttachments}
          >
            <UpstreamTextInput
              value={inputValue}
              placeholder={isLoading ? 'Type to queue your next message…' : 'Type your message, / for commands, @ to attach files'}
              onChange={handleInputChange}
              onSubmit={(value: string) => {
                void handleSubmit(value)
              }}
              onHistoryUp={() => {
                const history = inputHistoryRef.current
                if (history.length === 0) return
                if (historyIndexRef.current === -1) {
                  draftRef.current = inputValue // save current draft
                  historyIndexRef.current = history.length - 1
                } else if (historyIndexRef.current > 0) {
                  historyIndexRef.current--
                }
                setInputValue(history[historyIndexRef.current] ?? '')
                setCursorOffset(history[historyIndexRef.current]?.length ?? 0)
              }}
              onHistoryDown={() => {
                if (historyIndexRef.current === -1) return
                const history = inputHistoryRef.current
                if (historyIndexRef.current < history.length - 1) {
                  historyIndexRef.current++
                  setInputValue(history[historyIndexRef.current] ?? '')
                  setCursorOffset(history[historyIndexRef.current]?.length ?? 0)
                } else {
                  // Return to draft
                  historyIndexRef.current = -1
                  setInputValue(draftRef.current)
                  setCursorOffset(draftRef.current.length)
                }
              }}
              onHistoryReset={() => {
                historyIndexRef.current = -1
                draftRef.current = ''
              }}
              focus={!overlay && !permissionPrompt}
              multiline
              showCursor
              disableCursorMovementForUpDownKeys={!inputValue.includes('\n')}
              columns={Math.max(10, cols - 10)}
              maxVisibleLines={inputMaxVisibleLines}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              inputFilter={(input: string, key: { ctrl?: boolean }) =>
                countInterruptsInInput(input, key) > 0 ? '' : input}
            />
          </ComposerInputChrome>
        )}
      </ComposerPanel>
      </Box>
    </>
  )
}

export async function startInkRepl(opts: ReplOptions): Promise<void> {
  const mcpManager = new MCPManager()
  const dispatcher = new ToolDispatcher(mcpManager)
  const usage = new UsageTracker()
  let conversation: Conversation | null = null

  dispatcher.register(createAgentTool({
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    getModel: () => conversation?.model ?? opts.model,
    getContextWindow: () => resolveModelContextWindow(loadConfig(), conversation?.model ?? opts.model),
    maxTokens: opts.maxTokens ?? resolveDefaultMaxOutputTokens(),
  }))

  // Re-register the Config tool with a live autoApprove getter/setter so
  // `Config({setting:"autoApprove", value:true})` is a working programmatic
  // /yolo toggle. The default registration in dispatch.registerDefaults()
  // produces a Config without that wiring; re-registering replaces it
  // (ToolDispatcher.register is `Map.set`, last-write-wins). The setter
  // mutates the same object the React ref points to, so the rail picks up
  // the change on the next render.
  dispatcher.register(createConfigTool({
    autoApprove: {
      get: () => getLiveApproveState()?.autoApprove ?? false,
      set: (v: boolean) => {
        const live = getLiveApproveState()
        if (live) live.autoApprove = v
      },
    },
    autoDeny: {
      get: () => getLiveApproveState()?.autoDeny ?? false,
      set: (v: boolean) => {
        const live = getLiveApproveState()
        if (live) live.autoDeny = v
      },
    },
  }))

  const replPlanModeState: PlanModeState = { inPlanMode: false }
  const modeToolDeps = {
    getOperatingModeState: () => conversation?.options?.operatingModeState ?? null,
    ensureOperatingModeState: () => conversation ? ensureOperatingModeState(conversation, opts.mode ?? 'normal') : null,
  }
  dispatcher.register(createEnterPlanModeTool(replPlanModeState, modeToolDeps))
  dispatcher.register(createExitPlanModeTool(replPlanModeState, modeToolDeps))

  // Re-register ProbePlan with a live-conversation accessor (0.13.51).
  // Default registration in dispatch.registerDefaults() produces a
  // ProbePlan that returns "no live conversation" — the REPL re-wires
  // it here so plans can mutate the active conversation's options.
  dispatcher.register(createProbePlanTool({
    getConversation: () => conversation,
  }))

  const proxyOk = await preflightCheck(opts.apiBaseUrl)
  const tools = buildNativeToolDefs(dispatcher)

  if (opts.resumeSession) {
    const session = loadSession(opts.resumeSession)
    if (session) {
      conversation = restoreConversation(session, tools)
    } else {
      conversation = createConversation({
        system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        model: opts.model,
        maxTokens: opts.maxTokens,
        tools,
      })
    }
  } else {
    conversation = createConversation({
      system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: opts.model,
      maxTokens: opts.maxTokens,
      tools,
    })
  }
  initializeOperatingModeState(conversation, opts.mode ?? 'normal')

  if (opts.liveReplClientId) {
    updateLiveReplClientSession(opts.liveReplClientId, conversation.id)
  }

  // Push prior preflight/stderr output into scrollback before Ink claims a
  // frame region. Without this, Ink's first render can begin mid-screen
  // (directly under the last preflight line), and the welcome logo — which
  // is taller than the remaining viewport — wraps with its top half pushed
  // into scrollback. A subsequent layout pass then re-emits the full logo
  // in the now-recalculated viewport, producing the "welcome shown twice"
  // report. Flooding newlines + cursor-home gives Ink clean terrain while
  // keeping preflight text scrollable above.
  if (process.stdout.isTTY) {
    const rows = process.stdout.rows ?? 24
    process.stdout.write('\n'.repeat(Math.max(rows, 8)))
    process.stdout.write('\x1b[H') // cursor home
  }

  const app = await inkRender(
    <NativeReplApp
      conversation={conversation}
      dispatcher={dispatcher}
      mcpManager={mcpManager}
      opts={opts}
      isResumed={!!opts.resumeSession}
      usage={usage}
      preflightOk={proxyOk}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: traceRenderFrame,
    },
  )
  // Publish the Ink instance so runCapturedSlashCommand can enter/exit alt
  // screen around imperative pickers (see needsAltScreen above).
  inkAppForSlashCommands = app

  await app.waitUntilExit()

  await mcpManager.disconnectAll().catch(() => {})
  if (conversation.turns.length > 0) {
    saveSession(conversation)
    console.log(`\nResume with: ${formatResumeCommand(conversation.id)}`)
  }
  console.log('Goodbye!')
}
