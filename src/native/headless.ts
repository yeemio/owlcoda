/**
 * OwlCoda Native Headless Runner
 *
 * Non-interactive single-shot mode: send prompt → run agentic loop → print result → exit.
 * Used by `owlcoda run --native --prompt "..."` and piped stdin.
 */

import { ToolDispatcher } from './dispatch.js'
import { detectEmittedButUnexecutedToolCall } from './repl-shared.js'
import { ensureOperatingModeState, initializeOperatingModeState, type OperatingMode } from './modes.js'
import {
  createConversation,
  resolveDefaultMaxOutputTokens,
  addUserMessage,
  runConversationLoop,
  type ConversationCallbacks,
  type ConversationLoopOptions,
} from './conversation.js'
import { buildNativeToolDefs } from './tool-defs.js'
import { buildSystemPrompt } from './system-prompt.js'
import { formatToolStart, formatToolEnd, formatError, ansi } from './display.js'
import { StreamingMarkdownRenderer } from './markdown.js'
import { saveSession, loadSession, listSessions } from './session.js'
import type { SessionFile } from './session.js'
import { loadConfig, resolveModelContextWindow } from '../config.js'
import type { ToolProgressEvent } from './tools/index.js'
import type { TaskRunStatus } from './protocol/types.js'
import { getTodos } from './tools/todo-write.js'
import { isProjectMapEnabled } from './project-map.js'
import { evaluateProjectMapDogfoodAcceptance } from './project-map-acceptance.js'
import { createEnterPlanModeTool, type PlanModeState } from './tools/enter-plan-mode.js'
import { createExitPlanModeTool } from './tools/exit-plan-mode.js'
import {
  buildHeadlessApprovalCallback,
  describeApprovalPolicy,
  normalizeHeadlessToolList,
  type HeadlessApprovalRecord,
} from './headless-approval.js'
import type { ProjectMapSnapshot } from './protocol/project-map-types.js'

const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt()
const DEFAULT_RUNTIME_RESUME_RETRIES = 8
const DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS = 1000
const MAX_RUNTIME_RESUME_RETRY_DELAY_MS = 30_000
const HEADLESS_JSON_TOOL_OUTPUT_MAX_CHARS = 20_000
const HEADLESS_POLICY_CONTEXT_MARKER = '[Runtime headless approval policy]'

interface HeadlessToolCallLog {
  tool: string
  input: Record<string, unknown>
  output: string
}

interface SerializedHeadlessToolCall extends HeadlessToolCallLog {
  output_truncated?: boolean
  output_original_chars?: number
}

interface HeadlessProjectMapRuntimeEvidence {
  schema_version: 1
  enabled: boolean
  snapshot_present: boolean
  prompt_injected: boolean
  freshness_status?: string
  git_head?: string
  package_name?: string
  package_version?: string
  source_files: Array<{ path: string; kind: string; scope?: string }>
  entrypoints: Array<{ path: string; kind: string }>
  write_boundaries: Array<{ path: string; kind: string; origin?: string }>
  verification_profiles: Array<{
    id: string
    applies_to?: string
    commands: string[]
    required_before_done?: boolean
  }>
  convergence_notices: string[]
}

interface HeadlessProjectMapAcceptanceEvidence {
  schema_version: 1
  ok: boolean
  failures: string[]
  checks: ReturnType<typeof evaluateProjectMapDogfoodAcceptance>['checks']
  max_iterations: number | null
}

export interface HeadlessOptions {
  apiBaseUrl: string
  apiKey: string
  model: string
  mode?: OperatingMode
  prompt: string
  maxTokens?: number
  systemPrompt?: string
  /** If true, output JSON with structured result contract */
  json?: boolean
  /** If true, auto-approve task-contract-declared file mutations */
  autoApprove?: boolean
  /** Optional comma/list style tool allowlist. Narrows, never widens, the base policy. */
  allowTools?: readonly string[]
  /** Optional comma/list style tool denylist. Deny wins over allow and base policy. */
  denyTools?: readonly string[]
  /** Resume an existing session by ID ('last' resolves to most recent) */
  resumeSession?: string
  /** Whether to save the session after completion */
  saveSessionOnComplete?: boolean
}

export interface HeadlessResult {
  text: string
  exitCode: number
  iterations: number
  sessionId?: string
  resumed?: boolean
  runtimeRetries?: number
  /** Approval policy that was applied to this run. */
  approvalPolicy?: string
  approvalToolAllowlist?: string[]
  approvalToolDenylist?: string[]
  /** Tools that the policy denied (with reason); useful for callers/tests. */
  approvalDenials?: Array<{ toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] }>
  /** Conversation loop stop reason, exposed so batch runners can detect incomplete work. */
  stopReason?: string | null
  /** Final task execution status when the task contract subsystem is active. */
  taskStatus?: TaskRunStatus
  /** Last task guard reason when the task ended blocked/drifted/waiting. */
  taskGuardReason?: string
  /** Project Map runtime evidence emitted for JSON dogfood acceptance. */
  projectMapRuntime?: HeadlessProjectMapRuntimeEvidence
  /** Project Map dogfood acceptance verdict emitted for JSON dogfood acceptance. */
  projectMapAcceptance?: HeadlessProjectMapAcceptanceEvidence
}

/** Outcome of resolving a `--resume` request, before any I/O side effects. */
export type ResumeOutcome =
  | { kind: 'fresh' }
  | { kind: 'resume'; session: SessionFile }
  | { kind: 'error'; requested: string; message: string }

/**
 * Decide how a headless `--resume` request resolves. An explicit resume that
 * cannot be loaded (missing/corrupt session, or `last` with no history) is an
 * ERROR — never a silent downgrade to a fresh session, which would burn a
 * scripted run with no prior context while the caller believes it resumed. #10
 */
export function classifyResumeRequest(
  resumeSession: string | undefined,
  deps: { listSessions: () => SessionFile[]; loadSession: (id: string) => SessionFile | null },
): ResumeOutcome {
  if (!resumeSession) return { kind: 'fresh' }
  let id = resumeSession
  if (id === 'last') id = deps.listSessions()[0]?.id ?? ''
  const loaded = id ? deps.loadSession(id) : null
  if (loaded) return { kind: 'resume', session: loaded }
  const detail = resumeSession === 'last'
    ? 'no saved sessions to resume'
    : `session not found or unreadable: ${resumeSession}`
  return { kind: 'error', requested: resumeSession, message: `Cannot resume — ${detail}` }
}

/** Run a single-shot native conversation. */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const dispatcher = new ToolDispatcher()
  const autoApprove = opts.autoApprove === true
  const allowTools = normalizeHeadlessToolList(opts.allowTools)
  const denyTools = normalizeHeadlessToolList(opts.denyTools)
  const toolDefs = filterHeadlessToolDefs(buildNativeToolDefs(dispatcher), allowTools, denyTools)
  const approvalPolicy = describeApprovalPolicy(autoApprove)
  const systemPrompt = appendHeadlessPolicyContext(
    opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    buildHeadlessPolicyContext({ autoApprove, approvalPolicy, allowTools, denyTools }),
  )

  // Resolve resume session
  let resumed = false
  let resolvedSessionId: string | undefined
  let conversation = createConversation({
    system: systemPrompt,
    model: opts.model,
    maxTokens: opts.maxTokens ?? resolveDefaultMaxOutputTokens(),
    tools: toolDefs,
  })

  const resumeOutcome = classifyResumeRequest(opts.resumeSession, { listSessions, loadSession })
  if (resumeOutcome.kind === 'error') {
    // Fail fast — never silently degrade an explicit --resume into a fresh run.
    if (opts.json) {
      await writeStdoutLine(JSON.stringify({
        text: '',
        model: opts.model,
        session_id: resumeOutcome.requested,
        resumed: false,
        exit_code: 1,
        tool_calls: [],
        error: resumeOutcome.message,
        approval_policy: approvalPolicy,
        approval_tool_allowlist: allowTools,
        approval_tool_denylist: denyTools,
        approval_denials: [],
      }))
    } else {
      process.stderr.write(formatError(resumeOutcome.message) + '\n')
    }
    return {
      text: '',
      exitCode: 1,
      iterations: 0,
      sessionId: resumeOutcome.requested,
      resumed: false,
      approvalPolicy,
      approvalToolAllowlist: allowTools,
      approvalToolDenylist: denyTools,
      approvalDenials: [],
    }
  }
  if (resumeOutcome.kind === 'resume') {
    // Restore the conversation from the saved session
    const loaded = resumeOutcome.session
    conversation.id = loaded.id
    conversation.model = loaded.model
    conversation.system = appendHeadlessPolicyContext(
      loaded.system ?? conversation.system,
      buildHeadlessPolicyContext({ autoApprove, approvalPolicy, allowTools, denyTools }),
    )
    conversation.maxTokens = loaded.maxTokens ?? conversation.maxTokens
    conversation.turns = [...loaded.turns]
    resolvedSessionId = loaded.id
    resumed = true
  }
  initializeOperatingModeState(conversation, opts.mode ?? 'normal')

  const planModeState: PlanModeState = { inPlanMode: false }
  const modeToolDeps = {
    getOperatingModeState: () => conversation.options?.operatingModeState ?? null,
    ensureOperatingModeState: () => ensureOperatingModeState(conversation, opts.mode ?? 'normal'),
  }
  dispatcher.register(createEnterPlanModeTool(planModeState, modeToolDeps))
  dispatcher.register(createExitPlanModeTool(planModeState, modeToolDeps))

  addUserMessage(conversation, opts.prompt)

  let streamedAny = false
  const toolCallLog: HeadlessToolCallLog[] = []
  const approvalDecisions: HeadlessApprovalRecord[] = []
  const noticeLog: string[] = []
  const plainStdout = !opts.json && process.stdout.isTTY !== true

  // Headless installs its own onToolApproval callback unconditionally so the
  // conversation loop's per-tool approval gate fires. Without this, headless
  // mode would silently auto-execute every tool — see issue #1. The callback
  // denies unsafe tools (write/edit/NotebookEdit/bash) unless autoApprove
  // was explicitly requested via CLI/config; safe tools (read/glob/grep/…)
  // remain low-friction.
  const onToolApproval = buildHeadlessApprovalCallback({
    autoApprove,
    allowTools,
    denyTools,
    getTaskState: () => conversation.options?.taskState,
    onDecision(record) {
      approvalDecisions.push(record)
      // Always surface denials on stderr — even in --json mode, since the
      // structured output is only printed after the loop completes and
      // operators reading logs deserve real-time visibility.
      if (!record.decision.allowed) {
        let detail = ''
        if ('bashRisk' in record.decision && record.decision.bashRisk) {
          const risk = record.decision.bashRisk
          detail = ` [risk=${risk.level}${risk.reasons[0] ? `: ${risk.reasons[0]}` : ''}]`
        }
        const msg = `Tool ${record.toolName} denied by headless approval policy (${approvalPolicy})${detail}. ` +
          `--auto-approve only approves safe tools, task-contract-declared file writes, and workspace-local test bash; ` +
          `mutating, networked, dangerous, or unknown bash remains denied in unattended headless. ` +
          `Use the interactive REPL for explicit approval.`
        process.stderr.write(formatHeadlessError(msg) + '\n')
      }
    },
  })
  const onUserQuestion: ConversationCallbacks['onUserQuestion'] = async (toolName, question) => {
    const firstLine = question.trim().split(/\r?\n/, 1)[0] ?? ''
    process.stderr.write(formatError(
      `Tool ${toolName} requested user input in headless mode; auto-cancelling instead of blocking stdin.` +
      (firstLine ? ` Question: ${firstLine}` : ''),
    ) + '\n')
    return ''
  }

  const callbacks: ConversationCallbacks = opts.json
    ? {
        onToolApproval,
        onUserQuestion,
        onToolStart(name, input) {
          toolCallLog.push({ tool: name, input, output: '' })
        },
        onToolProgress(name, event) {
          writeHeadlessProgressSentinel(name, event)
        },
        onToolEnd(_name, result) {
          if (toolCallLog.length > 0) {
            toolCallLog[toolCallLog.length - 1]!.output = result
          }
        },
        onNotice(message) {
          noticeLog.push(message)
        },
      }
      : plainStdout
      ? {
          onToolApproval,
          onUserQuestion,
          onText(text: string) {
            if (text) {
              process.stdout.write(text)
              streamedAny = true
            }
          },
          onToolStart(name: string, input: Record<string, unknown>) {
            toolCallLog.push({ tool: name, input, output: '' })
            process.stderr.write(formatToolStart(name, input) + '\n')
          },
          onToolEnd(name: string, result: string, isError: boolean, durationMs: number) {
            if (toolCallLog.length > 0) {
              toolCallLog[toolCallLog.length - 1]!.output = result
            }
            process.stderr.write(formatToolEnd(name, result, isError, durationMs) + '\n')
          },
          onToolProgress(name: string, event: ToolProgressEvent) {
            writeHeadlessProgressSentinel(name, event)
          },
          onError(error: string) {
            process.stderr.write(formatHeadlessError(error) + '\n')
          },
        } satisfies ConversationCallbacks
      : (() => {
        const md = new StreamingMarkdownRenderer()
        return {
          onToolApproval,
          onUserQuestion,
          onText(text: string) {
            const rendered = md.push(text)
            if (rendered) {
              process.stdout.write(rendered)
              streamedAny = true
            }
          },
          onToolStart(name: string, input: Record<string, unknown>) {
            toolCallLog.push({ tool: name, input, output: '' })
            const flushed = md.flush()
            if (flushed) {
              process.stdout.write(flushed)
              streamedAny = true
            }
            process.stderr.write(formatToolStart(name, input) + '\n')
          },
          onToolEnd(name: string, result: string, isError: boolean, durationMs: number) {
            if (toolCallLog.length > 0) {
              toolCallLog[toolCallLog.length - 1]!.output = result
            }
            process.stderr.write(formatToolEnd(name, result, isError, durationMs) + '\n')
          },
          onToolProgress(name: string, event: ToolProgressEvent) {
            writeHeadlessProgressSentinel(name, event)
          },
          onError(error: string) {
            process.stderr.write(formatError(error) + '\n')
          },
          _flush() {
            const flushed = md.flush()
            if (flushed) {
              process.stdout.write(flushed)
              streamedAny = true
            }
          },
        } satisfies ConversationCallbacks & { _flush: () => void }
      })()

  const headlessConfig = loadConfig()
  const loopOpts: ConversationLoopOptions = {
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    callbacks,
    contextWindow: resolveModelContextWindow(headlessConfig, conversation.model),
    compactionModel: headlessConfig.middleware?.compactionModel,
    compactionInputMaxTokens: headlessConfig.middleware?.compactionInputMaxTokens,
  }

  try {
    const maxRuntimeRetries = resolveRuntimeResumeRetries()
    let runtimeRetries = 0
    let totalIterations = 0

    while (true) {
      const {
        finalText,
        iterations,
        stopReason,
        runtimeFailure,
      } = await runConversationLoop(
        conversation,
        dispatcher,
        loopOpts,
      )

      totalIterations += iterations

      if (!runtimeFailure) {
        const sessionId = resolvedSessionId ?? conversation.id
        const taskState = conversation.options?.taskState
        const taskStatus = taskState?.run.status
        const taskGuardReason = taskState?.run.lastGuardReason ?? undefined
        // Silent tool-loss guard: a run that executed zero tools yet left a
        // tool-call marker in the final text means the upstream returned the
        // model's native tool call as plain text instead of structured
        // tool_use — so the deliverable never landed. Surface it loudly and
        // fail non-zero rather than reporting a false "completed". (Common
        // cause: runHeadless pointed straight at a raw runtime's /v1/messages;
        // point it at the OwlCoda daemon so local runtimes route through the
        // /v1/chat/completions translate path where tool calls round-trip.)
        const emittedToolMarker = toolCallLog.length === 0
          ? detectEmittedButUnexecutedToolCall(finalText)
          : null
        if (emittedToolMarker) {
          process.stderr.write(formatHeadlessError(
            `Model emitted a tool call as text ("${emittedToolMarker}") but no tool executed — ` +
            `the upstream is not converting native tool calls into structured tool_use. ` +
            `Point runHeadless at the OwlCoda daemon (local runtimes then route through ` +
            `/v1/chat/completions), not at a raw runtime's /v1/messages.`,
          ) + '\n')
        }
        const exitCode = (shouldHeadlessExitNonZero(stopReason, taskStatus, finalText) || emittedToolMarker !== null) ? 1 : 0
        const projectMapRuntime = buildHeadlessProjectMapRuntimeEvidence(conversation, noticeLog)
        const projectMapAcceptance = buildHeadlessProjectMapAcceptanceEvidence({
          conversation,
          finalText,
          totalIterations,
          stopReason,
          taskStatus,
          toolCallLog,
          approvalDecisions,
          prompt: opts.prompt,
        })

        // Save session after completion
        try {
          saveSession(conversation)
        } catch { /* non-fatal */ }

        writeHeadlessStopDiagnosticIfNeeded({
          conversation,
          stopReason,
          taskStatus,
          taskGuardReason,
          finalText,
          toolCallLog,
          sessionId,
          exitCode,
        })

        if (opts.json) {
          const output = JSON.stringify({
            text: finalText,
            model: conversation.model,
            session_id: sessionId,
            resumed,
            exit_code: exitCode,
            stop_reason: stopReason,
            task_status: taskStatus,
            task_guard_reason: taskGuardReason,
            tool_calls: serializeToolCalls(toolCallLog),
            iterations: totalIterations,
            runtime_retries: runtimeRetries,
            approval_policy: approvalPolicy,
            approval_tool_allowlist: allowTools,
            approval_tool_denylist: denyTools,
            approval_denials: serializeDenials(approvalDecisions),
            ...(projectMapRuntime ? { project_map_runtime: projectMapRuntime } : {}),
            ...(projectMapAcceptance ? { project_map_acceptance: projectMapAcceptance } : {}),
          })
          await writeStdoutLine(output)
        } else {
          if ('_flush' in callbacks && typeof callbacks._flush === 'function') {
            (callbacks as any)._flush()
          }
          if (!streamedAny && finalText) {
            process.stdout.write(finalText)
          }
          if (finalText || streamedAny) {
            process.stdout.write('\n')
          }
        }

        return {
          text: finalText,
          exitCode,
          iterations: totalIterations,
          sessionId,
          resumed,
          runtimeRetries,
          approvalPolicy,
          approvalToolAllowlist: allowTools,
          approvalToolDenylist: denyTools,
          approvalDenials: serializeDenials(approvalDecisions),
          stopReason,
          taskStatus,
          taskGuardReason,
          projectMapRuntime,
          projectMapAcceptance,
        }
      }

      const sessionId = resolvedSessionId ?? conversation.id

      // Save after every runtime failure so a process crash can still resume
      // from the last well-formed transcript instead of losing tool results.
      try {
        saveSession(conversation)
      } catch { /* non-fatal */ }

      const suppressedAutoResumeKind = headlessRuntimeAutoResumeSuppressedKind(runtimeFailure.kind)
      if (suppressedAutoResumeKind || !runtimeFailure.retryable || runtimeRetries >= maxRuntimeRetries) {
        const exhausted = !suppressedAutoResumeKind && runtimeFailure.retryable && runtimeRetries >= maxRuntimeRetries
        const message = suppressedAutoResumeKind
          ? `${runtimeFailure.message} Automatic runtime resume suppressed for ${suppressedAutoResumeKind}. Session preserved: ${sessionId}`
          : exhausted
          ? `${runtimeFailure.message} Runtime resume retries exhausted (${runtimeRetries}/${formatRuntimeRetryLimit(maxRuntimeRetries)}). Session preserved: ${sessionId}`
          : runtimeFailure.message
        if (opts.json) {
          const output = JSON.stringify({
            text: '',
            model: conversation.model,
            session_id: sessionId,
            resumed,
            exit_code: 1,
            tool_calls: serializeToolCalls(toolCallLog),
            iterations: totalIterations,
            runtime_retries: runtimeRetries,
            runtime_failure: runtimeFailure,
            error: message,
            approval_policy: approvalPolicy,
            approval_tool_allowlist: allowTools,
            approval_tool_denylist: denyTools,
            approval_denials: serializeDenials(approvalDecisions),
          })
          await writeStdoutLine(output)
        } else {
          process.stderr.write(formatError(message) + '\n')
        }
        return {
          text: '',
          exitCode: 1,
          iterations: totalIterations,
          sessionId,
          resumed,
          runtimeRetries,
          approvalPolicy,
          approvalToolAllowlist: allowTools,
          approvalToolDenylist: denyTools,
          approvalDenials: serializeDenials(approvalDecisions),
        }
      }

      runtimeRetries++
      const delayMs = runtimeResumeDelayMs(runtimeRetries)
      const maxLabel = formatRuntimeRetryLimit(maxRuntimeRetries)
      process.stderr.write(`${ansi.dim}${
        `  ↻ Runtime failure is retryable; session ${sessionId} preserved. Continuing automatically ` +
        `(${runtimeRetries}/${maxLabel})${delayMs > 0 ? ` after ${delayMs}ms` : ''}…`
      }${ansi.reset}\n`)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const sessionId = resolvedSessionId ?? conversation.id

    // Still save what we have on error
    try { saveSession(conversation) } catch { /* non-fatal */ }

    if (opts.json) {
      const output = JSON.stringify({
        text: '',
        model: conversation.model,
        session_id: sessionId,
        resumed,
        exit_code: 1,
        tool_calls: serializeToolCalls(toolCallLog),
        error: msg,
        approval_policy: approvalPolicy,
        approval_tool_allowlist: allowTools,
        approval_tool_denylist: denyTools,
        approval_denials: serializeDenials(approvalDecisions),
      })
      await writeStdoutLine(output)
    } else {
      process.stderr.write(formatError(msg) + '\n')
    }

    return {
      text: '',
      exitCode: 1,
      iterations: 0,
      sessionId,
      resumed,
      approvalPolicy,
      approvalToolAllowlist: allowTools,
      approvalToolDenylist: denyTools,
      approvalDenials: serializeDenials(approvalDecisions),
    }
  }
}

export function shouldHeadlessExitNonZero(
  stopReason: string | null,
  taskStatus: TaskRunStatus | undefined,
  finalText = '',
): boolean {
  if (stopReason === 'narration_loop' && finalText.trim()) return false
  if (stopReason === 'hard_stop' || stopReason === 'task_no_progress' || stopReason === 'max_iterations' || stopReason === 'stalled') {
    return true
  }
  return taskStatus === 'blocked' || taskStatus === 'waiting_user' || taskStatus === 'drifted'
}

function formatHeadlessError(message: string): string {
  return process.stderr.isTTY === true ? formatError(message) : `Error: ${message}`
}

function buildHeadlessPolicyContext(input: {
  autoApprove: boolean
  approvalPolicy: string
  allowTools: readonly string[]
  denyTools: readonly string[]
}): string {
  const lines = [
    HEADLESS_POLICY_CONTEXT_MARKER,
    `- Policy: ${input.approvalPolicy}.`,
    '- This is an unattended, non-interactive run.',
    '- Safe read/search/listing tools are normally allowed.',
    '- AskUserQuestion is denied; produce a best-effort result instead of waiting for stdin.',
    '- --auto-approve only approves safe tools, task-contract-declared file writes, and workspace-local test bash.',
    '- Mutating, networked, dangerous, or unknown bash remains denied even when it appears in the tool allowlist.',
    `- Tool allowlist: ${input.allowTools.length > 0 ? input.allowTools.join(', ') : '(none)'}.`,
    `- Tool denylist: ${input.denyTools.length > 0 ? input.denyTools.join(', ') : '(none)'}.`,
  ]
  return lines.join('\n')
}

function appendHeadlessPolicyContext(systemPrompt: string, policyContext: string): string {
  const markerIndex = systemPrompt.indexOf(HEADLESS_POLICY_CONTEXT_MARKER)
  const base = markerIndex >= 0 ? systemPrompt.slice(0, markerIndex).trimEnd() : systemPrompt.trimEnd()
  return `${base}\n\n${policyContext}`
}

function filterHeadlessToolDefs<T extends { name: string }>(
  toolDefs: T[],
  allowTools: readonly string[],
  denyTools: readonly string[],
): T[] {
  const deny = new Set(denyTools)
  const allow = allowTools.length > 0 ? new Set(allowTools) : null
  return toolDefs.filter((tool) => {
    if (deny.has(tool.name)) return false
    if (allow && !allow.has(tool.name)) return false
    return true
  })
}

function buildHeadlessProjectMapRuntimeEvidence(
  conversation: { options?: { projectMapSnapshot?: ProjectMapSnapshot; projectMapPromptSummary?: string } },
  noticeLog: string[],
): HeadlessProjectMapRuntimeEvidence | undefined {
  const enabled = isProjectMapEnabled()
  const snapshot = conversation.options?.projectMapSnapshot
  const promptSummary = conversation.options?.projectMapPromptSummary ?? ''
  if (!enabled && !snapshot && !promptSummary) return undefined

  return {
    schema_version: 1,
    enabled,
    snapshot_present: Boolean(snapshot),
    prompt_injected: enabled && promptSummary.includes('<project_map>'),
    ...(snapshot?.freshness?.status ? { freshness_status: snapshot.freshness.status } : {}),
    ...(snapshot?.gitHead ? { git_head: snapshot.gitHead } : {}),
    ...(snapshot?.packageName ? { package_name: snapshot.packageName } : {}),
    ...(snapshot?.packageVersion ? { package_version: snapshot.packageVersion } : {}),
    source_files: (snapshot?.sourceFiles ?? []).slice(0, 20).map((source) => ({
      path: source.path,
      kind: source.kind,
      ...(source.scope ? { scope: source.scope } : {}),
    })),
    entrypoints: (snapshot?.entrypoints ?? []).slice(0, 20).map((entry) => ({
      path: entry.path,
      kind: entry.kind,
    })),
    write_boundaries: (snapshot?.writeBoundaries ?? []).slice(0, 20).map((boundary) => ({
      path: boundary.path,
      kind: boundary.kind,
      ...(boundary.origin ? { origin: boundary.origin } : {}),
    })),
    verification_profiles: (snapshot?.verificationProfiles ?? []).slice(0, 20).map((profile) => ({
      id: profile.id,
      commands: profile.commands,
      ...(profile.appliesTo ? { applies_to: profile.appliesTo } : {}),
      ...(typeof profile.requiredBeforeDone === 'boolean' ? { required_before_done: profile.requiredBeforeDone } : {}),
    })),
    convergence_notices: noticeLog
      .filter((notice) => notice.includes('Project Map convergence'))
      .slice(-10),
  }
}

function buildHeadlessProjectMapAcceptanceEvidence(input: {
  conversation: { options?: { projectMapSnapshot?: ProjectMapSnapshot; projectMapPromptSummary?: string } }
  finalText: string
  totalIterations: number
  stopReason: string | null
  taskStatus?: TaskRunStatus
  toolCallLog: HeadlessToolCallLog[]
  approvalDecisions: HeadlessApprovalRecord[]
  prompt: string
}): HeadlessProjectMapAcceptanceEvidence | undefined {
  const enabled = isProjectMapEnabled()
  const promptSummary = input.conversation.options?.projectMapPromptSummary ?? ''
  const promptInjected = enabled && promptSummary.includes('<project_map>')
  const projectMapUsed = input.toolCallLog.some((call) => call.tool === 'ProjectMap')
  const dogfoodLike = isProjectMapDogfoodPrompt(input.prompt) || isProjectMapDogfoodPrompt(input.finalText)
  if (!projectMapUsed && !dogfoodLike) return undefined

  const maxIterations = resolveHeadlessMaxIterationsForEvidence()
  const result = evaluateProjectMapDogfoodAcceptance({
    finalText: input.finalText,
    evidenceText: buildHeadlessProjectMapAcceptanceEvidenceText(input.toolCallLog),
    iterations: input.totalIterations,
    maxIterations: maxIterations ?? Number.MAX_SAFE_INTEGER,
    stopReason: input.stopReason,
    taskStatus: input.taskStatus,
    toolCalls: input.toolCallLog,
    approvalDenials: serializeDenials(input.approvalDecisions),
    promptInjected,
  })

  return {
    schema_version: 1,
    ok: result.ok,
    failures: result.failures,
    checks: result.checks,
    max_iterations: maxIterations,
  }
}

function buildHeadlessProjectMapAcceptanceEvidenceText(toolCallLog: HeadlessToolCallLog[]): string {
  return toolCallLog
    .map((call) => [
      `tool:${call.tool}`,
      `input:${JSON.stringify(call.input)}`,
      `output:${call.output}`,
    ].join('\n'))
    .join('\n\n')
    .slice(-50_000)
}

function isProjectMapDogfoodPrompt(text: string): boolean {
  return /project\s*map/i.test(text) && /runtime\s+control\s+plane|control-plane|dogfood|acceptance/i.test(text)
}

function resolveHeadlessMaxIterationsForEvidence(): number | null {
  const raw = process.env['OWLCODA_MAX_ITERATIONS']
  if (raw === undefined || raw === '') return 200
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'unlimited' || lowered === 'infinity' || lowered === 'inf') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 200
  if (parsed <= 0) return null
  return parsed
}

function writeHeadlessStopDiagnosticIfNeeded(input: {
  conversation: unknown
  stopReason: string | null
  taskStatus: TaskRunStatus | undefined
  taskGuardReason: string | undefined
  finalText: string
  toolCallLog: HeadlessToolCallLog[]
  sessionId: string
  exitCode: number
}): void {
  if (!shouldEmitHeadlessStopDiagnostic(input.stopReason, input.exitCode)) return
  const payload = {
    type: 'owlcoda.headless.stop_diagnostic',
    schema_version: 1,
    session_id: input.sessionId,
    conversation_id: extractConversationId(input.conversation),
    stop_reason: input.stopReason,
    task_status: input.taskStatus,
    task_guard_reason: input.taskGuardReason,
    exit_code: input.exitCode,
    final_text_chars: input.finalText.length,
    recent_assistant_text: collectRecentAssistantText(input.conversation),
    recent_tools: input.toolCallLog.slice(-8).map(call => ({
      tool: call.tool,
      input: previewJson(call.input, 600),
      output_preview: previewText(call.output, 800),
    })),
    todos: getTodos().slice(0, 20),
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
}

function shouldEmitHeadlessStopDiagnostic(stopReason: string | null, exitCode: number): boolean {
  if (exitCode === 0) return false
  return stopReason === 'task_no_progress' || stopReason === 'max_iterations' || stopReason === 'stalled' || stopReason === 'narration_loop'
}

function extractConversationId(conversation: unknown): string | undefined {
  if (conversation && typeof conversation === 'object' && 'id' in conversation) {
    const id = (conversation as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}

function collectRecentAssistantText(conversation: unknown): string {
  if (!conversation || typeof conversation !== 'object' || !('turns' in conversation)) return ''
  const turns = (conversation as { turns?: unknown }).turns
  if (!Array.isArray(turns)) return ''
  const chunks: string[] = []
  for (let i = turns.length - 1; i >= 0 && chunks.join('\n').length < 2_000; i--) {
    const turn = turns[i]
    if (!turn || typeof turn !== 'object') continue
    if ((turn as { role?: unknown }).role !== 'assistant') continue
    const content = (turn as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const text = content
      .map(block => {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          const value = (block as { text?: unknown }).text
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('')
      .trim()
    if (text) chunks.unshift(text)
  }
  return previewText(chunks.join('\n'), 2_000)
}

function previewJson(value: unknown, maxChars: number): string {
  try {
    return previewText(JSON.stringify(value), maxChars)
  } catch {
    return previewText(String(value), maxChars)
  }
}

function previewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}…`
}

function writeHeadlessProgressSentinel(toolName: string, event: ToolProgressEvent): void {
  const payload = {
    type: 'owlcoda.headless.progress',
    schema_version: 1,
    tool: toolName,
    elapsed_ms: event.elapsedMs,
    total_lines: event.totalLines,
    total_bytes: event.totalBytes,
    lines: event.lines,
  }
  process.stderr.write(JSON.stringify(payload) + '\n')
}

function writeStdoutLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error | null) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    process.stdout.write(`${line}\n`, done)
  })
}

function serializeToolCalls(calls: HeadlessToolCallLog[]): SerializedHeadlessToolCall[] {
  return calls.map((call) => {
    if (call.output.length <= HEADLESS_JSON_TOOL_OUTPUT_MAX_CHARS) return call
    const keepHead = Math.floor(HEADLESS_JSON_TOOL_OUTPUT_MAX_CHARS * 0.65)
    const keepTail = HEADLESS_JSON_TOOL_OUTPUT_MAX_CHARS - keepHead
    return {
      ...call,
      output:
        `${call.output.slice(0, keepHead)}\n` +
        `[… ${call.output.length - HEADLESS_JSON_TOOL_OUTPUT_MAX_CHARS} chars omitted from headless JSON tool output …]\n` +
        call.output.slice(call.output.length - keepTail),
      output_truncated: true,
      output_original_chars: call.output.length,
    }
  })
}

function serializeDenials(records: HeadlessApprovalRecord[]): Array<{ toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] }> {
  return records
    .filter(r => !r.decision.allowed)
    .map(r => {
      const out: { toolName: string; reason: string; bashRiskLevel?: string; bashRiskReasons?: string[] } = {
        toolName: r.toolName,
        reason: r.decision.reason,
      }
      // Bash denials carry the structured classifier output so an operator
      // reading the JSON log can see WHY the bash command was rejected
      // (e.g. "git push --force") without having to re-classify.
      if ('bashRisk' in r.decision && r.decision.bashRisk) {
        out.bashRiskLevel = r.decision.bashRisk.level
        out.bashRiskReasons = r.decision.bashRisk.reasons
      }
      return out
    })
}

function resolveRuntimeResumeRetries(): number {
  const raw = process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRIES']
  if (!raw) return DEFAULT_RUNTIME_RESUME_RETRIES
  const value = raw.trim().toLowerCase()
  if (value === 'unlimited' || value === 'infinite' || value === 'inf') {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RUNTIME_RESUME_RETRIES
  return parsed
}

function runtimeResumeDelayMs(attempt: number): number {
  const raw = process.env['OWLCODA_HEADLESS_RUNTIME_RESUME_RETRY_DELAY_MS']
  const base = raw !== undefined && raw !== ''
    ? Number.parseInt(raw, 10)
    : DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS
  const safeBase = Number.isFinite(base) && base >= 0 ? base : DEFAULT_RUNTIME_RESUME_RETRY_DELAY_MS
  return Math.min(safeBase * Math.max(1, 2 ** (attempt - 1)), MAX_RUNTIME_RESUME_RETRY_DELAY_MS)
}

function headlessRuntimeAutoResumeSuppressedKind(kind: string): string | null {
  // Keep headless aligned with the interactive auto-retry policy: these are
  // expensive/stall-shaped failures, not cheap transport blips.
  if (kind === 'timeout') return kind
  if (kind === 'pre_first_token_stream_close') return kind
  if (kind === 'empty_provider_response') return kind
  return null
}

function formatRuntimeRetryLimit(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : 'unlimited'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
